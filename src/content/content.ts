import { ext } from "../common/browser.js";
import { canWriteSrs, isConnected, loadConfig, onConfigChanged, type Config, type ScanModifier } from "../common/config.js";
import { loadHostRules, resolveHostMode, type HostRule } from "../common/host-rules.js";
import { type KeybindAction, matchesKeybind } from "../common/keybind.js";
import { grade, markKnown, save, type Outcome } from "./actions.js";
import { hideParseButton, showParseButton } from "./parse-button.js";
import { observeLazy, parse } from "./parser.js";
import { startYouTubeCaptions } from "./parsers/youtube.js";
import { scheduleShow, setCanWrite, showNow } from "./popup.js";
import { toast } from "./toast.js";

let scanModifier: ScanModifier = "none";
let showFurigana = true;
let hovered: HTMLElement | null = null; // the .sb-word under the pointer, popup or not
let current: Config | null = null;
let rules: HostRule[] = [];
let mode: "auto" | "manual" | "off" = "manual";
let rule: HostRule | undefined;
let parsed = false; // has this page been parsed? (don't re-offer the button after)

function apply(config: Config): void {
  current = config;
  scanModifier = config.scanModifier;
  showFurigana = config.showFurigana;
  setCanWrite(canWriteSrs(config));

  const resolution = resolveHostMode(location.href, {
    autoHosts: config.autoParseHosts,
    disabledHosts: config.disabledHosts,
    rules,
  });
  mode = resolution.mode;
  rule = resolution.rule;

  // Auto sites parse on load (once); manual sites offer the floating button;
  // off sites do nothing at all. A rule may name a dedicated custom parser
  // (e.g. YouTube captions) instead of the generic page parser.
  if (mode === "auto" && isConnected(config) && !parsed) {
    if (rule?.custom) startCustomParser(rule.custom);
    else parsePage();
  } else {
    refreshParseButton();
  }
}

function startCustomParser(custom: NonNullable<HostRule["custom"]>): void {
  parsed = true;
  hideParseButton();
  if (custom === "youtube") startYouTubeCaptions(showFurigana);
}

// The floating "Parse" button is the manual trigger: shown once we're connected,
// on manual-mode pages, and only until the page has been parsed. Hidden on auto
// and off pages, and when the user turns it off (showParseButton).
function refreshParseButton(): void {
  if (!current) return;
  const wanted = mode === "manual" && isConnected(current) && current.showParseButton && !parsed;
  if (wanted) showParseButton(parsePage);
  else hideParseButton();
}

// Resolve host rules first (they gate the mode), then apply config; re-apply on
// every settings change so per-site Auto/Off toggles take effect immediately.
Promise.all([loadHostRules(), loadConfig()]).then(([loadedRules, config]) => {
  rules = loadedRules;
  apply(config);
});
onConfigChanged(apply);

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

// Pressing the scan modifier while already hovering a word reveals it at once,
// without moving the mouse. No-op in "none" mode.
window.addEventListener("keydown", (e) => {
  if (scanModifier !== "none" && e.key === MODIFIER_KEY[scanModifier] && hovered) {
    showNow(hovered);
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

  // Mining / review — act on the word under the pointer.
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
  parsed = true;
  hideParseButton(); // it's done its job; the observers keep new content parsed
  const root = rule?.parse ? (document.querySelector(rule.parse) ?? document.body) : document.body;
  observeLazy(root, showFurigana, ruleOptions());
  observeMutations();
}

function ruleOptions() {
  return { filter: rule?.filter, collapseWhitespace: rule?.collapseWhitespace };
}

function parseSelection(): void {
  const range = window.getSelection()?.getRangeAt(0);
  const node = range?.commonAncestorContainer;
  const root = node?.nodeType === Node.ELEMENT_NODE ? (node as Element) : node?.parentElement;
  if (root) parse(root, showFurigana, ruleOptions()); // eager: a selection is parsed now
}

ext.runtime.onMessage.addListener((message: { command?: string }) => {
  if (message.command === "parsePage") parsePage();
  else if (message.command === "parseSelection") parseSelection();
});

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
        if (node.nodeType !== Node.ELEMENT_NODE) continue;
        const el = node as Element;
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
    const batch = [...pending];
    pending.clear();
    for (const el of batch) {
      if (el.isConnected) observeLazy(el, showFurigana, ruleOptions()); // lazy: parse fresh blocks as they're seen
    }
  }, 350);
}
