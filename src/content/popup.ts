import { send, type Rating } from "../common/messages.js";
import { sendDictionary } from "../common/dictionary-port.js";
import type { Definition, Example, Sense, SentenceToken } from "../common/types.js";
import { applyStudyDetails, cardUrlFor, grade, GRADES, markKnown, save, studyUrlForWord, type Outcome } from "./actions.js";
import { refreshStatusBar } from "./status-bar.js";
import { rangeFromCaret } from "./dom-text.js";
import { appendFurigana, hasKanji } from "./word.js";
import { isR2AudioUrl } from "../common/audio.js";
import { toast } from "./toast.js";

// One reused popup, shown next to whichever word the pointer (or keyboard) is
// over. It lives in a shadow root so the host page's CSS can never reach in —
// definitions render the same on every site. Lookups are fetched lazily (and
// cached in the background worker).
let host: HTMLElement | null = null;
let root: ShadowRoot | null = null;
let box: HTMLElement | null = null;
let currentKey: string | null = null;
let showTimer: number | undefined;
let hideTimer: number | undefined;
let token = 0; // guards against a slow lookup landing after we've moved on
let canWrite = false; // WRITE_SRS + entitled → render mining controls
const lookupHistory: PopupTarget[] = [];
let historyIndex = -1;
let navigatingHistory = false;
let currentDepth = 0;
let dictionaryInstallPromise: Promise<void> | null = null;

export function setCanWrite(value: boolean): void {
  canWrite = value;
}

function element(): HTMLElement {
  if (box) return box;
  host = document.createElement("div");
  host.className = "sb-host";
  root = host.attachShadow({ mode: "open" });
  const style = document.createElement("style");
  style.textContent = CSS;
  box = document.createElement("div");
  box.className = "sb-popup";
  box.setAttribute("role", "dialog");
  box.setAttribute("aria-label", "Shirabe dictionary");
  root.append(style, box);
  box.addEventListener("dblclick", (event) => {
    const selection = window.getSelection()?.toString().trim();
    const target = event.target as HTMLElement | null;
    if (selection && target) nestedLookup(selection, target.getBoundingClientRect(), currentDepth);
  });
  document.body.append(host);
  installHoverGuards();
  return box;
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

  document.addEventListener("mouseover", (e) => {
    if (visible() && inSafeZone(e)) window.clearTimeout(hideTimer);
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
  highlightScan(null);
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
  currentDepth = target.depth;
  if (!navigatingHistory) recordHistory(target);
  navigatingHistory = false;
  const mine = ++token;
  highlightScan(null); // drop any previous scan highlight until this match resolves

  const el = element();
  el.replaceChildren(loadingRow(target.query));
  position(target.rect, target.word);
  el.classList.add("sb-visible");

  const res = await send({ type: "lookup", query: target.query, kind: target.kind ?? "word" });
  if (mine !== token) return; // user moved to another word meanwhile

  if (!res.ok) {
    el.replaceChildren(messageRow(res.error));
    return;
  }
  if (res.dictionaryInstalling) {
    el.replaceChildren(loadingRow(target.query), messageRow("Preparing the offline dictionary…"));
    position(target.rect, target.word);
    void ensureDictionaryInstallation();
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
          if (details.cardId != null) target.word.dataset.cardUrl = await cardUrlFor(details.cardId);
        } else {
          target.word.dataset.state = states.states[res.definition.headword] ?? "none";
        }
      }
    }
  }
  el.replaceChildren(...definitionRows(res.definition, target.query, target.word));
  position(target.rect, target.word);
}

function ensureDictionaryInstallation(): Promise<void> {
  if (dictionaryInstallPromise) return dictionaryInstallPromise;
  dictionaryInstallPromise = sendDictionary({ type: "installDictionary" })
    .then((response) => {
      if (!response.ok && visible()) element().replaceChildren(messageRow(response.error));
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
      position(target.rect, target.word);
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

function position(rect: DOMRect, word?: HTMLElement): void {
  if (!host) return;
  const margin = 12;
  host.style.visibility = "hidden";
  host.style.left = "0px";
  host.style.top = "0px";
  const { width, height } = host.getBoundingClientRect();
  const viewW = document.documentElement.clientWidth;
  const viewH = document.documentElement.clientHeight;

  // The box the popup must not overlap. For a subtitle word that's the whole
  // caption line (so we don't bury the rest of the sentence being read); for an
  // ordinary page word it's just the word, preserving the original behaviour.
  const avoid = captionRect(word) ?? rect;
  const roomRight = viewW - avoid.right - margin;
  const roomLeft = avoid.left - margin;
  let left: number;
  let top: number;

  // Prefer the page margin beside the obstacle when a fixed-size card fits there;
  // this preserves the sentence being read. Narrow layouts (or a wide caption
  // spanning the frame) fall back above or below, clearing the obstacle entirely.
  if (roomRight >= width) {
    left = avoid.right + margin;
    top = rect.top;
  } else if (roomLeft >= width) {
    left = avoid.left - width - margin;
    top = rect.top;
  } else {
    left = rect.left + rect.width / 2 < viewW / 2 ? rect.left : rect.right - width;
    const roomBelow = viewH - avoid.bottom - margin;
    const roomAbove = avoid.top - margin;
    top = avoid.bottom + margin;
    if (height > roomBelow && roomAbove > roomBelow) top = avoid.top - height - margin;
  }
  left = Math.max(margin, Math.min(left, viewW - width - margin));
  top = Math.max(margin, Math.min(top, viewH - height - margin));

  host.style.left = `${window.scrollX + left}px`;
  host.style.top = `${window.scrollY + top}px`;
  host.style.visibility = "";
}

// The caption line's on-screen rect when `word` is a subtitle, else null. Prefers
// the cue container (full line width); falls back to the media caption context we
// tag with data-media-timestamp.
function captionRect(word?: HTMLElement): DOMRect | null {
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
  body.append(sensesList(def.senses));
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

function studyUnavailable(): HTMLElement {
  const row = document.createElement("div");
  row.className = "sb-study-unavailable";
  row.textContent = "Offline lookup · Connect a Pro account to save and review";
  return row;
}

// Headword (links to its shirabe.org page) + reading + an R2-backed audio button.
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

  const navigation = document.createElement("span");
  navigation.className = "sb-history-nav";
  const back = button("←", "sb-history-button", "", () => navigateHistory(-1));
  back.title = "Previous lookup";
  back.setAttribute("aria-label", "Previous lookup");
  back.toggleAttribute("disabled", historyIndex <= 0);
  const forward = button("→", "sb-history-button", "", () => navigateHistory(1));
  forward.title = "Next lookup";
  forward.setAttribute("aria-label", "Next lookup");
  forward.toggleAttribute("disabled", historyIndex >= lookupHistory.length - 1);
  navigation.append(back, forward);
  head.append(navigation);

  const audioUrl = def.pitch.map((pitch) => pitch.audioUrl).find(isR2AudioUrl);
  if (audioUrl) {
    const audio = button("🔊", "sb-audio", "", () => void playAudio(audioUrl));
    audio.title = "Play pronunciation";
    audio.setAttribute("aria-label", "Play pronunciation");
    head.append(audio);
  }
  return head;
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

// One NHK-style pitch graph + [downstep] per accent pattern.
function pitchRows(pitch: Definition["pitch"], reading: string): Node {
  const wrap = document.createElement("div");
  wrap.className = "sb-pitch";
  for (const p of pitch) {
    const row = document.createElement("div");
    row.className = "sb-pitch-item";
    row.append(pitchGraph(reading, p.downstep), chip("sb-pitch-num", `[${p.downstep}]`));
    wrap.append(row);
  }
  return wrap;
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
  const step = 22;
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", `0 0 ${n * step + 16} 46`);
  svg.setAttribute("class", "sb-pitch-svg");
  const x = (i: number) => 8 + i * step + step / 2;
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
function sensesList(senses: Sense[]): Node {
  const list = document.createElement("ol");
  list.className = "sb-senses";
  for (const sense of senses.slice(0, 8)) {
    const li = document.createElement("li");
    if (sense.source) li.append(block("sb-source", sense.source));
    if (sense.partsOfSpeech.length) li.append(block("sb-pos", sense.partsOfSpeech.join(", ")));
    if (sense.tags.length) {
      const tags = document.createElement("i");
      tags.className = "sb-tags";
      tags.textContent = `${sense.tags.join(", ")} `;
      li.append(tags);
    }
    li.append(sense.glosses.join("; "));
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
    const missing = /\((404|403)\)/.test(res.error);
    toast(missing ? "No pronunciation audio for this word yet." : "Couldn't load pronunciation audio.", false);
    return;
  }
  try {
    await new Audio(res.dataUrl).play();
  } catch {
    toast("Couldn't play pronunciation audio.", false);
  }
}

// Mining + review controls, gated by whether the word is already a card. An
// untracked word (state "none") offers Save + Known; once it's a card the grade
// row reviews it. Each action recolours every occurrence and surfaces any error
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

  if (word.dataset.state === "due") {
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
  if (!saved) extra.append(button("＋ Save", "sb-btn-save", "S", () => run(word, wrap, () => save(word))));
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
  // Same row / weight as Known — solid accent (site primary).
  link.className = "sb-btn sb-btn-open";
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.textContent = "Open card";
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
      const url = await cardUrlFor(details.cardId);
      word.dataset.cardUrl = url;
      link.href = url;
    });
  }
  return link;
}

async function run(word: HTMLElement, wrap: HTMLElement, action: () => Promise<Outcome>): Promise<void> {
  if (wrap.dataset.running === "true") return;
  wrap.dataset.running = "true";
  for (const control of wrap.querySelectorAll<HTMLButtonElement>("button")) control.disabled = true;
  const outcome = await action();
  const { ok, message, cardUrl } = outcome;
  if (cardUrl) word.dataset.cardUrl = cardUrl;
  delete wrap.dataset.running;
  if (ok) renderActions(word, wrap); // state changed → re-render (Save → grade row + link)
  else for (const control of wrap.querySelectorAll<HTMLButtonElement>("button")) control.disabled = false;
  if (ok) refreshStatusBar();
  const note = wrap.querySelector<HTMLElement>(".sb-feedback");
  if (note) {
    note.textContent = message;
    note.classList.toggle("sb-error", !ok);
  }
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

/* Head + actions stay pinned; the body (badges, pitch, senses, examples)
   scrolls (Yomitan-style) so the reading is always visible. min-height:0 lets
   the flex child shrink below its content height. */
.sb-popup-head { flex: 0 0 auto; display: flex; align-items: baseline; gap: 8px; font-size: 20px; font-weight: 700; }
.sb-history-nav { display: inline-flex; gap: 3px; margin-left: auto; }
.sb-btn.sb-history-button { cursor: pointer; border: 0; border-radius: 5px; padding: 3px 6px; background: var(--sb-surface-muted); color: var(--sb-ink-muted); }
.sb-btn.sb-history-button:hover { background: var(--sb-surface-hover); }
.sb-btn.sb-history-button:disabled { cursor: default; opacity: .35; }
.sb-headword { color: var(--sb-ink); text-decoration: none; cursor: pointer; }
.sb-headword:hover { color: var(--sb-accent); text-decoration: underline; }
.sb-headword ruby { ruby-align: center; }
.sb-headword ruby rt { font-size: 0.5em; font-weight: 600; color: var(--sb-accent); user-select: none; }
.sb-popup-reading { font-size: 14px; font-weight: 500; color: var(--sb-accent); }
.sb-popup-message { color: var(--sb-ink-subtle); }
.sb-inflection { margin-bottom: 7px; color: var(--sb-ink-subtle); font-size: 12px; }
.sb-study-unavailable { flex: 0 0 auto; margin-top: 10px; padding-top: 8px; border-top: 1px solid var(--sb-outline); color: var(--sb-ink-subtle); font-size: 11px; }

.sb-body { flex: 0 1 auto; min-height: 0; overflow-y: auto; margin-top: 8px; }

.sb-btn.sb-audio {
  margin-left: auto; align-self: center; color: inherit; background: transparent;
  padding: 2px 6px; border-radius: 8px; font-size: 15px; line-height: 1;
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

.sb-pitch { margin-bottom: 8px; }
.sb-pitch-item { display: flex; align-items: center; gap: 8px; }
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

.sb-actions { flex: 0 0 auto; margin-top: 12px; padding-top: 10px; border-top: 1px solid var(--sb-divider); }
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
.sb-btn:focus-visible, .sb-headword:focus-visible, .sb-tok:focus-visible {
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
