import { send, type Rating } from "../common/messages.js";
import { loadConfig, pricingUrl } from "../common/config.js";
import { sendDictionary } from "../common/dictionary-port.js";
import type { Definition, Example, GlossRow, KanjiDetail, Sense, TokenCandidate } from "../common/types.js";
import { applyStudyDetails, captureFor, grade, GRADES, markKnown, REVIEW_IN_READER, save, setScanOrigin, studyUrlForWord, type Outcome } from "./actions.js";
import { renderCardForm } from "./card-form.js";
import { refreshMetrics } from "./metrics-reporter.js";
import { rangeFromCaret, selectionText } from "./dom-text.js";
import { placeCard } from "./placement.js";
import { appendFurigana, candidatesFor, hasKanji } from "./word.js";
import { isR2AudioUrl } from "../common/audio.js";
import { senseText } from "../common/senses.js";
import { legendTerm, type LegendTerm } from "../common/legend.js";
import type { GlossLanguage } from "../common/languages.js";
import { toast } from "./toast.js";

// One reused popup, shown next to whichever word the pointer (or keyboard) is
// over. It lives in a shadow root so the host page's CSS can never reach in:
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
let connected = false; // signed in at all: decides what the no-controls row offers
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
// The reader's gloss stack, for the legend text on a sense chip. English until
// the config lands, which is also what an unconnected reader keeps.
let readerLanguages: GlossLanguage[] = [ "eng" ];

// What the popup needs to know about the READER, as opposed to the word: what
// they may save, and which languages they read in. Pushed in whenever the
// config is applied, rather than awaited at render time, because the card is
// drawn synchronously and a promise here would draw it in English first and
// correct itself a tick later.
export function setWriteState(state: { canWrite: boolean; connected: boolean; languages?: GlossLanguage[] }): void {
  canWrite = state.canWrite;
  connected = state.connected;
  if (state.languages?.length) readerLanguages = state.languages;
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
// for: so the keyboard "save" shortcut honours the checkboxes without ever
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

  // Permanent chrome: one top-right row of back, forward, close. It survives
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
    // `selectionText`, not `toString()`: the headword above carries ruby, so
    // double-clicking it used to hand the nested lookup 帰かえった.
    const selection = selectionText(shadow.getSelection?.() ?? window.getSelection());
    const target = event.target as HTMLElement | null;
    if (selection && target) nestedLookup(selection, target.getBoundingClientRect(), currentDepth);
  });
  document.body.append(host);
  installHoverGuards();
  return content;
}

// The popup stays open while the pointer is over the *safe zone*: the hovered
// word OR the popup itself (across the shadow boundary). And closes shortly
// after the pointer leaves both, or immediately on a click elsewhere. Tracking
// the whole zone (rather than the popup's own mouseenter/leave) means a popup
// that repositions when its content loads no longer vanishes under the pointer.
let guardsInstalled = false;
function installHoverGuards(): void {
  if (guardsInstalled) return;
  guardsInstalled = true;

  window.addEventListener("resize", scheduleReposition);
  // Capture phase so scrolling inside the page's own containers counts, and only
  // for captions: see `scheduleReposition`.
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
  //
  // Unless the pointer never went anywhere and another app took the screen: a
  // launcher, a screenshot tool, a switch to another window. That reads to the
  // page as a `mouseleave` too, and closing on it loses the definition somebody
  // is reading the moment they reach for anything outside the browser. Focus is
  // what tells the two apart, so a card only closes for a pointer that left
  // while the page still had the keyboard.
  document.addEventListener("mouseleave", () => {
    if (visible() && document.hasFocus()) scheduleHide();
  });
  // Focus can also leave *after* the mouseleave that started the countdown, and
  // the order is the OS's to decide, so the guard above cannot be the whole fix:
  // a blur is proof after the fact that the pointer exit was an app switch.
  window.addEventListener("blur", () => window.clearTimeout(hideTimer));
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
  if (pinned) return; // the capture form is open; typing takes the pointer away
  window.clearTimeout(showTimer);
  hideTimer = window.setTimeout(hide, 250); // grace to cross the gap onto the popup
}

// Held open by the capture form. A click outside still dismisses (that is a
// decision to leave), but drifting off the card no longer closes it.
let pinned = false;

// A page-level highlight of the matched span for raw-text scans, via the CSS
// Custom Highlight API: it never touches the user's real text selection. Styled
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
  // scan highlight: a highlighted span on the page with no card above it.
  token++;
  highlightScan(null);
}

// Re-anchor when the viewport changes under an open card. Ordinary page scrolling
// needs nothing: the host is positioned in document coordinates, so it travels
// with the word. But a subtitle overlay is `position: fixed`: the caption stays
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
type PopupTarget = {
  key: string; query: string; rect: DOMRect; word: HTMLElement; depth: number;
  kind?: "word" | "kanji"; anchor?: ScanAnchor;
  /**
   * The entry handle the reader PICKED from this span's candidates. Present
   * only after a pick, and it swaps the question: `query` asks which word this
   * spelling is, `pick` says which one it is.
   */
  pick?: string;
};

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
  // `element()` returns: `.sb-popup.sb-visible` is what the stylesheet, `hide`,
  // and `visible()` all key off.
  box?.classList.add("sb-visible");

  // A pick is answered by handle, so the reader gets the word they chose rather
  // than the one the ladder prefers. Everything after this point is the same:
  // the definition it lands on is a definition like any other.
  const res = target.pick
    ? await send({ type: "lookupEntry", entry: target.pick, surface: target.query })
    : await send({ type: "lookup", query: target.query, kind: target.kind ?? "word" });
  if (mine !== token) return; // user moved to another word meanwhile

  if (!res.ok) {
    el.replaceChildren(messageRow(res.error));
    return;
  }
  if (res.type === "lookup" && res.dictionaryInstalling) {
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
    // The entry behind the word the reader is looking at, so a Quick Save posts
    // the same dictionary handle the full form does and the card lands linked.
    if (res.definition.entry) target.word.dataset.entry = res.definition.entry;
    else delete target.word.dataset.entry;
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

// Caption line/cue boxes to clear when a subtitle word is looked up: the popup
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
  // was static and untransformed: a site with `body { position: relative }`
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

  // The cap belongs on `.sb-popup` inside the shadow root: it owns the scrollable
  // body. Capping the host instead would leave the card overflowing it, uncapped.
  if (place.maxHeight != null) box.style.maxHeight = `${place.maxHeight}px`;
  host.style.left = `${place.left - originLeft}px`;
  host.style.top = `${place.top - originTop}px`;
  host.style.visibility = "";
}

// Whether the looked-up text is laid out vertically, which flips which side of
// the word is "in the flow". Read off the word itself: writing mode inherits
// from whatever container the page laid the text out in.
function isVerticalWriting(el: Element | null): boolean {
  return el ? /^(vertical|sideways)/.test(getComputedStyle(el).writingMode) : false;
}

// The connected element the target actually lives in. A raw-text scan's word
// element is detached: it never entered the page. So the scan anchor's text
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
  const picker = candidateRow(word, def);
  if (picker) body.append(picker);
  const badges = badgeRow(def);
  if (badges) body.append(badges);
  if (def.kanji) body.append(kanjiReadings(def.kanji));
  if (def.pitch.length && def.reading) body.append(pitchRows(def.pitch, def.reading));
  // A picker only when the user can save and every sense is shown (2–8): so
  // "all ticked" unambiguously means the whole word.
  const pickable = canWrite && def.senses.length > 1 && def.senses.length <= 8;
  if (pickable) sensePickWord = word;
  body.append(sensesList(def.senses, pickable, coveredSenses(word)));
  const forms = formsRow(def.forms);
  if (forms) body.append(forms);
  // Not on a card that IS a character: its own chip would reopen the card it is
  // already on.
  const kanji = def.kanji ? null : kanjiStrip(def.headword);
  if (kanji) body.append(kanji);
  const examples = examplesBlock(def.examples, def);
  if (examples) body.append(examples);

  const rows: Node[] = [headRow(def), body];
  if (canWrite) rows.push(actions(word, def));
  else rows.push(studyUnavailable());
  return rows;
}

// The word's kanji, each opening its own card HERE rather than a tab.
//
// The pack has carried KANJIDIC all along and the popup could already draw a
// kanji card (`showTarget` takes `kind: "kanji"`, the worker answers it, the
// renderer handles it): nothing ever asked for one. The strip linked out
// instead, so the offline half of the feature was unreachable and the price of
// asking "what is this character" was leaving the page you were reading.
//
// The site is still one step away, not gone: the kanji card that opens is headed
// by a link to its full page, which is where strokes order, components and
// example words live.
function kanjiStrip(headword: string): HTMLElement | null {
  const characters = [...new Set([...headword].filter((character) => /\p{Script=Han}/u.test(character)))];
  if (!characters.length) return null;

  const strip = document.createElement("div");
  strip.className = "sb-kanji-strip";
  strip.setAttribute("aria-label", "Kanji details");
  for (const character of characters) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "sb-btn sb-kanji-button";
    button.textContent = character;
    button.lang = "ja";
    button.title = `What is ${character}?`;
    button.setAttribute("aria-label", `Look up the kanji ${character}`);
    button.addEventListener("click", () => nestedLookup(character, button.getBoundingClientRect(), currentDepth, "kanji"));
    strip.append(button);
  }
  return strip;
}

// On and kun, apart and labelled, because which one a reading is decides how it
// behaves in a compound. Two rows rather than one list: a learner reads down
// this card looking for one of the two families, never for "the readings".
function kanjiReadings(kanji: KanjiDetail): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "sb-kanji-readings";
  for (const [ label, readings ] of [ [ "On", kanji.on ], [ "Kun", kanji.kun ] ] as const) {
    if (!readings.length) continue;
    const row = document.createElement("div");
    row.className = "sb-kanji-row";
    row.append(chip("sb-kanji-kind", label));
    // Capped, because 生 has eleven kun readings and a card is not a reference
    // page: the full list is one tap away on the kanji's own page.
    for (const reading of readings.slice(0, KANJI_READINGS_SHOWN)) row.append(japanese("sb-kanji-reading", reading));
    if (readings.length > KANJI_READINGS_SHOWN) row.append(chip("sb-kanji-more", `+${readings.length - KANJI_READINGS_SHOWN}`));
    wrap.append(row);
  }
  const meta = [
    kanji.strokes ? `${kanji.strokes} strokes` : null,
    kanji.grade ? `Grade ${kanji.grade}` : null,
  ].filter(Boolean).join(" · ");
  if (meta) wrap.append(block("sb-kanji-meta", meta));
  return wrap;
}

const KANJI_READINGS_SHOWN = 6;

// "Also written": the other spellings of the same word.
//
// The question a reader asks the moment the headword is not what they tapped.
// 開く leads its entry and 空く does not, so somebody who met 空く was shown a
// card about a word they appear never to have seen. A rare spelling is dimmed
// rather than dropped: it is exactly the one a reader cannot place, and the
// dictionary's judgement of it is part of the answer.
function formsRow(forms: Definition["forms"]): HTMLElement | null {
  if (!forms?.length) return null;

  const row = document.createElement("div");
  row.className = "sb-forms";
  row.append(chip("sb-forms-label", "Also written"));
  for (const form of forms.slice(0, FORMS_SHOWN)) {
    const spelling = japanese(form.rare ? "sb-form sb-form-rare" : "sb-form", form.text);
    if (form.rare) spelling.title = "Rarely written this way";
    row.append(spelling);
  }
  return row;
}

const FORMS_SHOWN = 8;

// What sits where the Save/Known controls would be. Signed in without Pro is
// the case worth getting right: the reader isn't missing a connection, they're
// missing the subscription, and telling them to "connect" an account they're
// already signed into is both wrong and a dead end. Say what's missing, link it.
// Exported for the test that renders it: it's the whole free-reader experience
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

  // Furigana sits over the headword when it carries kanji: the reading then
  // reads in place, so the separate reading chip beside it would be redundant.
  // A kana-only headword keeps the plain text, and shows the reading chip only
  // when it actually adds something: for この the reading IS この, so drop it.
  if (def.reading && hasKanji(def.headword)) {
    // Furigana sits over each kanji run only; okurigana/kana render plain. The
    // headword is always the dictionary form, so its reading needs no inflection
    // adjustment (unlike a token surface): pass it straight through.
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
// rebuilds them: every move through the history re-checks which ends are live.
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

// Patterns sit in a row that wraps, like the site's: two short accents fit on
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
  // A column per mora, widened for the multi-character ones: きゃ and しょ collide
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

// Numbered senses: POS and qualifier chips, a gloss row per language, the usage
// note and the cross references: the same anatomy as a web meaning.
// Which meanings this word already has a card for: "all" when a whole-word card
// covers every one of them. Stamped by applyStudyDetails from the word's state.
function coveredSenses(word: HTMLElement): Set<number> | "all" {
  const raw = word.dataset.savedSenses;
  if (raw === "all") return "all";
  return new Set((raw ?? "").split(",").filter(Boolean).map(Number));
}

// The card is 460px tall at most and a sense now draws its chips, a row per
// language, its usage note and its cross references: eight of those and the
// examples are somewhere below the fold, past meanings the reader has already
// decided are not the one. So the list leads with four and counts the rest.
//
// The count is the point. `senses.slice(0, 8)` dropped everything past the
// eighth and said nothing, which reads as "this word has eight meanings"; a card
// that truncates has to admit it.
//
// Never while the picker is up. That picker is a form, and its answer is which
// meanings to save: a hidden sense would be a box the reader never saw and a
// save silently scoped to the ones they did. `pickable` is already capped at
// eight senses, so the form stays a readable length by itself.
const SENSES_SHOWN = 4;

function sensesList(senses: Sense[], pickable = false, covered: Set<number> | "all" = new Set()): Node {
  const list = document.createElement("ol");
  list.className = pickable ? "sb-senses sb-senses-pick" : "sb-senses";
  const shown = pickable ? senses : senses.slice(0, SENSES_SHOWN);
  for (const sense of shown) list.append(senseItem(sense, pickable, covered));
  if (shown.length < senses.length) {
    const rest = senses.length - shown.length;
    const more = document.createElement("button");
    more.type = "button";
    more.className = "sb-more-senses";
    more.textContent = `+${rest} more ${rest === 1 ? "meaning" : "meanings"}`;
    more.addEventListener("click", () => {
      // Rebuilt rather than appended to, so the numbering, the covered marks and
      // the picker state all come from one place: this is the same call with
      // nothing held back.
      more.replaceWith(...senses.slice(shown.length).map((sense) => senseItem(sense, false, covered)));
    });
    list.append(more);
  }
  return list;
}

function senseItem(sense: Sense, pickable: boolean, covered: Set<number> | "all"): HTMLElement {
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
    // Reference the gloss, not a sense number: the picker hides the list's
    // ordinals, so a number here would have no visible counterpart.
    box.setAttribute("aria-label", `Include "${senseText(sense)}" when saving`);
    sensePicks.push(box);
    li.append(box);
  } else if (pickable) {
    li.append(chip("sb-sense-saved-mark", "Saved"));
  }
  if (sense.dictionary) body.append(block("sb-source", sense.dictionary));
  const labels = senseChips(sense);
  if (labels) body.append(labels);
  for (const row of sense.glosses) body.append(glossRow(row, sense.glosses.length > 1));
  for (const note of sense.notes ?? []) body.append(block("sb-sense-note", note));
  const xrefs = xrefRow(sense.xrefs);
  if (xrefs) body.append(xrefs);
  if (pickable) li.append(body);
  return li;
}

// Chips rather than a run-on line of prose, and coloured by family, because
// "Godan verb" and "Usually kana" are different kinds of claim: one says what the
// word IS and the other how it is USED, and a single grey line made them read as
// one list of adjectives about the word.
// A chip the Legend can explain OPENS, in the card, offline: "Na-adjective" is
// a term a beginner has to look up somewhere, and the somewhere used to be a
// different site. The explanation is the website's own (see common/legend.ts),
// and a code the book has nothing to say about stays a plain chip rather than a
// button that disappoints.
function senseChips(sense: Sense): HTMLElement | null {
  const labels = [ ...sense.partsOfSpeech, ...sense.tags ];
  if (!labels.length) return null;

  const row = document.createElement("div");
  row.className = "sb-sense-chips";
  const panel = document.createElement("div");
  panel.className = "sb-legend";
  panel.hidden = true;

  for (const label of labels) {
    const term = legendTerm(label.code, label.category === "pos" ? "pos" : "usage", readerLanguages);
    if (!term) {
      const pill = chip(`sb-sense-chip sb-sense-chip-${label.category}`, label.label);
      // The raw JMdict code, for a reader cross-referencing the dictionary itself.
      if (label.code) pill.title = label.code;
      row.append(pill);
      continue;
    }

    const pill = document.createElement("button");
    pill.type = "button";
    pill.className = `sb-sense-chip sb-sense-chip-${label.category} sb-sense-chip-open`;
    pill.textContent = label.label;
    pill.title = `${label.code}: what this means`;
    pill.setAttribute("aria-expanded", "false");
    pill.addEventListener("click", () => {
      // A second tap on the open chip closes it, and any other chip replaces
      // what is in the panel: one explanation at a time, in one place, so the
      // card never grows a stack of them the reader has to dismiss.
      const reopening = pill.getAttribute("aria-expanded") === "true";
      for (const other of row.querySelectorAll("[aria-expanded]")) other.setAttribute("aria-expanded", "false");
      panel.hidden = reopening;
      if (reopening) return;
      pill.setAttribute("aria-expanded", "true");
      panel.replaceChildren(...legendEntry(term));
    });
    row.append(pill);
  }

  const wrap = document.createElement("div");
  wrap.append(row, panel);
  return wrap;
}

// One Legend entry, as the book prints it: the term (with its Japanese name
// beside it), what it means, and an example when the entry has one.
function legendEntry(term: LegendTerm): Node[] {
  const head = document.createElement("div");
  head.className = "sb-legend-head";
  head.append(chip("sb-legend-term", term.label));
  if (term.jp) head.append(japanese("sb-legend-jp", term.jp));

  const nodes: Node[] = [ head, block("sb-legend-body", term.body) ];
  if (term.example) nodes.push(block("sb-legend-example", term.example));
  return nodes;
}

// What this sense points at, and each target OPENS: a cross reference names a
// word, and a word the reader cannot look up is a word they have to go and type
// somewhere. Grouped by what the link means, because "related to" and "the
// opposite of" are not the same information and a mixed row would say neither.
//
// Antonyms first when a sense has both. An opposite is the sharper fact: it
// tells you what the word is by telling you what it is not, and there are far
// fewer of them.
function xrefRow(xrefs: Sense["xrefs"]): HTMLElement | null {
  if (!xrefs?.length) return null;

  const wrap = document.createElement("div");
  wrap.className = "sb-xrefs";
  for (const [ kind, label ] of [ [ "antonym", "Opposite" ], [ "related", "See also" ] ] as const) {
    const group = xrefs.filter((xref) => xref.kind === kind).slice(0, XREFS_SHOWN);
    if (!group.length) continue;

    const row = document.createElement("div");
    row.className = "sb-xref-row";
    row.append(chip("sb-xref-label", label));
    for (const xref of group) {
      const link = japanese("sb-xref", xref.text);
      link.tabIndex = -1;
      link.setAttribute("role", "link");
      link.title = xref.reading ? `${xref.text} (${xref.reading})` : `Look up ${xref.text}`;
      const open = () => nestedLookup(xref.text, link.getBoundingClientRect(), currentDepth);
      link.addEventListener("click", open);
      link.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") { event.preventDefault(); open(); }
      });
      row.append(link);
    }
    rove(row.querySelectorAll<HTMLElement>(".sb-xref"));
    wrap.append(row);
  }
  return wrap.children.length ? wrap : null;
}

// A sense with sixteen related words is a list nobody reads to the end, and the
// word's own page is where a reader goes for the whole set.
const XREFS_SHOWN = 6;

// One meaning, on its own line, behind the two-letter tag for the language it
// is in. The tag only appears when there is a second row to tell it apart from:
// a reader with one language would otherwise be told EN on every line of every
// card they ever open.
function glossRow(row: GlossRow, tagged: boolean): HTMLElement {
  const line = document.createElement("div");
  line.className = "sb-gloss-row";
  line.lang = row.lang === "spa" ? "es" : "en";
  if (tagged) {
    const tag = chip("sb-gloss-lang", row.tag);
    tag.lang = "en";
    line.append(tag);
  }
  line.append(row.text);
  return line;
}

// A couple of example sentences with translations, cut into the same words the
// site read the line with (`Example.tokens`, shipped in the pack).
//
// Two things that cut buys, and both are what a reader asks of an example. The
// word being looked up is MARKED, so a line that says it twice, or says it in a
// form the headword does not spell, still points at itself: without that the
// example is a wall of Japanese with the answer hidden in it. And every other
// word is CLICKABLE, because the sentence a word is explained with is exactly
// where the next unknown word turns up, and sending the reader to select it by
// hand is asking them to leave the card to read the card.
//
// A pack built before recipe 10 ships no tokens, and the line renders as the
// plain string it always did.
function examplesBlock(examples: Example[], def: Definition): Node | null {
  if (!examples.length) return null;
  const wrap = document.createElement("div");
  wrap.className = "sb-examples";
  const names = wordSpellings(def);
  for (const ex of examples) {
    const fig = document.createElement("div");
    fig.className = "sb-example";
    const jp = document.createElement("div");
    jp.className = "sb-example-jp";
    jp.lang = "ja";
    if (ex.tokens?.length) jp.append(...ex.tokens.map((token) => exampleToken(token, names)));
    else jp.textContent = ex.japanese;
    // A sentence is ONE tab stop, and the arrows walk it from there. Twenty
    // words in a line means twenty stops otherwise, and two examples put forty
    // between the reader and the Save button: the same roving-tabindex shape the
    // candidate row uses, and for the same reason.
    rove(jp.querySelectorAll<HTMLElement>(".sb-example-token"));
    fig.append(jp);
    if (ex.translation) fig.append(block("sb-example-tr", ex.translation));
    wrap.append(fig);
  }
  return wrap;
}

// Every spelling that IS the word on this card, for marking it inside an
// example. The headword and its reading are the word itself; `sourceForm` is the
// surface the reader hovered to get here, which is the one an example is most
// likely to repeat and the one the headword often cannot spell (帰った → 帰る).
function wordSpellings(def: Definition): Set<string> {
  return new Set([ def.headword, def.reading, def.sourceForm ].filter((text): text is string => !!text));
}

// One word of an example. A span rather than a button: a sentence of buttons
// reads as a toolbar to a screen reader, and this is a line of Japanese whose
// words happen to open. The lemma decides the MARK (食べました is 食べる, which no
// comparison of surfaces could tell you) and the surface decides the LOOKUP,
// so clicking a conjugated word shows it conjugated, inflection chain and all.
function exampleToken(token: { surface: string; lemma?: string }, names: Set<string>): Node {
  const marked = names.has(token.surface) || (!!token.lemma && names.has(token.lemma));
  const span = document.createElement("span");
  span.className = marked ? "sb-example-token sb-example-hit" : "sb-example-token";
  span.textContent = token.surface;
  // Punctuation and whitespace are tokens too, and neither is a word to look up.
  if (!/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(token.surface)) {
    span.className = "sb-example-gap";
    return span;
  }
  span.tabIndex = -1; // `rove` promotes the first one: the line is one tab stop
  span.setAttribute("role", "link");
  span.title = `Look up ${token.surface}`;
  const open = () => nestedLookup(token.surface, span.getBoundingClientRect(), currentDepth);
  span.addEventListener("click", open);
  span.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") { event.preventDefault(); open(); }
  });
  return span;
}

// A row of things that is ONE tab stop, walked with the arrows: the first is
// tabbable, the rest are reachable only from inside it, and focus moves the
// stop along with it. Opening is still a deliberate Enter, so arrowing across a
// sentence reads it rather than firing a lookup per word.
function rove(items: Iterable<HTMLElement>): void {
  const row = [ ...items ];
  const first = row[0];
  if (!first) return;

  first.tabIndex = 0;
  for (const item of row) {
    item.addEventListener("keydown", (event) => {
      const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
      if (!step) return;
      const here = row.indexOf(item);
      const next = row[(here + step + row.length) % row.length];
      if (!next) return;
      event.preventDefault();
      event.stopPropagation(); // the card scrolls on Arrow keys; this row is steering
      item.tabIndex = -1;
      next.tabIndex = 0;
      next.focus();
    });
  }
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
// the site's dictionary results carry. Reviewing is not here: see
// REVIEW_IN_READER. Each action recolours every occurrence and surfaces any error
// (e.g. the Pro card cap) inline rather than pretend.
function actions(word: HTMLElement, def: Definition | null = null): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "sb-actions";
  renderActions(word, wrap, def);
  return wrap;
}

// The capture form takes over the action row in place: the card is already the
// right surface, and a second floating panel over a hover card is one too many.
// It holds the popup open while it is up, because typing moves the pointer away.
async function openCardForm(word: HTMLElement, wrap: HTMLElement, def: Definition): Promise<void> {
  pinned = true;
  const close = () => {
    pinned = false;
    renderActions(word, wrap, def);
  };
  wrap.replaceChildren(block("sb-feedback", "Capturing…"));
  const capture = await captureFor(word);
  const config = await loadConfig();
  await renderCardForm(wrap, {
    word, definition: def, capture,
    preferredDeckId: config.preferredDeckId ?? undefined,
    onCancel: close,
    onSaved: (message) => {
      pinned = false;
      renderActions(word, wrap, def);
      const note = wrap.querySelector(".sb-feedback");
      if (note) note.textContent = message;
      void refreshMetrics();
    },
  });
}

function renderActions(word: HTMLElement, wrap: HTMLElement, def: Definition | null = null): void {
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
  if (!saved) {
    extra.append(button("＋ Save", "sb-btn-save", "S", () => run(word, wrap, () => save(word, pickedPositions()), def)));
    // Everything you can do with a word hangs off Save; composing the card in
    // full is another item there, not a second button competing with it.
    if (def) extra.append(button("Add details…", "sb-btn-ghost", "D", () => void openCardForm(word, wrap, def)));
  }
  extra.append(button("✓ Known", "sb-btn-known", "K", () => run(word, wrap, () => markKnown(word), def)));
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
  // Same row / weight as Known: solid accent (site primary). "Manage" rather
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

async function run(word: HTMLElement, wrap: HTMLElement, action: () => Promise<Outcome>, def: Definition | null = null): Promise<void> {
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
  if (ok) renderActions(word, wrap, def); // state changed → re-render (Save → grade row + link)
  else for (const control of wrap.querySelectorAll<HTMLButtonElement>("button")) control.disabled = false;
  if (ok) refreshMetrics();
  const note = wrap.querySelector<HTMLElement>(".sb-feedback");
  if (note) {
    note.textContent = message;
    // "Needs Pro" isn't a red failure: it's the one refusal with somewhere to
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
// The other words this span could be, when it names more than one. The reader
// is the only one who knows which they meant: きみ is 君, 黄身 or 黍, and every
// rung the parser could climb has already been climbed. So it offers rather
// than decides, best first, with the current answer marked.
//
// **The pick is what gets carded**, which is the whole point of the row and not
// a side effect: choosing writes `dataset.entry`, and the save posts that as
// `dictionarySlug` + `sourceId`. Without it a save re-derives the word from the
// lemma and can land on the one the reader just rejected.
function candidateRow(word: HTMLElement, def: Definition): HTMLElement | null {
  const candidates = candidatesFor(word);
  if (candidates.length < 2) return null;

  const row = document.createElement("div");
  row.className = "sb-candidates";
  // One of several, exactly one selected: that is a radiogroup, and saying so
  // buys arrow-key movement and a SINGLE tab stop instead of one per candidate.
  row.role = "radiogroup";
  row.setAttribute("aria-label", "Other words this could be");
  drawChips(row, candidates, def, word, false);
  return row;
}

// A cap on the ROW, never on the answer: きみ resolves to a dozen, six of them
// JMnedict entries all glossing "Kimi", and a dozen chips wrap into four lines
// and push the senses off the bottom of the card. The rest are one click away.
const PICKER_VISIBLE = 6;

function drawChips(
  row: HTMLElement,
  candidates: TokenCandidate[],
  def: Definition,
  word: HTMLElement,
  expanded: boolean,
): void {
  row.replaceChildren();
  const picked = candidates.findIndex((candidate) => candidate.entry === def.entry);
  const shown = visibleChips(candidates, picked, expanded);

  for (const { candidate, index } of shown) {
    const pill = document.createElement("button");
    pill.type = "button";
    pill.className = "sb-candidate";
    pill.role = "radio";
    pill.dataset.entry = candidate.entry;
    pill.dataset.index = String(index);

    pill.append(japanese("sb-candidate-word", candidate.headword));
    if (candidate.reading && candidate.reading !== candidate.headword) {
      pill.append(japanese("sb-candidate-reading", candidate.reading));
    }
    // Says WHY six near-identical chips are here: they are people, not readings
    // of the word that was tapped.
    if (isNameCandidate(candidate)) {
      pill.classList.add("sb-candidate-name");
      pill.append(chip("sb-candidate-kind", "name"));
    }

    const on = index === picked;
    pill.classList.toggle("sb-candidate-on", on);
    pill.setAttribute("aria-checked", String(on));
    // Roving tabindex: the group is one stop, arrows move inside it.
    pill.tabIndex = on ? 0 : -1;
    pill.addEventListener("click", () => pickCandidate(word, candidate.entry));
    pill.addEventListener("keydown", (event) => onChipKeydown(event, row, word));
    row.append(pill);
  }

  const hidden = expanded ? 0 : Math.max(0, candidates.length - shown.length);
  if (hidden > 0) {
    const more = document.createElement("button");
    more.type = "button";
    more.className = "sb-candidate sb-candidate-more";
    more.textContent = `+${hidden}`;
    more.setAttribute("aria-label", `Show ${hidden} more`);
    more.addEventListener("click", () => drawChips(row, candidates, def, word, true));
    row.append(more);
  }
}

// The index travels WITH the candidate, which is why this is not a `slice` at
// the call site: once the row is trimmed, the loop index and the position in the
// full list stop agreeing, and a pick addresses the full list. A picked
// candidate is always in the row, or expanding and collapsing again would leave
// the card showing a word whose chip had gone.
function visibleChips(
  candidates: TokenCandidate[],
  picked: number,
  expanded: boolean,
): { candidate: TokenCandidate; index: number }[] {
  const all = candidates.map((candidate, index) => ({ candidate, index }));
  if (expanded || all.length <= PICKER_VISIBLE) return all;

  const head = all.slice(0, PICKER_VISIBLE);
  if (!head.some((chip) => chip.index === picked)) {
    const chosen = all[picked];
    if (chosen) head[head.length - 1] = chosen;
  }
  return head;
}

// A JMnedict entry is a person or a place, not another reading of the word.
// The handle already says so ("jmnedict:5000000"), so nothing has to be added
// to the pack to tell them apart.
function isNameCandidate(candidate: TokenCandidate): boolean {
  return candidate.entry.startsWith("jmnedict:");
}

function onChipKeydown(event: KeyboardEvent, row: HTMLElement, word: HTMLElement): void {
  const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
  if (!step) return;

  const chips = [...row.querySelectorAll<HTMLElement>(".sb-candidate:not(.sb-candidate-more)")];
  const here = chips.indexOf(event.currentTarget as HTMLElement);
  const next = chips[(here + step + chips.length) % chips.length];
  if (!next?.dataset.entry) return;

  event.preventDefault();
  next.focus();
  pickCandidate(word, next.dataset.entry);
}

// Japanese inside a chip, marked as such so the browser picks a JP font and a
// screen reader the right voice: the surrounding page may declare anything.
function japanese(className: string, text: string): HTMLElement {
  const el = chip(className, text);
  el.lang = "ja";
  return el;
}

// Show the word the reader picked, by handle. Not a fresh lookup: they have
// settled the question this popup exists to ask, and re-deriving it would hand
// back whatever the ladder prefers, which is the word they just rejected.
function pickCandidate(word: HTMLElement, entry: string): void {
  const target = currentTarget;
  if (!target || target.pick === entry) return;

  void showTarget({ ...target, key: `pick:${entry}`, pick: entry, word });
}

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
  /* Site primary (sky): pitch, readings, Save, Open card, links. Same tokens
     as shirabe.org --primary so the popup never reads purple. */
  --sb-accent: light-dark(#0369a1, oklch(72% 0.15 245));
  --sb-accent-hover: light-dark(#025a83, oklch(80% 0.13 245));
  --sb-accent-tint: light-dark(#e2f1fa, oklch(26% 0.08 245));
  --sb-accent-tint-strong: light-dark(#cfe7f6, oklch(32% 0.1 245));
  --sb-accent-border: light-dark(#7eb8d9, oklch(60% 0.1 245));
  --sb-source: light-dark(#0369a1, oklch(72% 0.15 245));
  /* The two qualifier families, apart from the POS accent and from each other:
     a field of study ("Computing") and a dialect ("Kansai-ben") say different
     things about a sense than its part of speech does. */
  --sb-field: light-dark(#2563eb, oklch(72% 0.14 260));
  --sb-dialect: light-dark(#7c3aed, oklch(74% 0.14 300));
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
  /* Wider than it was (360px): the picker put a second row of chips above the
     senses on anything with three candidates, and a two-line gloss is the normal
     case rather than the long one. Still capped to the viewport so a narrow
     phone window is not pushed sideways. */
  width: min(420px, calc(100vw - 24px));
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

/* Back, forward, close: one row in the top-right, outside content swaps. Its
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

/* The candidate picker: every word this span can name, the current one marked.
   A row of chips rather than a list, because it is a choice between short
   labels and it sits above the definition it changes. Pinned (flex: 0 0 auto)
   so a long list never eats the senses' share of a capped-height card, and
   allowed to wrap, because a horizontal scroller hides the candidates a reader
   most needs to see. */
.sb-candidates { flex: 0 0 auto; display: flex; flex-wrap: wrap; gap: 4px; margin-bottom: 8px; }

/* Quiet until picked. An unpicked chip is an alternative rather than an action,
   so it must not compete with the headword, but it still has to look pressable,
   which a bare word does not. */
.sb-candidate {
  font: inherit;
  display: inline-flex;
  align-items: baseline;
  gap: 4px;
  line-height: 1.4;
  padding: 2px 7px;
  color: var(--sb-ink-muted);
  background: transparent;
  border: 1px solid var(--sb-outline);
  border-radius: 999px;
  cursor: pointer;
  transition: background-color .12s ease, color .12s ease, border-color .12s ease;
}
.sb-candidate:hover { background: var(--sb-surface-muted); color: var(--sb-ink); }
.sb-candidate-word { font-size: 13px; font-weight: 600; }
.sb-candidate-reading { font-size: 11px; opacity: .75; }

/* The one the card is showing. A tint rather than a brighter neutral, so the
   selected chip and the open word in the page say "this is what you are looking
   at" the same way. */
.sb-candidate-on {
  color: var(--sb-accent);
  background: var(--sb-accent-tint);
  border-color: transparent;
}
.sb-candidate:focus-visible { outline: 2px solid var(--sb-accent); outline-offset: 2px; }

/* A name, not a reading of the word that was tapped: a reason to SKIP the chip
   rather than something to read, so it is quiet and the chip is dimmed. */
.sb-candidate-kind {
  font-size: 9px;
  text-transform: uppercase;
  letter-spacing: .04em;
  opacity: .55;
}
.sb-candidate-name:not(.sb-candidate-on) { opacity: .72; }

/* The rest of the ranked list, one click away. A chip because it sits in the row
   and takes the same click, but with no headword to show. */
.sb-candidate-more { font-size: 12px; color: var(--sb-ink-subtle); }
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
/* On and kun as labelled rows. The kind sits in a fixed-width chip so the two
   rows' readings line up under each other and the eye can run down one family. */
.sb-kanji-readings { margin: 6px 0; }
.sb-kanji-row { display: flex; flex-wrap: wrap; align-items: baseline; gap: 5px; margin-top: 3px; }
.sb-kanji-kind {
  min-width: 2.2em;
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.03em;
  color: var(--sb-ink-muted);
}
.sb-kanji-reading { font-size: 13px; color: var(--sb-ink); }
.sb-kanji-more { font-size: 11px; color: var(--sb-ink-faint); }
.sb-kanji-meta { margin-top: 4px; font-size: 11px; color: var(--sb-ink-muted); }
/* "Also written". The label reads as a caption rather than a chip: it names the
   row, and boxing it would make it look like one of the spellings. */
.sb-forms {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 6px;
  margin-top: 8px;
}
.sb-forms-label {
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.03em;
  text-transform: uppercase;
  color: var(--sb-ink-muted);
}
.sb-form { font-size: 14px; color: var(--sb-ink); }
/* Rare spellings are the ones a reader cannot place, so they are shown: dimmed
   is the dictionary's judgement of them, not a way of hiding them. */
.sb-form-rare { color: var(--sb-ink-faint); }

.sb-senses { margin: 0; padding-left: 18px; }
/* The truncation, said out loud. A link rather than a button-looking control:
   it reveals what is already on the card, it does not go anywhere. */
.sb-more-senses {
  display: block;
  margin: 4px 0 0 -18px;
  padding: 0;
  border: 0;
  background: none;
  font-family: inherit;
  font-size: 12px;
  font-weight: 600;
  color: var(--sb-accent);
  cursor: pointer;
  text-underline-offset: 2px;
}
.sb-more-senses:hover { text-decoration: underline; }
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
/* Chips rather than a run-on line of prose. JMdict's own labels repeat
   themselves ("noun (common) (futsuumeishi)"), so the chip prints the short form
   keyed off the code and keeps the code itself in its tooltip. Coloured by
   category, so a usage qualifier never reads as a part of speech: the same split
   shirabe.org makes between its POS and qualifier chips. */
.sb-sense-chips { display: flex; flex-wrap: wrap; gap: 4px; margin-bottom: 3px; }
.sb-sense-chip {
  display: inline-flex;
  align-items: center;
  padding: 0 6px;
  border: 1px solid color-mix(in srgb, currentColor 26%, transparent);
  border-radius: 999px;
  background: color-mix(in srgb, currentColor 12%, transparent);
  font-size: 10px;
  font-weight: 600;
  line-height: 16px;
  white-space: nowrap;
  color: var(--sb-ink-faint);
}
.sb-sense-chip-pos { color: var(--sb-accent); }
/* A chip that explains itself. It carries no extra ornament: the whole row is
   already chips, and marking half of them differently would say "these are a
   different kind of label", which is exactly what the colours already say and
   this does not. The pointer and the hover tint are the affordance. */
.sb-sense-chip-open {
  font-family: inherit;
  cursor: pointer;
  transition: filter 0.12s ease;
}
.sb-sense-chip-open:hover { filter: brightness(1.08); }
.sb-sense-chip-open[aria-expanded="true"] { background: color-mix(in srgb, currentColor 22%, transparent); }
.sb-legend {
  margin: 4px 0 6px;
  padding: 7px 9px;
  border: 1px solid var(--sb-outline);
  border-radius: 8px;
  background: var(--sb-surface-muted);
}
.sb-legend-head { display: flex; align-items: baseline; gap: 6px; }
.sb-legend-term { font-size: 12px; font-weight: 600; color: var(--sb-ink); }
.sb-legend-jp { font-size: 11px; color: var(--sb-ink-muted); }
.sb-legend-body { margin-top: 3px; font-size: 12px; color: var(--sb-ink-subtle); }
.sb-legend-example { margin-top: 3px; font-size: 11px; color: var(--sb-ink-muted); }
.sb-sense-chip-field { color: var(--sb-field); }
.sb-sense-chip-dialect { color: var(--sb-dialect); }
/* One meaning per line, behind the tag for the language it is in. The tag is a
   quiet outline rather than a filled badge: it repeats on every row of every
   sense, and a reader who wants one language has to be able to skip it without
   reading it. */
/* A usage note is an aside about the sense above it, and italic is how the
   dictionary itself sets one: it must not read as another meaning. */
.sb-sense-note {
  margin-top: 2px;
  font-size: 11px;
  font-style: italic;
  color: var(--sb-ink-muted);
}
/* Cross references: a label naming what the link means, then the words. Each
   word is a lookup, so it is tinted like one; the row is one tab stop. */
.sb-xrefs { margin-top: 3px; }
.sb-xref-row { display: flex; flex-wrap: wrap; align-items: baseline; gap: 5px; margin-top: 2px; }
.sb-xref-label {
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.03em;
  text-transform: uppercase;
  color: var(--sb-ink-muted);
}
.sb-xref {
  border-radius: 3px;
  font-size: 13px;
  color: var(--sb-accent);
  cursor: pointer;
  text-underline-offset: 2px;
}
.sb-xref:hover { background: var(--sb-accent-tint); text-decoration: underline; }
.sb-xref:focus-visible { outline: 2px solid var(--sb-accent-border); outline-offset: 1px; }
.sb-gloss-row { display: block; }
.sb-gloss-row + .sb-gloss-row { margin-top: 2px; }
.sb-gloss-lang {
  display: inline-flex;
  justify-content: center;
  min-width: 1.55em;
  margin-right: 6px;
  padding: 1px 4px;
  border: 1px solid var(--sb-outline-strong);
  border-radius: 4px;
  font-size: 9px;
  font-weight: 600;
  letter-spacing: 0.03em;
  line-height: 1.4;
  color: var(--sb-ink-muted);
  vertical-align: 1px;
}

.sb-examples { margin-top: 10px; padding-top: 8px; border-top: 1px solid var(--sb-divider); }
.sb-example { margin: 6px 0; }
.sb-example-jp { color: var(--sb-ink); }
.sb-example-tr { font-size: 13px; color: var(--sb-ink-subtle); }
/* Clickable sentence tokens: subtle until hovered; the searched word tinted.
   Nothing is drawn around a word at rest, because a line with a box on every
   word stops reading as a sentence. The underline appears under the pointer,
   which is the only moment "this opens" is a useful thing to say. */
.sb-example-token {
  border-radius: 3px;
  cursor: pointer;
  text-underline-offset: 2px;
}
.sb-example-token:hover { background: var(--sb-accent-tint); text-decoration: underline; }
.sb-example-token:focus-visible {
  outline: 2px solid var(--sb-accent-border);
  outline-offset: 1px;
}
/* The word this card is about. Tinted rather than boxed or bolded: the line has
   to stay a line, and a reader scanning for "where is my word" finds a colour
   before they find a weight. */
.sb-example-hit {
  background: var(--sb-accent-tint-strong);
  color: var(--sb-accent);
  font-weight: 600;
}
.sb-example-hit:hover { background: var(--sb-accent-tint-strong); }
/* Punctuation and spacing: part of the line, never a lookup. */
.sb-example-gap { cursor: default; }

.sb-actions { flex: 0 0 auto; margin-top: 12px; }
.sb-membership { margin-bottom: 6px; color: var(--sb-ink-muted); font-size: 11px; }
.sb-grades { display: grid; grid-template-columns: repeat(4, 1fr); gap: 6px; }
.sb-extra { display: flex; gap: 6px; margin-top: 6px; }
.sb-extra .sb-btn { flex: 1; }

/* The capture form (card-form.ts), in place of the action row. Same tokens as
   the rest of the card: it is the same surface, not a dialog over it. */
.sb-form { display: flex; flex-direction: column; gap: 10px; margin-top: 6px; }
.sb-field { display: flex; flex-direction: column; gap: 4px; }
.sb-field-label { color: var(--sb-ink-muted); font-size: 11px; font-weight: 600; }
.sb-field-hint { color: var(--sb-ink-muted); font-size: 11px; }
.sb-row { display: flex; align-items: center; gap: 6px; }
.sb-input {
  width: 100%; box-sizing: border-box; padding: 5px 7px; font: inherit; font-size: 12px;
  color: var(--sb-ink); background: var(--sb-surface); border: 1px solid var(--sb-divider); border-radius: 6px;
}
.sb-input:focus-visible { outline: 2px solid var(--sb-accent); outline-offset: 1px; }
.sb-form-senses { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 3px; }
.sb-form-senses li { display: flex; align-items: baseline; gap: 6px; font-size: 12px; }
.sb-form-gloss { flex: 1; }
.sb-form-examples { display: flex; flex-direction: column; gap: 6px; }
.sb-form-picks:empty { display: none; }
.sb-form-picks { display: flex; flex-wrap: wrap; gap: 4px; }
.sb-form-chip {
  display: inline-flex; align-items: center; gap: 4px; max-width: 100%;
  padding: 2px 4px 2px 7px; font-size: 11px; line-height: 1.5;
  background: var(--sb-accent-tint); color: var(--sb-ink); border-radius: 999px;
}
.sb-form-chip-text { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 220px; }
.sb-form-chip-x { border: 0; background: none; color: inherit; cursor: pointer; font-size: 13px; line-height: 1; padding: 0 2px; }
.sb-form-offers { display: flex; flex-direction: column; gap: 2px; }
.sb-form-offer {
  text-align: left; border: 0; background: none; padding: 2px 0; cursor: pointer;
  color: var(--sb-ink-muted); font: inherit; font-size: 11px;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.sb-form-offer:hover { color: var(--sb-accent); text-decoration: underline; }
.sb-form-shot { max-width: 120px; border-radius: 4px; border: 1px solid var(--sb-divider); }
.sb-form-actions { display: flex; align-items: center; gap: 6px; }

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
/* Solid accent: pairs with Known in .sb-extra. */
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
.sb-btn:focus-visible, .sb-headword:focus-visible, .sb-btn.sb-close:focus-visible {
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
