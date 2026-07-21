import { ext } from "../common/browser.js";
import { canWriteSrs, isConnected, loadConfig, onConfigChanged, type Config, type ScanModifier } from "../common/config.js";
import { loadHostRules, resolveHostMode, type HostRule } from "../common/host-rules.js";
import { type KeybindAction, matchesKeybind } from "../common/keybind.js";
import { send } from "../common/messages.js";
import { grade, markKnown, save, type Outcome } from "./actions.js";
import { observeLazy, parse, setParsingPaused } from "./parser.js";
import { hideStatusBar, refreshStatusBar, setStatusOptions, showStatusBar, statusPaused } from "./status-bar.js";
import { startAsbplayer } from "./parsers/asbplayer.js";
import { startYouTubeCaptions } from "./parsers/youtube.js";
import { startDynamicReader } from "./parsers/dynamic-reader.js";
import { dismissPopup, scheduleHide, scheduleShow, scheduleTextLookup, setCanWrite, showNow } from "./popup.js";
import { logicalTextAt } from "./dom-text.js";
import { toast } from "./toast.js";
import { ensureFurigana } from "./word.js";
import { installClientReporter } from "../common/client-reporter.js";

// One frame can run this content script twice: the manifest injects it on
// <all_urls> and the background *also* registers/executes it for user-enabled
// hosts (and `web-ext` re-injects it on a dev reload). Each copy is its own
// module instance that builds its own popup/status-bar/toast host and its own
// document listeners, so a second one stacks an orphaned popup the first can
// never collapse — the "popup won't collapse" bug. Content scripts from the
// same extension share one isolated-world window per frame, so a flag on it
// lets a duplicate injection bail before wiring anything up.
declare global {
  interface Window {
    __shirabeContentBooted?: boolean;
  }
}

if (window.__shirabeContentBooted) {
  console.info("[Shirabe scanner] content script already active in this frame; skipping duplicate injection");
} else {
  window.__shirabeContentBooted = true;
  boot();
}

function boot(): void {
  installClientReporter("content");

  let scanModifier: ScanModifier = "none";
  let showFurigana = true;
  let hovered: HTMLElement | null = null; // the .sb-word under the pointer, popup or not
  let current: Config | null = null;
  let rules: HostRule[] = [];
  let mode: "auto" | "off" = "auto";
  let rule: HostRule | undefined;
  let parsed = false; // has this page been parsed? (don't re-offer the button after)
  let localDictionaryReady = false;
  const isTopFrame = window === window.top;

  function apply(config: Config): void {
    current = config;
    scanModifier = config.scanModifier;
    showFurigana = config.furiganaMode !== "off";
    document.documentElement.classList.toggle("sb-furigana-unknown", config.furiganaMode === "unknown");
    document.documentElement.classList.toggle("sb-furigana-hover", config.furiganaMode === "hover");
    document.documentElement.classList.toggle("sb-furigana-off", config.furiganaMode === "off");
    if (showFurigana) ensureFurigana();
    document.documentElement.dataset.sbStatePreset = config.statePreset;
    setStatusOptions({ includesLearning: config.iPlusOneIncludesLearning, frequencyMax: config.iPlusOneFrequencyMax });
    setCanWrite(canWriteSrs(config));

    const resolution = resolveHostMode(location.href, {
      disabledHosts: config.disabledHosts,
      rules,
    });
    mode = resolution.mode;
    rule = resolution.rule;
    document.documentElement.classList.toggle("sb-reader-off", mode === "off");

    if (mode === "off") {
      hovered = null;
      pendingPointer = null;
      dismissPopup();
      setParsingPaused(true);
      hideStatusBar();
    } else {
      setParsingPaused(statusPaused()); // a settings change must not undo the bar's Pause
      if (parsed && isTopFrame) showStatusBar(parsePage);
    }

    // asbplayer injects subtitle text into arbitrary video hosts (and iframes).
    // Always watch when connected — no-op until `.asbplayer-offscreen` appears.
    // Not exclusive: page scanning and custom adapters still run in the top frame.
    if ((localDictionaryReady || isConnected(config)) && mode !== "off") startAsbplayer(showFurigana);

    // Subframes only run the asbplayer watcher (above). Host-rule page parsing
    // stays top-frame so nested ads/widgets don't get UI.
    if (!isTopFrame) {
      return;
    }

    // Reader-on pages parse on load. Parsing is local, so there is nothing to
    // ask permission for — the hotkey and context menu re-parse rather than
    // enable. A rule may name a dedicated custom parser (YouTube captions,
    // Netflix, Mokuro, …) in place of the generic page parser.
    if (mode === "auto" && (localDictionaryReady || isConnected(config)) && !parsed) {
      if (rule?.custom) startCustomParser(rule.custom);
      else parsePage();
    }
  }

  function startCustomParser(custom: NonNullable<HostRule["custom"]>): void {
    setParsingPaused(false);
    parsed = true;
    if (custom === "youtube") startYouTubeCaptions(showFurigana);
    else startDynamicReader(custom, showFurigana);
  }

  // Resolve host rules first (they gate the mode), then apply config; re-apply on
  // every settings change so per-site reader on/off takes effect immediately.
  Promise.all([loadHostRules(), loadConfig()]).then(([loadedRules, config]) => {
    rules = loadedRules;
    apply(config);
  });
  sendDictionaryStatus();
  onConfigChanged(apply);

  async function sendDictionaryStatus(): Promise<void> {
    const res = await send({ type: "dictionaryStatus" });
    localDictionaryReady = res.ok && res.dictionary.installed;
    console.info("[Shirabe scanner] ready", {
      page: location.href,
      dictionaryInstalled: localDictionaryReady,
      response: res.ok ? undefined : res.error,
    });
    if (current) apply(current);
  }

  // ── Hover → popup, gated by the scan modifier ────────────────────────────────
  // "none" opens on plain hover; otherwise the chosen modifier must be held. We
  // read the modifier straight off the event (no need to track key state).
  const MODIFIER_KEY: Record<Exclude<ScanModifier, "none">, string> = {
    alt: "Alt",
    ctrl: "Control",
    shift: "Shift",
    meta: "Meta",
  };

  type Mods = { altKey: boolean; ctrlKey: boolean; shiftKey: boolean; metaKey: boolean };
  function wantPopup(e: Mods): boolean {
    switch (scanModifier) {
      case "none":
        return true;
      case "alt":
        return e.altKey;
      case "ctrl":
        return e.ctrlKey;
      case "shift":
        return e.shiftKey;
      case "meta":
        return e.metaKey;
    }
  }

  document.addEventListener("mouseover", (e) => {
    if (mode === "off") return;
    const word = (e.target as Element | null)?.closest?.(".sb-word");
    if (word instanceof HTMLElement) {
      hovered = word;
      if (wantPopup(e)) scheduleShow(word);
    }
  });
  document.addEventListener("mouseout", (e) => {
    // Popup show/hide lifetime is owned by popup.ts's hover guards; here we only
    // clear the keybind target when the pointer leaves a word.
    if ((e.target as Element | null)?.closest?.(".sb-word")) hovered = null;
  });

  // ── Local caret scanner ──────────────────────────────────────────────────────
  // This is the offline fast path: no page parse/wrapping and no network. Read a
  // short text window from the caret under the pointer; IndexedDB lookup decides
  // the longest/deinflected term. Existing parsed spans keep their richer state UI.
  let scanFrame = 0;
  let pendingPointer: MouseEvent | null = null;
  let lastPointer: MouseEvent | null = null;
  document.addEventListener("mousemove", (event) => {
    lastPointer = event;
    pendingPointer = event;
    if (scanFrame) return;
    scanFrame = requestAnimationFrame(() => {
      scanFrame = 0;
      const pointer = pendingPointer;
      pendingPointer = null;
      if (pointer) scanPointer(pointer);
    });
  });

  function scanPointer(event: MouseEvent, force = false): void {
    if (mode === "off" || !localDictionaryReady || (!force && !wantPopup(event))) return;
    const element = event.target as Element | null;
    if (element?.closest?.(".sb-word, .sb-host, input, textarea, select, [contenteditable='true']")) return;
    // Anything that isn't Japanese text should let an open scan card go — a
    // scan target is bare page text, not a `.sb-word`, so the popup's own
    // pointer-out guard never fires for it and nothing else would close it.
    const caret = caretAt(event.clientX, event.clientY);
    if (!caret || caret.node.nodeType !== Node.TEXT_NODE) {
      scheduleHide();
      return;
    }
    const logical = logicalTextAt(caret.node, caret.offset);
    const text = logical.text;
    if (!startsJapanese(text)) {
      scheduleHide();
      return;
    }
    const range = document.createRange();
    range.setStart(caret.node, caret.offset);
    range.setEnd(caret.node, Math.min(caret.offset + 1, caret.node.length));
    const rect = range.getBoundingClientRect();
    if (!rect.width && !rect.height) {
      scheduleHide();
      return;
    }
    const sentence = sentenceAround(logical.context, logical.contextOffset);
    scheduleTextLookup(text, rect, sentence.text, sentence.targetStart, { node: caret.node, offset: caret.offset });
  }

  document.addEventListener("pointerup", (event) => {
    if (event.pointerType === "touch") scanPointer(event, true);
  });

  function caretAt(x: number, y: number): { node: Text; offset: number } | null {
    const doc = document as Document & {
      caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
      caretRangeFromPoint?: (x: number, y: number) => Range | null;
    };
    const position = doc.caretPositionFromPoint?.(x, y);
    if (position?.offsetNode.nodeType === Node.TEXT_NODE) return { node: position.offsetNode as Text, offset: position.offset };
    const range = doc.caretRangeFromPoint?.(x, y);
    return range?.startContainer.nodeType === Node.TEXT_NODE ? { node: range.startContainer as Text, offset: range.startOffset } : null;
  }

  function startsJapanese(text: string): boolean {
    return /^[々〇〻\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(text);
  }

  function sentenceAround(text: string, offset: number): { text: string; targetStart: number } {
    const boundaries = /[。！？!?\n]/;
    let start = offset;
    let end = offset;
    while (start > 0 && !boundaries.test(text[start - 1])) start -= 1;
    while (end < text.length && !boundaries.test(text[end])) end += 1;
    const raw = text.slice(start, Math.min(text.length, end + 1));
    const leading = raw.length - raw.trimStart().length;
    return { text: raw.trim(), targetStart: Math.max(0, offset - start - leading) };
  }

  // Pressing the scan modifier while already hovering a word reveals it at once,
  // without moving the mouse. No-op in "none" mode.
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape") dismissPopup();
    if (mode !== "off" && scanModifier !== "none" && e.key === MODIFIER_KEY[scanModifier]) {
      if (!localDictionaryReady) console.warn("[Shirabe scanner] modifier pressed before the local dictionary is ready");
      if (hovered) showNow(hovered);
      else if (lastPointer) scanPointer(lastPointer, true);
    }
  });

  // ── Rebindable shortcuts ─────────────────────────────────────────────────────
  // `parse` acts on the page (or selection); the rest act on the hovered word. All
  // bindings live in config.keybinds and are user-editable in the popup.
  const WORD_ACTIONS: Record<Exclude<KeybindAction, "parse">, (word: HTMLElement) => Promise<Outcome>> = {
    again: (w) => grade(w, 1),
    hard: (w) => grade(w, 2),
    good: (w) => grade(w, 3),
    easy: (w) => grade(w, 4),
    save,
    known: markKnown,
  };
  const WORD_ACTION_KEYS = Object.keys(WORD_ACTIONS) as Array<Exclude<KeybindAction, "parse">>;

  window.addEventListener("keydown", (e) => {
    if (isTyping(e.target)) return;
    const keybinds = current?.keybinds;
    if (!keybinds) return;

    // Parse (page or selection) — page-level, no hover needed; not on off pages.
    if (mode !== "off" && matchesKeybind(e, keybinds.parse)) {
      e.preventDefault();
      initParse();
      return;
    }

    // Mining / review — only when the account can actually write to the SRS.
    if (!current || !canWriteSrs(current)) return;
    for (const action of WORD_ACTION_KEYS) {
      if (matchesKeybind(e, keybinds[action])) {
        if (!hovered) return;
        e.preventDefault();
        WORD_ACTIONS[action](hovered).then(({ ok, message }) => toast(message, ok));
        return;
      }
    }
  });

  function isTyping(target: EventTarget | null): boolean {
    const el = target as HTMLElement | null;
    return !!el && (el.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName));
  }

  // ── Parsing: on-demand from the menu/popup/hotkey, plus dynamic content ───────
  // Parse the selection when there is one, otherwise the whole page.
  function initParse(): void {
    const selection = window.getSelection()?.toString();
    if (selection && selection.trim()) parseSelection();
    else parsePage();
  }

  function parsePage(): void {
    setParsingPaused(false);
    parsed = true;
    const root = rule?.parse ? (document.querySelector(rule.parse) ?? document.body) : document.body;
    observeLazy(root, showFurigana, ruleOptions());
    observeMutations();
    showStatusBar(parsePage);
  }

  function ruleOptions() {
    return { filter: rule?.filter, collapseWhitespace: rule?.collapseWhitespace };
  }

  function parseSelection(): void {
    // The command is broadcast to every frame in the tab, and `getRangeAt(0)`
    // throws where there is no selection — which is all of them but one.
    const selection = window.getSelection();
    if (!selection?.rangeCount) return;
    const range = selection.getRangeAt(0);
    const node = range.commonAncestorContainer;
    const root = node?.nodeType === Node.ELEMENT_NODE ? (node as Element) : node?.parentElement;
    if (root) parse(root, showFurigana, ruleOptions()); // eager: a selection is parsed now
  }

  ext.runtime.onMessage.addListener((message: { command?: string }) => {
    // Broadcast reaches every frame; page parsing stays top-frame so nested ads
    // and widgets don't get decorated, matching the `apply()` guard.
    if (message.command === "parsePage") { if (isTopFrame) parsePage(); }
    else if (message.command === "parseSelection") parseSelection();
    else if (message.command === "lookupSelection") lookupSelection();
    else if (message.command === "dictionaryChanged") void sendDictionaryStatus();
  });

  function lookupSelection(): void {
    const selection = window.getSelection();
    const text = selection?.toString().trim();
    if (!selection || !text || !selection.rangeCount) return;
    scheduleTextLookup(text.slice(0, 24), selection.getRangeAt(0).getBoundingClientRect(), text, 0);
  }

  // Re-parse content the page adds later (SPA navigations, infinite scroll,
  // lazy-loaded sections). Debounced; only fresh subtrees are queued, and the
  // parser already skips anything we've wrapped, so our own writes don't loop.
  let observer: MutationObserver | null = null;
  const pending = new Set<Element>();
  let flushTimer: number | undefined;

  function observeMutations(): void {
    if (observer) return;
    observer = new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          const el = node.nodeType === Node.ELEMENT_NODE ? node as Element : node.parentElement;
          if (!el) continue;
          if (el.closest("[data-sb-parsed], .sb-word, .sb-host")) continue;
          pending.add(el);
        }
      }
      if (pending.size) scheduleFlush();
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  function scheduleFlush(): void {
    window.clearTimeout(flushTimer);
    flushTimer = window.setTimeout(() => {
      const candidates = [...pending].filter((el) => el.isConnected);
      const batch = candidates.filter((el) => !candidates.some((parent) => parent !== el && parent.contains(el)));
      pending.clear();
      for (const el of batch) {
        observeLazy(el, showFurigana, ruleOptions()); // lazy: parse fresh blocks as they're seen
      }
      refreshStatusBar();
    }, 350);
  }
}
