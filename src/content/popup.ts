import { send, type Rating } from "../common/messages.js";
import { loadConfig, pricingUrl } from "../common/config.js";
import { sendDictionary } from "../common/dictionary-port.js";
import type { Definition, Example, Sense, SentenceToken } from "../common/types.js";
import { applyStudyDetails, grade, GRADES, markKnown, REVIEW_IN_READER, save, setScanOrigin, studyUrlForWord, type Outcome } from "./actions.js";
import { refreshMetrics } from "./metrics-reporter.js";
import { rangeFromCaret } from "./dom-text.js";
import { placeCard } from "./placement.js";
import { appendFurigana, hasKanji } from "./word.js";
import { isR2AudioUrl } from "../common/audio.js";
import { toast } from "./toast.js";

// One reused popup, shown next to whichever word the pointer (or keyboard) is
// over. It lives in a shadow root so the host page's CSS can never reach in —
// definitions render the same on every site. Lookups are fetched lazily (and
// cached in the background worker).
let host: HTMLElement | null = null;
let root: ShadowRoot | null = null;
let box: HTMLElement | null = null; // outer dialog shell (visibility + max-height)
let content: HTMLElement | null = null; // replaced on each lookup; close lives outside it
let currentKey: string | null = null;
let currentTarget: PopupTarget | null = null; // what an open card is anchored to
let showTimer: number | undefined;
let hideTimer: number | undefined;
let token = 0; // guards against a slow lookup landing after we've moved on
let canWrite = false; // WRITE_SRS + entitled → render mining controls
let connected = false; // signed in at all — decides what the no-controls row offers
// The current popup's sense-picker checkboxes (empty unless the word has 2–8
// senses and the user can save). Read at save time to scope the card; ticking
// every box (the default) saves the whole word. `sensePickWord` is the element
// the checkboxes were built for, so a keyboard save against a *different* hovered
// word (nested lookup, scan span) doesn't misapply this popup's picks.
let sensePicks: HTMLInputElement[] = [];
let sensePickWord: HTMLElement | null = null;
const lookupHistory: PopupTarget[] = [];
let historyIndex = -1;
let navigatingHistory = false;
// Built once with the rest of the shell chrome, so they outlive content swaps
// and `refreshHistoryNav` is what keeps them in step with the history.
let historyBack: HTMLButtonElement | null = null;
let historyForward: HTMLButtonElement | null = null;
let currentDepth = 0;
let dictionaryInstallPromise: Promise<void> | null = null;

export function setWriteState(state: { canWrite: boolean; connected: boolean }): void {
  canWrite = state.canWrite;
  connected = state.connected;
}

// The ticked sense positions to save, or undefined for the whole word (no
// picker, or every sense left ticked). Only a genuine subset scopes the card.
function pickedPositions(): number[] | undefined {
  if (!sensePicks.length) return undefined;
  const ticked = sensePicks.filter((box) => box.checked).map((box) => Number(box.dataset.position));
  if (ticked.length === 0 || ticked.length === sensePicks.length) return undefined;
  return ticked;
}

// The picks for `word`, but only when it's the word this popup's picker was built
// for — so the keyboard "save" shortcut honours the checkboxes without ever
// applying them to a different hovered word. Whole word otherwise.
export function picksForWord(word: HTMLElement): number[] | undefined {
  return word === sensePickWord ? pickedPositions() : undefined;
}

function element(): HTMLElement {
  if (content) return content;
  host = document.createElement("div");
  host.className = "sb-host";
  root = host.attachShadow({ mode: "open" });
  const style = document.createElement("style");
  style.textContent = CSS;
  box = document.createElement("div");
  box.className = "sb-popup";
  box.setAttribute("role", "dialog");
  box.setAttribute("aria-label", "Shirabe dictionary");

  // Permanent chrome — one top-right row of back, forward, close. It survives
  // content swaps, so every state (loading, error, definition) keeps an explicit
  // close (not only hover-away / click-outside) and the history arrows never
  // move as the content under them changes.
  const chrome = document.createElement("div");
  chrome.className = "sb-chrome";

  historyBack = button("←", "sb-chrome-button", "", () => navigateHistory(-1));
  historyBack.title = "Previous lookup (Alt+←)";
  historyBack.setAttribute("aria-label", "Previous lookup");
  historyForward = button("→", "sb-chrome-button", "", () => navigateHistory(1));
  historyForward.title = "Next lookup (Alt+→)";
  historyForward.setAttribute("aria-label", "Next lookup");
  refreshHistoryNav();

  const close = document.createElement("button");
  close.type = "button";
  close.className = "sb-btn sb-chrome-button sb-close";
  close.textContent = "×";
  close.title = "Close";
  close.setAttribute("aria-label", "Close");
  close.addEventListener("click", (event) => {
    event.stopPropagation();
    dismiss();
  });
  chrome.append(historyBack, historyForward, close);

  content = document.createElement("div");
  content.className = "sb-popup-content";
  box.append(chrome, content);
  root.append(style, box);
  content.addEventListener("dblclick", (event) => {
    // Firefox exposes a selection inside an open shadow root on the root itself,
    // not on `window`, so reading only `window.getSelection()` makes
    // double-click-a-gloss silently do nothing there.
    const shadow = root as ShadowRoot & { getSelection?: () => Selection | null };
    const selection = (shadow.getSelection?.() ?? window.getSelection())?.toString().trim();
    const target = event.target as HTMLElement | null;
    if (selection && target) nestedLookup(selection, target.getBoundingClientRect(), currentDepth);
  });
  document.body.append(host);
  installHoverGuards();
  return content;
}

// The popup stays open while the pointer is over the *safe zone* — the hovered
// word OR the popup itself (across the shadow boundary) — and closes shortly
// after the pointer leaves both, or immediately on a click elsewhere. Tracking
// the whole zone (rather than the popup's own mouseenter/leave) means a popup
// that repositions when its content loads no longer vanishes under the pointer.
let guardsInstalled = false;
function installHoverGuards(): void {
  if (guardsInstalled) return;
  guardsInstalled = true;

  window.addEventListener("resize", scheduleReposition);
  // Capture phase so scrolling inside the page's own containers counts, and only
  // for captions — see `scheduleReposition`.
  window.addEventListener(
    "scroll",
    () => {
      if (currentTarget && captionRect(anchorElement(currentTarget))) scheduleReposition();
    },
    { passive: true, capture: true },
  );

  document.addEventListener("mouseover", (e) => {
    if (visible() && inSafeZone(e)) window.clearTimeout(hideTimer);
  });
  // The pointer leaving the document fires no further mousemove, so the scan
  // path never gets another chance to close the card.
  document.addEventListener("mouseleave", () => {
    if (visible()) scheduleHide();
  });
  document.addEventListener("mouseout", (e) => {
    // Only when actually crossing *out* of the safe zone (word/popup → elsewhere),
    // so moving around inside the popup or over other page content doesn't churn.
    if (visible() && inSafeZone(e) && !nodeInSafeZone(e.relatedTarget as Node | null)) scheduleHide();
  });
  // A click anywhere outside the popup (and not on a word) dismisses it now.
  document.addEventListener(
    "mousedown",
    (e) => {
      if (visible() && !inSafeZone(e)) dismiss();
    },
    true,
  );
}

const visible = (): boolean => !!box?.classList.contains("sb-visible");

// Is the event's pointer over the popup or a word? Uses composedPath so a hover
// inside the popup's shadow DOM counts.
function inSafeZone(e: Event): boolean {
  if (host && e.composedPath().includes(host)) return true;
  return !!(e.target as Element | null)?.closest?.(".sb-word");
}

// Same test for a bare node (a mouseout's relatedTarget), retargeted to the host
// when the pointer moves into the popup's shadow root.
function nodeInSafeZone(node: Node | null): boolean {
  if (!node) return false;
  if (host && (node === host || host.contains(node))) return true;
  const el = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
  return !!el?.closest?.(".sb-word");
}

export function scheduleShow(word: HTMLElement): void {
  window.clearTimeout(hideTimer);
  window.clearTimeout(showTimer);
  showTimer = window.setTimeout(() => showWord(word), 180);
}

// Show immediately (e.g. the modifier key was pressed while already hovering).
export function showNow(word: HTMLElement): void {
  window.clearTimeout(hideTimer);
  window.clearTimeout(showTimer);
  showWord(word);
}

// Yomitan-style lookup without rewriting the page first. The scanner gives us
// the text window beginning at the caret and the first character's rectangle;
// the local dictionary chooses the longest/deinflected match. A detached word
// element carries the same action data contract as parsed `.sb-word` spans.
export function scheduleTextLookup(query: string, rect: DOMRect, sentence: string, targetStart = 0, anchor?: ScanAnchor): void {
  window.clearTimeout(hideTimer);
  window.clearTimeout(showTimer);
  showTimer = window.setTimeout(() => {
    const word = document.createElement("span");
    word.dataset.surface = query;
    word.dataset.lemma = query;
    word.dataset.state = "none";
    word.dataset.sentence = sentence;
    word.dataset.targetStart = String(targetStart);
    setScanOrigin(word, anchor?.node.parentElement); // the detached span's link back to the page
    void showTarget({ key: `scan:${query}:${Math.round(rect.left)}:${Math.round(rect.top)}`, query, rect, word, depth: 0, anchor });
  }, 120);
}

export function scheduleHide(): void {
  window.clearTimeout(showTimer);
  hideTimer = window.setTimeout(hide, 250); // grace to cross the gap onto the popup
}

// A page-level highlight of the matched span for raw-text scans, via the CSS
// Custom Highlight API — it never touches the user's real text selection. Styled
// by `::highlight(sb-scan)` in content.css; a no-op where the API is unsupported.
const SCAN_HIGHLIGHT = "sb-scan";
function highlightScan(range: Range | null): void {
  const registry = (CSS as unknown as { highlights?: { set(name: string, value: unknown): void; delete(name: string): void } }).highlights;
  const HighlightCtor = (globalThis as unknown as { Highlight?: new (...ranges: Range[]) => unknown }).Highlight;
  if (!registry || !HighlightCtor) return;
  if (range) registry.set(SCAN_HIGHLIGHT, new HighlightCtor(range));
  else registry.delete(SCAN_HIGHLIGHT);
}

function hide(): void {
  box?.classList.remove("sb-visible");
  currentKey = null;
  currentTarget = null;
  // Retire the in-flight lookup too. Without this its `mine !== token` guard
  // still passes, and a lookup the user already dismissed goes on to register a
  // scan highlight — a highlighted span on the page with no card above it.
  token++;
  highlightScan(null);
}

// Re-anchor when the viewport changes under an open card. Ordinary page scrolling
// needs nothing — the host is positioned in document coordinates, so it travels
// with the word — but a subtitle overlay is `position: fixed`: the caption stays
// put while the page moves, leaving the card stranded. A resize invalidates every
// placement decision, caption or not. Coalesced onto one frame so a scroll burst
// costs a single measure.
let repositionFrame = 0;
function scheduleReposition(): void {
  if (repositionFrame || !visible() || !currentTarget) return;
  repositionFrame = requestAnimationFrame(() => {
    repositionFrame = 0;
    if (!visible() || !currentTarget) return;
    position(currentTarget);
  });
}

// The target's rect as it is *now*. The one captured at lookup time goes stale as
// soon as the page moves; a raw-text scan's word element is detached, so its own
// rect is empty and the scan anchor is what still knows where the match sits.
function liveRect(target: PopupTarget): DOMRect {
  if (target.word.isConnected) return target.word.getBoundingClientRect();
  if (target.anchor?.node.isConnected) {
    return rangeFromCaret(target.anchor.node, target.anchor.offset, 1).getBoundingClientRect();
  }
  return target.rect;
}

// Close now (a click outside): cancel any pending show/hide too.
function dismiss(): void {
  window.clearTimeout(showTimer);
  window.clearTimeout(hideTimer);
  hide();
}

export function dismissPopup(): void {
  dismiss();
}

function showWord(word: HTMLElement): void {
  const lemma = word.dataset.lemma ?? word.dataset.surface ?? "";
  void showTarget({ key: `word:${lemma}`, query: lemma, rect: word.getBoundingClientRect(), word, depth: 0 });
}

// Where a raw-text scan started, so we can highlight exactly the matched span on
// the page once the dictionary tells us how long the match is (Yomitan's
// `originalTextLength`). Absent for `.sb-word` hovers (already highlighted) and
// nested/selection lookups.
type ScanAnchor = { node: Text; offset: number };
type PopupTarget = { key: string; query: string; rect: DOMRect; word: HTMLElement; depth: number; kind?: "word" | "kanji"; anchor?: ScanAnchor };

async function showTarget(target: PopupTarget): Promise<void> {
  if (target.key === currentKey && box?.classList.contains("sb-visible")) return;
  currentKey = target.key;
  currentTarget = target;
  currentDepth = target.depth;
  if (!navigatingHistory) recordHistory(target);
  navigatingHistory = false;
  refreshHistoryNav();
  const mine = ++token;
  highlightScan(null); // drop any previous scan highlight until this match resolves

  const el = element();
  el.replaceChildren(loadingRow(target.query));
  position(target);
  // The visibility class belongs on the dialog shell, not the content wrapper
  // `element()` returns — `.sb-popup.sb-visible` is what the stylesheet, `hide`,
  // and `visible()` all key off.
  box?.classList.add("sb-visible");

  const res = await send({ type: "lookup", query: target.query, kind: target.kind ?? "word" });
  if (mine !== token) return; // user moved to another word meanwhile

  if (!res.ok) {
    el.replaceChildren(messageRow(res.error));
    return;
  }
  if (res.dictionaryInstalling) {
    el.replaceChildren(loadingRow(target.query), messageRow("Preparing the offline dictionary…"));
    position(target);
    void ensureDictionaryInstallation(target.key);
    void retryWhenDictionaryReady(target, mine);
    return;
  }
  if (res.definition) {
    target.word.dataset.lemma = res.definition.headword;
    target.word.dataset.surface = res.definition.sourceForm ?? target.query;
    if (res.definition.reading) target.word.dataset.reading = res.definition.reading;
    const matched = res.definition.sourceForm ?? target.query;
    const targetStart = Number(target.word.dataset.targetStart);
    if (Number.isInteger(targetStart) && targetStart >= 0) {
      target.word.dataset.targetEnd = String(targetStart + matched.length);
    }
    // Snap the on-page highlight to exactly the matched span (raw-text scans).
    if (target.anchor?.node.isConnected) highlightScan(rangeFromCaret(target.anchor.node, target.anchor.offset, matched.length));
    if (canWrite) {
      const states = await send({ type: "states", lemmas: [res.definition.headword] });
      if (mine !== token) return;
      if (states.ok) {
        const details = states.details[res.definition.headword];
        if (details) {
          applyStudyDetails(target.word, details);
          // One resolver for the destination, so a word with a card per meaning
          // can't get a deep link here and the card browser everywhere else.
          if (details.cardId != null) target.word.dataset.cardUrl = await studyUrlForWord(target.word);
        } else {
          target.word.dataset.state = states.states[res.definition.headword] ?? "none";
        }
      }
    }
  }
  el.replaceChildren(...definitionRows(res.definition, target.query, target.word));
  position(target);
}

function ensureDictionaryInstallation(key: string): Promise<void> {
  if (dictionaryInstallPromise) return dictionaryInstallPromise;
  dictionaryInstallPromise = sendDictionary({ type: "installDictionary" })
    .then((response) => {
      // The install is shared, but the card is not: by the time it fails the user
      // may be reading a definition that arrived from the API in the meantime.
      if (!response.ok && visible() && currentKey === key) element().replaceChildren(messageRow(response.error));
    })
    .finally(() => {
      dictionaryInstallPromise = null;
    });
  return dictionaryInstallPromise;
}

async function retryWhenDictionaryReady(target: PopupTarget, mine: number): Promise<void> {
  while (mine === token && visible() && currentKey === target.key) {
    await new Promise((resolve) => window.setTimeout(resolve, 1_000));
    if (mine !== token || !visible() || currentKey !== target.key) return;
    const response = await sendDictionary({ type: "dictionaryStatus" });
    if (mine !== token || currentKey !== target.key) return; // moved on while the status was in flight
    if (!response.ok) return;
    if (response.dictionary.error) {
      element().replaceChildren(messageRow(response.dictionary.error));
      return;
    }
    if (!response.dictionary.installed) {
      const progress = response.dictionary.progress > 0
        ? ` · ${Math.round(response.dictionary.progress * 100)}%`
        : "";
      const stage = response.dictionary.stage ?? "Preparing the offline dictionary";
      element().replaceChildren(loadingRow(target.query), messageRow(`${stage}${progress}`));
      position(target);
      continue;
    }
    currentKey = null;
    navigatingHistory = true;
    await showTarget(target);
    return;
  }
}

// Caption line/cue boxes to clear when a subtitle word is looked up — the popup
// must never cover the rest of the caption, only sit beside or clear of it.
const CAPTION_SELECTOR = [
  ".caption-window", ".ytp-caption-window-container", // YouTube
  ".player-timedtext-text-container", // Netflix
  ".asbplayer-subtitles", // asbplayer
].join(",");

function position(target: PopupTarget): void {
  if (!host || !box) return;
  const rect = liveRect(target);
  host.style.visibility = "hidden";
  host.style.left = "0px";
  host.style.top = "0px";
  box.style.maxHeight = ""; // measure the card's natural size, not last placement's cap
  // Parked at 0,0 the host's own rect tells us where its containing block starts
  // in viewport coordinates, so the offsets below need no assumption about what
  // that block is. Adding `scrollX/scrollY` instead only worked while `<body>`
  // was static and untransformed — a site with `body { position: relative }`
  // pushed the card off by the body's origin.
  const { width, height, left: originLeft, top: originTop } = host.getBoundingClientRect();

  const place = placeCard({
    rect,
    // What the card must clear. For a subtitle word that's the whole caption
    // line (so we don't bury the rest of the sentence being read); for an
    // ordinary page word it's just the word.
    avoid: captionRect(anchorElement(target)) ?? rect,
    size: { width, height },
    view: { width: document.documentElement.clientWidth, height: document.documentElement.clientHeight },
    vertical: isVerticalWriting(anchorElement(target)),
  });

  // The cap belongs on `.sb-popup` inside the shadow root — it owns the scrollable
  // body. Capping the host instead would leave the card overflowing it, uncapped.
  if (place.maxHeight != null) box.style.maxHeight = `${place.maxHeight}px`;
  host.style.left = `${place.left - originLeft}px`;
  host.style.top = `${place.top - originTop}px`;
  host.style.visibility = "";
}

// Whether the looked-up text is laid out vertically, which flips which side of
// the word is "in the flow". Read off the word itself — writing mode inherits
// from whatever container the page laid the text out in.
function isVerticalWriting(el: Element | null): boolean {
  return el ? /^(vertical|sideways)/.test(getComputedStyle(el).writingMode) : false;
}

// The connected element the target actually lives in. A raw-text scan's word
// element is detached — it never entered the page — so the scan anchor's text
// node is what still knows which container, and which writing mode, the match
// sits in. Without this every scan lookup on a vertical reader like ttsu would
// be measured against `document.body` and treated as horizontal.
function anchorElement(target: PopupTarget): Element | null {
  if (target.word.isConnected) return target.word;
  return target.anchor?.node.parentElement ?? null;
}

// The caption line's on-screen rect when `word` is a subtitle, else null. Prefers
// the cue container (full line width); falls back to the media caption context we
// tag with data-media-timestamp.
function captionRect(word?: Element | null): DOMRect | null {
  const caption = word?.closest(CAPTION_SELECTOR) ?? word?.closest("[data-media-timestamp]");
  return caption ? caption.getBoundingClientRect() : null;
}

function loadingRow(lemma: string): Node {
  const div = document.createElement("div");
  div.className = "sb-popup-head";
  div.textContent = lemma;
  return div;
}

function messageRow(text: string): Node {
  const div = document.createElement("div");
  div.className = "sb-popup-message";
  div.textContent = text;
  return div;
}

function definitionRows(def: Definition | null, lemma: string, word: HTMLElement): Node[] {
  sensePicks = []; // rebuilt by sensesList for this render
  sensePickWord = null;
  if (!def) {
    const body = document.createElement("div");
    body.className = "sb-body";
    body.append(messageRow(`No entry for 「${lemma}」`));
    const rows: Node[] = [body];
    if (canWrite) rows.push(actions(word));
    return rows;
  }

  // A scrollable body (pinned head + actions) mirroring the shirabe.org card.
  const body = document.createElement("div");
  body.className = "sb-body";
  if (def.inflection?.length) body.append(block("sb-inflection", `${def.sourceForm ?? lemma} → ${def.headword} · ${def.inflection.join(" · ")}`));
  const badges = badgeRow(def);
  if (badges) body.append(badges);
  if (def.pitch.length && def.reading) body.append(pitchRows(def.pitch, def.reading));
  // A picker only when the user can save and every sense is shown (2–8) — so
  // "all ticked" unambiguously means the whole word.
  const pickable = canWrite && def.senses.length > 1 && def.senses.length <= 8;
  if (pickable) sensePickWord = word;
  body.append(sensesList(def.senses, pickable, coveredSenses(word)));
  const kanji = kanjiStrip(def.headword, def.url);
  if (kanji) body.append(kanji);
  const examples = examplesBlock(def.examples);
  if (examples) body.append(examples);

  const rows: Node[] = [headRow(def), body];
  if (canWrite) rows.push(actions(word));
  else rows.push(studyUnavailable());
  return rows;
}

// Kanji chips open the site's kanji page — richer than the offline KANJIDIC
// slice, and the path we keep if the pack eventually drops kanji records.
function kanjiStrip(headword: string, wordUrl: string): HTMLElement | null {
  const characters = [...new Set([...headword].filter((character) => /\p{Script=Han}/u.test(character)))];
  if (!characters.length) return null;
  const siteBase = wordUrl.replace(/\/word\/[^/?#]*$/, "");
  const strip = document.createElement("div");
  strip.className = "sb-kanji-strip";
  strip.setAttribute("aria-label", "Kanji details");
  for (const character of characters) {
    const link = document.createElement("a");
    link.className = "sb-btn sb-kanji-button";
    link.href = `${siteBase}/kanji/${encodeURIComponent(character)}`;
    link.target = "_blank";
    link.rel = "noopener";
    link.textContent = character;
    link.title = `Open ${character} on Shirabe`;
    link.setAttribute("aria-label", `Open kanji ${character} on Shirabe`);
    strip.append(link);
  }
  return strip;
}

// What sits where the Save/Known controls would be. Signed in without Pro is
// the case worth getting right: the reader isn't missing a connection, they're
// missing the subscription, and telling them to "connect" an account they're
// already signed into is both wrong and a dead end. Say what's missing, link it.
// Exported for the test that renders it — it's the whole free-reader experience
// of this card, and asserting on the source text instead was never proof.
export function studyUnavailable(): HTMLElement {
  const row = document.createElement("div");
  row.className = "sb-study-unavailable";
  if (connected) {
    row.append("Saving to your reviews is part of Pro. ", plansLink());
  } else {
    row.textContent = "Offline lookup · Connect a Pro account to save and review";
  }
  return row;
}

// Headword (links to its shirabe.org page) + reading. Audio sits next to pitch;
// the shell owns the history arrows and close button in the top-right corner.
function headRow(def: Definition): Node {
  const head = document.createElement("div");
  head.className = "sb-popup-head";

  const link = document.createElement("a");
  link.className = "sb-headword";
  link.href = def.url;
  link.target = "_blank";
  link.rel = "noopener";

  // Furigana sits over the headword when it carries kanji — the reading then
  // reads in place, so the separate reading chip beside it would be redundant.
  // A kana-only headword keeps the plain text, and shows the reading chip only
  // when it actually adds something — for この the reading IS この, so drop it.
  if (def.reading && hasKanji(def.headword)) {
    // Furigana sits over each kanji run only; okurigana/kana render plain. The
    // headword is always the dictionary form, so its reading needs no inflection
    // adjustment (unlike a token surface) — pass it straight through.
    appendFurigana(link, def.headword, def.reading);
    head.append(link);
  } else {
    link.textContent = def.headword;
    head.append(link);
    if (def.reading && def.reading !== def.headword) {
      const reading = document.createElement("span");
      reading.className = "sb-popup-reading";
      reading.textContent = def.reading;
      head.append(reading);
    }
  }

  return head;
}

// The arrows sit in the shell's chrome row rather than in this row, so nothing
// rebuilds them — every move through the history re-checks which ends are live.
function refreshHistoryNav(): void {
  historyBack?.toggleAttribute("disabled", historyIndex <= 0);
  historyForward?.toggleAttribute("disabled", historyIndex >= lookupHistory.length - 1);
}

function recordHistory(target: PopupTarget): void {
  lookupHistory.splice(historyIndex + 1);
  lookupHistory.push(target);
  if (lookupHistory.length > 50) lookupHistory.shift();
  historyIndex = lookupHistory.length - 1;
}

function navigateHistory(delta: number): void {
  const next = historyIndex + delta;
  const target = lookupHistory[next];
  if (!target) return;
  historyIndex = next;
  navigatingHistory = true;
  currentKey = null;
  void showTarget({ ...target, key: `${target.key}:history:${next}` });
}

function nestedLookup(query: string, rect: DOMRect, depth: number, kind: "word" | "kanji" = "word"): void {
  const text = query.trim().slice(0, 24);
  if (!text) return;
  if (depth >= 5) {
    element().replaceChildren(messageRow("Nested lookup is limited to five levels."));
    return;
  }
  const word = document.createElement("span");
  word.dataset.lemma = text;
  word.dataset.surface = text;
  word.dataset.state = "none";
  void showTarget({ key: `nested:${kind}:${depth + 1}:${text}:${Date.now()}`, query: text, rect, word, depth: depth + 1, kind });
}

window.addEventListener("keydown", (event) => {
  if (event.key === "Escape") dismiss();
  else if (event.altKey && event.key === "ArrowLeft") navigateHistory(-1);
  else if (event.altKey && event.key === "ArrowRight") navigateHistory(1);
  else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    const body = box?.querySelector<HTMLElement>(".sb-body");
    if (body && box?.classList.contains("sb-visible")) {
      event.preventDefault();
      body.scrollBy({ top: event.key === "ArrowDown" ? 80 : -80, behavior: "smooth" });
    }
  }
});

// Common / JLPT / frequency badges, as on the web card. Null when none apply.
function badgeRow(def: Definition): Node | null {
  const items: Array<{ text: string; cls: string }> = [];
  if (def.common) items.push({ text: "Common", cls: "sb-badge-common" });
  if (def.jlpt) items.push({ text: def.jlpt, cls: "sb-badge-jlpt" });
  if (def.frequency != null) items.push({ text: `#${def.frequency}`, cls: "sb-badge-freq" });
  if (!items.length) return null;

  const row = document.createElement("div");
  row.className = "sb-badges";
  for (const b of items) row.append(chip(`sb-badge ${b.cls}`, b.text));
  return row;
}

// Patterns sit in a row that wraps, like the site's — two short accents fit on
// one line, where a stack spent a graph's height on each. Past this many, the
// rest wait behind a "+N": a word with four accents is rare enough that it must
// not cost every other word the senses being pushed out of the card.
const VISIBLE_PITCH_PATTERNS = 2;

function pitchRows(pitch: Definition["pitch"], reading: string): Node {
  const wrap = document.createElement("div");
  wrap.className = "sb-pitch";
  const patterns = pitch.map((entry) => pitchPattern(entry, reading));
  const rest = patterns.slice(VISIBLE_PITCH_PATTERNS);
  wrap.append(...patterns.slice(0, VISIBLE_PITCH_PATTERNS));
  if (rest.length) {
    const more = button(`+${rest.length}`, "sb-pitch-more", "", () => {
      more.replaceWith(...rest);
    });
    more.title = `Show ${rest.length} more accent pattern${rest.length > 1 ? "s" : ""}`;
    more.setAttribute("aria-label", more.title);
    wrap.append(more);
  }
  return wrap;
}

// One NHK-style graph + [downstep], with its own play button: each clip speaks
// that exact accent, so a word read two ways (箸 / 橋) lets you hear both rather
// than whichever pattern happened to come first.
function pitchPattern(entry: Definition["pitch"][number], reading: string): HTMLElement {
  const item = document.createElement("div");
  item.className = "sb-pitch-item";
  if (isR2AudioUrl(entry.audioUrl)) {
    const url = entry.audioUrl;
    const audio = button("🔊", "sb-audio", "", () => void playAudio(url));
    audio.title = "Play pronunciation";
    audio.setAttribute("aria-label", "Play pronunciation");
    item.append(audio);
  }
  item.append(pitchGraph(reading, entry.downstep), chip("sb-pitch-num", `[${entry.downstep}]`));
  return item;
}

// The mora overline diagram (heiban L H H…; atamadaka H L L…; else H to the
// downstep). Mirrors app/views/components/dictionary/_pitch_accent.html.erb.
const SMALL_KANA = "ゃゅょャュョぁぃぅぇぉァィゥェォ";
const SVG_NS = "http://www.w3.org/2000/svg";
function pitchGraph(reading: string, downstep: number): SVGSVGElement {
  const morae: string[] = [];
  for (const c of reading) {
    if (SMALL_KANA.includes(c) && morae.length) morae[morae.length - 1] += c;
    else morae.push(c);
  }
  const n = morae.length;
  const high = (i: number) => (downstep === 0 ? i > 0 : downstep === 1 ? i === 0 : i > 0 && i < downstep);
  // A column per mora, widened for the multi-character ones — きゃ and しょ collide
  // under a fixed step. Same rule as the site's component.
  const centers: number[] = [];
  let edge = 8;
  for (const mora of morae) {
    const step = Math.max(22, mora.length * 12);
    centers.push(edge + step / 2);
    edge += step;
  }
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", `0 0 ${edge + 8} 46`);
  svg.setAttribute("class", "sb-pitch-svg");
  const x = (i: number) => centers[i];
  const y = (i: number) => (high(i) ? 10 : 30);
  for (let i = 0; i < n; i++) {
    if (i < n - 1) {
      const line = document.createElementNS(SVG_NS, "line");
      line.setAttribute("x1", `${x(i)}`);
      line.setAttribute("y1", `${y(i)}`);
      line.setAttribute("x2", `${x(i + 1)}`);
      line.setAttribute("y2", `${y(i + 1)}`);
      svg.append(line);
    }
    const dot = document.createElementNS(SVG_NS, "circle");
    dot.setAttribute("cx", `${x(i)}`);
    dot.setAttribute("cy", `${y(i)}`);
    dot.setAttribute("r", "3");
    const label = document.createElementNS(SVG_NS, "text");
    label.setAttribute("x", `${x(i)}`);
    label.setAttribute("y", "44");
    label.setAttribute("text-anchor", "middle");
    label.setAttribute("class", "sb-pitch-mora");
    label.textContent = morae[i];
    svg.append(dot, label);
  }
  return svg;
}

// Numbered senses: source label (lang · dict), POS chips, misc/field/dialect
// tags, then glosses — the same anatomy as a web meaning.
// Which meanings this word already has a card for — "all" when a whole-word card
// covers every one of them. Stamped by applyStudyDetails from the word's state.
function coveredSenses(word: HTMLElement): Set<number> | "all" {
  const raw = word.dataset.savedSenses;
  if (raw === "all") return "all";
  return new Set((raw ?? "").split(",").filter(Boolean).map(Number));
}

function sensesList(senses: Sense[], pickable = false, covered: Set<number> | "all" = new Set()): Node {
  const list = document.createElement("ol");
  list.className = pickable ? "sb-senses sb-senses-pick" : "sb-senses";
  for (const sense of senses.slice(0, 8)) {
    const li = document.createElement("li");
    // With a picker, the checkbox is the row's first flex child and the sense
    // body is wrapped so it stays one column; without it, content sits directly
    // on the <li> (the numbered list marker).
    const body = pickable ? document.createElement("div") : li;
    // A meaning you already have a card for is not on offer: saving it again
    // would land on the card that exists, so the row says so instead of inviting
    // a second click. `pickedPositions` reads only the boxes that are left, so an
    // all-covered word simply has no picker to disagree with.
    const saved = covered === "all" || covered.has(sense.position);
    if (saved) li.classList.add("sb-sense-saved");
    if (pickable && !saved) {
      const box = document.createElement("input");
      box.type = "checkbox";
      box.checked = true;
      box.className = "sb-sense-pick";
      box.dataset.position = String(sense.position);
      // Reference the gloss, not a sense number — the picker hides the list's
      // ordinals, so a number here would have no visible counterpart.
      box.setAttribute("aria-label", `Include "${sense.glosses.join("; ")}" when saving`);
      sensePicks.push(box);
      li.append(box);
    } else if (pickable) {
      li.append(chip("sb-sense-saved-mark", "Saved"));
    }
    if (sense.source) body.append(block("sb-source", sense.source));
    if (sense.partsOfSpeech.length) body.append(block("sb-pos", sense.partsOfSpeech.join(", ")));
    if (sense.tags.length) {
      const tags = document.createElement("i");
      tags.className = "sb-tags";
      tags.textContent = `${sense.tags.join(", ")} `;
      body.append(tags);
    }
    body.append(sense.glosses.join("; "));
    if (pickable) li.append(body);
    list.append(li);
  }
  return list;
}

// A couple of example sentences with translations (from include=sentences).
function examplesBlock(examples: Example[]): Node | null {
  if (!examples.length) return null;
  const wrap = document.createElement("div");
  wrap.className = "sb-examples";
  for (const ex of examples) {
    const fig = document.createElement("div");
    fig.className = "sb-example";
    const jp = document.createElement("div");
    jp.className = "sb-example-jp";
    jp.lang = "ja";
    // Render the sentence as clickable word tokens (searched word highlighted);
    // fall back to plain text if the server didn't tokenize it.
    if (ex.tokens.length) {
      for (const tok of ex.tokens) jp.append(sentenceToken(tok));
    } else {
      jp.textContent = ex.japanese;
    }
    fig.append(jp);
    if (ex.translation) fig.append(block("sb-example-tr", ex.translation));
    wrap.append(fig);
  }
  return wrap;
}

// One example-sentence token: a content word links to its shirabe.org page (new
// tab), the searched word is highlighted, and particles stay plain text.
function sentenceToken(tok: SentenceToken): Node {
  if (!tok.url) return document.createTextNode(tok.surface);
  const link = document.createElement("a");
  link.className = tok.matched ? "sb-tok sb-tok-match" : "sb-tok";
  link.href = tok.url;
  link.target = "_blank";
  link.rel = "noopener";
  link.textContent = tok.surface;
  return link;
}

// The clip is fetched by the background worker and returned as a data: URL:
// a content-script `new Audio(cdnUrl)` is a cross-origin media load governed
// by the *page's* CSP, which strict sites (Wikipedia) block. data: is allowed
// under those same policies, so playing the returned URL works everywhere.
async function playAudio(url: string): Promise<void> {
  const res = await send({ type: "audioClip", url });
  if (!res.ok) {
    // A 404 means this word has no processed clip yet (or the installed pack is
    // stale); anything else is a real fetch failure. Surface it instead of
    // failing silently, so a dead speaker button always explains itself.
    const missing = res.status === 404 || res.status === 403;
    toast(missing ? "No pronunciation audio for this word yet." : "Couldn't load pronunciation audio.", false);
    return;
  }
  try {
    await new Audio(res.dataUrl).play();
  } catch {
    toast("Couldn't play pronunciation audio.", false);
  }
}

// Mining controls, gated by whether the word is already a card. An untracked word
// (state "none") offers Save + Known; a saved one offers Manage, the same control
// the site's dictionary results carry. Reviewing is not here — see
// REVIEW_IN_READER. Each action recolours every occurrence and surfaces any error
// (e.g. the Pro card cap) inline rather than pretend.
function actions(word: HTMLElement): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "sb-actions";
  renderActions(word, wrap);
  return wrap;
}

function renderActions(word: HTMLElement, wrap: HTMLElement): void {
  wrap.replaceChildren();
  const saved = (word.dataset.state ?? "none") !== "none";

  if (saved && word.dataset.deckNames) {
    const membership = document.createElement("div");
    membership.className = "sb-membership";
    membership.textContent = `Saved in ${word.dataset.deckNames}`;
    wrap.append(membership);
  }

  if (REVIEW_IN_READER && word.dataset.state === "due") {
    const grades = document.createElement("div");
    grades.className = "sb-grades";
    const intervals = intervalPreviews(word);
    for (const r of [1, 2, 3, 4] as Rating[]) {
      const key = (["again", "hard", "good", "easy"] as const)[r - 1];
      grades.append(button(`${GRADES[r]}${intervals?.[key] ? ` ${intervals[key]}` : ""}`, `sb-grade sb-g${r}`, `${r}`, () => run(word, wrap, () => grade(word, r))));
    }
    wrap.append(grades);
  }

  const extra = document.createElement("div");
  extra.className = "sb-extra";
  // Open card sits beside Known once the word is saved (exact card when we
  // know cardId, otherwise the card browser search for the lemma).
  if (saved) extra.append(cardLink(word));
  if (!saved) extra.append(button("＋ Save", "sb-btn-save", "S", () => run(word, wrap, () => save(word, pickedPositions()))));
  extra.append(button("✓ Known", "sb-btn-known", "K", () => run(word, wrap, () => markKnown(word))));
  wrap.append(extra);

  const note = document.createElement("span");
  note.className = "sb-feedback";
  wrap.append(note);
}

function intervalPreviews(word: HTMLElement): { again: string; hard: string; good: string; easy: string } | null {
  try {
    return word.dataset.intervals ? JSON.parse(word.dataset.intervals) : null;
  } catch {
    return null;
  }
}

function cardLink(word: HTMLElement): HTMLAnchorElement {
  const link = document.createElement("a");
  // Same row / weight as Known — solid accent (site primary). "Manage" rather
  // than "Open card" to match the site's dictionary result: one door to the card,
  // its deck, and dropping it, instead of a menu rebuilt inside a hover popup.
  link.className = "sb-btn sb-btn-open";
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.textContent = "Manage";
  // Synchronous placeholder so the control is always clickable immediately;
  // then upgrade to the real host (and card_id when known).
  link.href = word.dataset.cardUrl || "#";
  void studyUrlForWord(word).then((url) => {
    word.dataset.cardUrl = url;
    link.href = url;
  });
  // If we only know the lemma so far, try to resolve a cardId from the server
  // so the next open lands on the inspector with mined context.
  if (!word.dataset.cardId && word.dataset.lemma) {
    void send({ type: "states", lemmas: [word.dataset.lemma] }).then(async (res) => {
      if (!res.ok) return;
      const details = res.details[word.dataset.lemma!];
      if (!details?.cardId) return;
      applyStudyDetails(word, details);
      // Through studyUrlForWord, not cardUrlFor: the details just told us how
      // many cards this word has, and a multi-card word wants the browser.
      link.href = await studyUrlForWord(word);
    });
  }
  return link;
}

async function run(word: HTMLElement, wrap: HTMLElement, action: () => Promise<Outcome>): Promise<void> {
  if (wrap.dataset.running === "true") return;
  wrap.dataset.running = "true";
  for (const control of wrap.querySelectorAll<HTMLButtonElement>("button")) control.disabled = true;
  // A rejection here (the extension context going away mid-click, a failed config
  // read) would otherwise leave `running` set and every button disabled, with no
  // message and no way back short of reopening the card.
  let outcome: Outcome;
  try {
    outcome = await action();
  } catch (error) {
    delete wrap.dataset.running;
    for (const control of wrap.querySelectorAll<HTMLButtonElement>("button")) control.disabled = false;
    const note = wrap.querySelector<HTMLElement>(".sb-feedback");
    if (note) {
      note.textContent = error instanceof Error ? error.message : "That did not go through. Try again.";
      note.classList.add("sb-error");
    }
    return;
  }
  const { ok, message, cardUrl, proRequired } = outcome;
  if (cardUrl) word.dataset.cardUrl = cardUrl;
  delete wrap.dataset.running;
  if (ok) renderActions(word, wrap); // state changed → re-render (Save → grade row + link)
  else for (const control of wrap.querySelectorAll<HTMLButtonElement>("button")) control.disabled = false;
  if (ok) refreshMetrics();
  const note = wrap.querySelector<HTMLElement>(".sb-feedback");
  if (note) {
    note.textContent = message;
    // "Needs Pro" isn't a red failure — it's the one refusal with somewhere to
    // go, so it reads as an offer and carries the link rather than a dead end.
    note.classList.toggle("sb-error", !ok && !proRequired);
    note.classList.toggle("sb-upgrade", !!proRequired);
    if (proRequired) note.append(" ", plansLink());
  }
}

// Opens shirabe.org/pricing in a new tab. `source=extension` so the funnel can
// tell a hovering reader apart from someone who walked in the front door.
function plansLink(): HTMLAnchorElement {
  const link = document.createElement("a");
  link.className = "sb-plans";
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.textContent = "See plans";
  link.href = "#";
  void loadConfig().then((config) => {
    link.href = pricingUrl(config.apiBase, "extension");
  });
  return link;
}

// Small DOM helpers.
function block(className: string, text: string): HTMLElement {
  const el = document.createElement("div");
  el.className = className;
  el.textContent = text;
  return el;
}

function chip(className: string, text: string): HTMLElement {
  const el = document.createElement("span");
  el.className = className;
  el.textContent = text;
  return el;
}

function button(label: string, className: string, hint: string, onClick: () => void): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.className = `sb-btn ${className}`;
  const text = document.createElement("span");
  text.textContent = label;
  btn.append(text);
  if (hint) {
    btn.title = `Shortcut: ${hint}`;
    const kbd = document.createElement("kbd");
    kbd.textContent = hint;
    btn.append(kbd);
  }
  btn.addEventListener("click", onClick);
  return btn;
}

const CSS = `
:host { all: initial; }
:host {
  position: absolute;
  top: 0;
  left: 0;
  z-index: 2147483647;
  display: block;
  /* Isolated from the host page: follow the OS theme so the lookup card is
     readable on dark-mode machines even when the site under the cursor is light. */
  color-scheme: light dark;
  --sb-surface: light-dark(#ffffff, #1a1a1e);
  --sb-surface-muted: light-dark(#f3f4f6, oklch(25% 0.016 285.7));
  --sb-surface-hover: light-dark(#e5e7eb, oklch(30% 0.016 285.7));
  --sb-ink: light-dark(#111827, #e8e6e3);
  --sb-ink-body: light-dark(#1f2937, #e8e6e3);
  --sb-ink-muted: light-dark(#4b5563, oklch(74% 0.007 80));
  --sb-ink-subtle: light-dark(#6b7280, oklch(62% 0.009 80));
  --sb-ink-faint: light-dark(#9ca3af, oklch(58% 0.009 80));
  --sb-outline: light-dark(#e5e7eb, oklch(92% 0.02 285.7 / 0.14));
  --sb-outline-strong: light-dark(#d1d5db, oklch(92% 0.02 285.7 / 0.22));
  --sb-divider: light-dark(#f3f4f6, oklch(92% 0.02 285.7 / 0.1));
  /* Site primary (sky) — pitch, readings, Save, Open card, links. Same tokens
     as shirabe.org --primary so the popup never reads purple. */
  --sb-accent: light-dark(#0369a1, oklch(72% 0.15 245));
  --sb-accent-hover: light-dark(#025a83, oklch(80% 0.13 245));
  --sb-accent-tint: light-dark(#e2f1fa, oklch(26% 0.08 245));
  --sb-accent-tint-strong: light-dark(#cfe7f6, oklch(32% 0.1 245));
  --sb-accent-border: light-dark(#7eb8d9, oklch(60% 0.1 245));
  --sb-source: light-dark(#0369a1, oklch(72% 0.15 245));
  --sb-common-bg: light-dark(#dcfce7, oklch(26% 0.09 155));
  --sb-common-fg: light-dark(#166534, oklch(83% 0.19 155));
  --sb-jlpt-bg: light-dark(#e2f1fa, oklch(26% 0.08 245));
  --sb-jlpt-fg: light-dark(#025a83, oklch(78% 0.13 245));
  --sb-error: light-dark(#b91c1c, oklch(75% 0.17 25));
  --sb-shadow: 0 10px 30px light-dark(rgba(15, 23, 42, 0.18), rgba(0, 0, 0, 0.55));
  --sb-on-solid: #ffffff;
  --sb-known-btn: light-dark(#6b7280, oklch(45% 0.02 260));
  --sb-known-btn-hover: light-dark(#4b5563, oklch(52% 0.02 260));
}
.sb-popup {
  /* Width of the top-right chrome row (3 × 24px + 2 × 2px gap), so the first row
     of any content state clears back, forward, and close in one number. */
  --sb-chrome-gutter: 76px;
  position: relative;
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  width: min(360px, calc(100vw - 24px));
  max-height: min(60vh, 460px);
  padding: 12px 14px;
  background: var(--sb-surface);
  color: var(--sb-ink-body);
  border: 1px solid var(--sb-outline);
  border-radius: 12px;
  box-shadow: var(--sb-shadow);
  font-family: system-ui, -apple-system, "Hiragino Kaku Gothic ProN", "Noto Sans JP", sans-serif;
  font-size: 14px;
  line-height: 1.5;
  opacity: 0;
  visibility: hidden;
  transform: translateY(4px);
  transition: opacity 0.12s ease, transform 0.12s ease;
}
.sb-popup.sb-visible { opacity: 1; visibility: visible; transform: translateY(0); }

/* Content column fills the shell; head/actions pin, body scrolls. */
.sb-popup-content {
  display: flex;
  flex-direction: column;
  min-height: 0;
  flex: 1 1 auto;
}

/* Back, forward, close — one row in the top-right, outside content swaps. Its
   width is the gutter every first content row keeps clear. */
.sb-chrome {
  position: absolute;
  top: 6px;
  right: 6px;
  z-index: 1;
  display: flex;
  align-items: center;
  gap: 2px;
}
.sb-btn.sb-chrome-button {
  width: 24px;
  height: 24px;
  padding: 0;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: var(--sb-ink-muted);
  font: 600 14px/1 system-ui, sans-serif;
}
.sb-btn.sb-chrome-button:hover:not(:disabled) { background: var(--sb-surface-muted); color: var(--sb-ink); }
.sb-btn.sb-chrome-button:disabled { cursor: default; opacity: .35; }
.sb-btn.sb-close { font-size: 18px; }

/* Head + actions stay pinned; the body (badges, pitch, senses, examples)
   scrolls (Yomitan-style) so the reading is always visible. min-height:0 lets
   the flex child shrink below its content height. */
.sb-popup-head {
  flex: 0 0 auto;
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding-right: var(--sb-chrome-gutter);
  font-size: 20px;
  font-weight: 700;
}
.sb-headword { color: var(--sb-ink); text-decoration: none; cursor: pointer; }
.sb-headword:hover { color: var(--sb-accent); text-decoration: underline; }
.sb-headword ruby { ruby-align: center; }
.sb-headword ruby rt { font-size: 0.5em; font-weight: 600; color: var(--sb-accent); user-select: none; }
.sb-popup-reading { font-size: 14px; font-weight: 500; color: var(--sb-accent); }
.sb-popup-message { color: var(--sb-ink-subtle); padding-right: var(--sb-chrome-gutter); }
.sb-inflection { margin-bottom: 7px; color: var(--sb-ink-subtle); font-size: 12px; }
.sb-study-unavailable { flex: 0 0 auto; margin-top: 10px; padding-top: 8px; border-top: 1px solid var(--sb-outline); color: var(--sb-ink-subtle); font-size: 11px; }
.sb-study-unavailable .sb-plans { font-size: 11px; }

.sb-body { flex: 0 1 auto; min-height: 0; overflow-y: auto; margin-top: 8px; }

.sb-btn.sb-audio {
  flex: 0 0 auto;
  align-self: center;
  color: inherit;
  background: transparent;
  padding: 4px 6px;
  border-radius: 8px;
  font-size: 15px;
  line-height: 1;
}
.sb-btn.sb-audio:hover { background: var(--sb-surface-muted); }

.sb-badges { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 8px; }
.sb-badge {
  font-size: 11px; font-weight: 600; padding: 2px 7px; border-radius: 999px;
  letter-spacing: 0.02em;
}
.sb-badge-common { background: var(--sb-common-bg); color: var(--sb-common-fg); }
.sb-badge-jlpt { background: var(--sb-jlpt-bg); color: var(--sb-jlpt-fg); }
.sb-badge-freq { background: var(--sb-surface-muted); color: var(--sb-ink-muted); font-variant-numeric: tabular-nums; }

.sb-pitch { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 10px; margin-bottom: 8px; }
.sb-pitch-item { display: flex; align-items: center; gap: 6px; min-width: 0; }
.sb-btn.sb-pitch-more {
  padding: 2px 7px;
  border-radius: 999px;
  background: var(--sb-surface-muted);
  color: var(--sb-ink-muted);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}
.sb-btn.sb-pitch-more:hover { background: var(--sb-surface-hover); color: var(--sb-ink); }
.sb-pitch-svg { height: 46px; }
.sb-pitch-svg line { stroke: var(--sb-accent); stroke-width: 2; }
.sb-pitch-svg circle { fill: var(--sb-accent); }
.sb-pitch-mora { fill: var(--sb-ink-subtle); font-size: 11px; font-family: inherit; }
.sb-pitch-num { font-size: 12px; font-weight: 600; color: var(--sb-ink-faint); font-variant-numeric: tabular-nums; }
.sb-kanji-strip { display: flex; gap: 5px; margin: 8px 0; }
.sb-btn.sb-kanji-button {
  cursor: pointer; min-width: 30px; border: 1px solid var(--sb-outline-strong); border-radius: 7px;
  padding: 4px 7px; background: var(--sb-surface); color: var(--sb-accent); font-size: 17px;
  text-decoration: none;
}
.sb-btn.sb-kanji-button:hover { background: var(--sb-accent-tint); border-color: var(--sb-accent-border); }

.sb-senses { margin: 0; padding-left: 18px; }
.sb-senses li { margin: 4px 0; }
/* Sense picker: drop the list marker, lay checkbox + sense body side by side. */
.sb-senses-pick { padding-left: 2px; list-style: none; }
.sb-senses-pick li { display: flex; align-items: flex-start; gap: 7px; }
.sb-sense-pick { margin: 3px 0 0; flex: none; cursor: pointer; accent-color: var(--sb-accent); }
.sb-senses-pick li > div { min-width: 0; }
/* A meaning already saved: still readable, visibly not on offer. The chip sits
   where its checkbox would, so the rows stay in one column. */
.sb-sense-saved { color: var(--sb-ink-subtle); }
.sb-sense-saved-mark {
  flex: none;
  margin-top: 1px;
  border-radius: 999px;
  padding: 1px 6px;
  background: var(--sb-surface-muted);
  color: var(--sb-ink-muted);
  font-size: 10px;
  font-weight: 600;
}
.sb-source { font-size: 11px; font-weight: 600; color: var(--sb-source); }
.sb-pos {
  display: block; font-size: 11px; font-weight: 600; color: var(--sb-ink-subtle);
}
.sb-tags { color: var(--sb-ink-faint); }

.sb-examples { margin-top: 10px; padding-top: 8px; border-top: 1px solid var(--sb-divider); }
.sb-example { margin: 6px 0; }
.sb-example-jp { color: var(--sb-ink); }
.sb-example-tr { font-size: 13px; color: var(--sb-ink-subtle); }
/* Clickable sentence tokens: subtle until hovered; the searched word tinted. */
.sb-tok {
  color: inherit; text-decoration: none; cursor: pointer;
  border-radius: 3px; text-underline-offset: 2px;
}
.sb-tok:hover { text-decoration: underline; background: var(--sb-surface-muted); }
.sb-tok-match { color: var(--sb-accent); background: var(--sb-accent-tint); }
.sb-tok-match:hover { background: var(--sb-accent-tint-strong); }

.sb-actions { flex: 0 0 auto; margin-top: 12px; }
.sb-membership { margin-bottom: 6px; color: var(--sb-ink-muted); font-size: 11px; }
.sb-grades { display: grid; grid-template-columns: repeat(4, 1fr); gap: 6px; }
.sb-extra { display: flex; gap: 6px; margin-top: 6px; }
.sb-extra .sb-btn { flex: 1; }

.sb-btn {
  display: inline-flex; align-items: center; justify-content: center; gap: 6px;
  font: 600 13px/1 system-ui, sans-serif;
  padding: 7px 8px; border-radius: 8px; border: 1px solid transparent; cursor: pointer;
  color: var(--sb-on-solid);
}
.sb-btn:disabled { cursor: wait; opacity: 0.55; }
.sb-btn kbd {
  font: 600 10px/1 ui-monospace, monospace;
  padding: 2px 4px; border-radius: 4px;
  background: rgba(255, 255, 255, 0.25);
}
.sb-g1 { background: #ef4444; } .sb-g1:hover { background: #dc2626; }
.sb-g2 { background: #f59e0b; } .sb-g2:hover { background: #d97706; }
.sb-g3 { background: #22c55e; } .sb-g3:hover { background: #16a34a; }
.sb-g4 { background: #3b82f6; } .sb-g4:hover { background: #2563eb; }
.sb-btn-save { background: var(--sb-accent); } .sb-btn-save:hover { background: var(--sb-accent-hover); }
.sb-btn-known { background: var(--sb-known-btn); } .sb-btn-known:hover { background: var(--sb-known-btn-hover); }
.sb-btn-known kbd, .sb-btn-save kbd { background: rgba(255, 255, 255, 0.22); }
/* Solid accent — pairs with Known in .sb-extra. */
.sb-btn-open {
  background: var(--sb-accent);
  color: var(--sb-on-solid);
  text-decoration: none;
}
.sb-btn-open:hover { background: var(--sb-accent-hover); color: var(--sb-on-solid); text-decoration: none; }

.sb-feedback { display: block; margin-top: 8px; font-size: 12px; color: var(--sb-ink-subtle); }
.sb-feedback.sb-error { color: var(--sb-error); }
/* Needs-Pro reads as an offer, not a failure: normal ink, an underlined way out. */
.sb-feedback.sb-upgrade { color: var(--sb-ink); }
.sb-plans { color: var(--sb-accent); font-weight: 600; text-decoration: underline; cursor: pointer; }
.sb-plans:hover { color: var(--sb-accent-hover); }
.sb-btn:focus-visible, .sb-headword:focus-visible, .sb-tok:focus-visible, .sb-btn.sb-close:focus-visible {
  outline: 3px solid var(--sb-accent); outline-offset: 2px;
}
@media (prefers-reduced-motion: reduce) {
  .sb-popup { transition: none; }
}
@media (forced-colors: active) {
  .sb-popup, .sb-btn { border: 1px solid ButtonText; }
  .sb-popup { box-shadow: none; }
}
`;
