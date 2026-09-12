import { send } from "../common/messages.js";
import type { ParsedToken } from "../common/types.js";
import { applyStateEverywhere, rememberShownCut, renderToken } from "./word.js";

// Keep in sync with offline-dictionary's Japanese character set so caption
// text that uses full-width alphanumerics (ＣＤ, Ｔシャツ) is still collected.
const JAPANESE = /[々〇〻\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}０-９Ａ-Ｚａ-ｚｦ-ﾟ]/u;
const SKIP_TAGS = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEXTAREA", "INPUT", "CODE", "PRE"]);
// A reading the page already supplies is an annotation, not text to tokenize :
// so `ruby` is skipped whole, base and annotation together (a base we rewrote
// would lose the <rt> aligned over it). Matched by ancestor rather than parent
// tag: <rt><span>かんじ</span></rt> is ordinary markup, and a parent-tag test
// let that reading through as if it were source. Sites that build furigana out
// of positioned spans instead of `ruby` (jisho.org) are excluded by their host
// rule's `filter`, since no element tells us it is an annotation there.
const ANNOTATION_SELECTOR = "ruby";
const PARSED_FLAG = "sbParsed"; // dataset key on the wrapper we insert
let paused = false;

// One background message covers many text nodes at once. The background returns
// one token list per input, preserving offsets and keeping message overhead bounded.
const BATCH_CHARS = 8000;
const DISCOVERY_SLICE_NODES = 300;

// Per-site options carried by a matched host rule.
export type ParseOptions = {
  filter?: string; // CSS selector of elements to exclude from parsing
  collapseWhitespace?: boolean; // reserved for OCR/manga custom parsers
};

// Collect text nodes worth parsing under `root`: visible, Japanese-bearing, and
// not already processed or inside something we shouldn't touch (form fields,
// our own output, editable regions, or a rule's `filter` selector). Nodes with
// no Japanese are rejected here, so a page/batch with no Japanese never reaches
// the network: we only ever /parse Japanese text.
function collectTextNodes(root: Node, filter?: string): Text[] {
  const nodes: Text[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => parseableTextNode(node, filter),
  });

  for (let n = walker.nextNode(); n; n = walker.nextNode()) nodes.push(n as Text);
  return nodes;
}

function parseableTextNode(node: Node, filter?: string): number {
  const text = node.nodeValue;
  if (!text || !JAPANESE.test(text)) return NodeFilter.FILTER_REJECT;
  const parent = node.parentElement;
  if (!parent || SKIP_TAGS.has(parent.tagName) || parent.isContentEditable) return NodeFilter.FILTER_REJECT;
  if (parent.closest(`${ANNOTATION_SELECTOR}, [data-sb-parsed], .sb-word, .sb-popup`)) return NodeFilter.FILTER_REJECT;
  if (filter && parent.closest(filter)) return NodeFilter.FILTER_REJECT;
  return NodeFilter.FILTER_ACCEPT;
}

// Group nodes into batches whose combined text stays under the char cap.
function batchNodes(nodes: Text[]): Text[][] {
  const batches: Text[][] = [];
  let current: Text[] = [];
  let length = 0;
  for (const node of nodes) {
    const size = (node.nodeValue ?? "").length + 1; // +1 rough per-element overhead
    if (current.length && length + size > BATCH_CHARS) {
      batches.push(current);
      current = [];
      length = 0;
    }
    current.push(node);
    length += size;
  }
  if (current.length) batches.push(current);
  return batches;
}

// Parse a batch of nodes in one local-worker request. Results stay index-aligned,
// so each original text node can be replaced with its own detached wrapper.
async function parseBatch(nodes: Text[], showFurigana: boolean): Promise<void> {
  const res = await send({ type: "parseBatch", texts: nodes.map((node) => node.nodeValue ?? "") });
  if (!res.ok) throw new Error(res.error);
  if (res.dictionaryInstalling) throw new Error("The offline dictionary is still installing.");

  res.tokens.forEach((tokens, i) => {
    const node = nodes[i];
    if (!node?.parentNode) return; // removed while we waited
    node.parentNode.replaceChild(buildWrapper(node.nodeValue ?? "", tokens, showFurigana), node);
  });
  queueStateRefresh(res.tokens.flat());
}


// The cut ONE sentence carried, as the page drew it, memoised per sentence so a
// twenty-word line builds one array rather than twenty. Sliced out of the token
// stream the whole text node was parsed with, which is the point: re-reading the
// sentence on its own can come back cut differently, because the parse that
// produced these boundaries had the rest of the node to look ahead into.
//
// Nothing is recorded when the slice does not rebuild the sentence exactly. That
// happens when a token straddles the boundary, and then there IS no cut of this
// sentence to report: the save falls back to re-parsing and says so.
function shownCuts(text: string, tokens: readonly ParsedToken[]): Map<number, readonly string[]> {
  const bySentence = new Map<number, ParsedToken[]>();
  for (const token of tokens) {
    const sentence = sentenceAt(text, token.start);
    const list = bySentence.get(sentence.start);
    if (list) list.push(token);
    else bySentence.set(sentence.start, [ token ]);
  }

  const cuts = new Map<number, readonly string[]>();
  for (const [ start, list ] of bySentence) {
    const surfaces = list.map((token) => token.surface);
    if (surfaces.join("") === sentenceAt(text, start).text) cuts.set(start, surfaces);
  }
  return cuts;
}


// Which chip of the shown cut this element is, found by walking the surfaces to
// the offset the element already carries. By POSITION rather than by matching
// the surface, because a line repeating a word ("本を読む本") would otherwise
// point every occurrence at the first one.
function recordShownCut(word: HTMLElement, surfaces: readonly string[] | undefined, surface: string, targetStart: number): void {
  if (!surfaces) return;

  let at = 0;
  for (const [ index, text ] of surfaces.entries()) {
    if (at === targetStart && text === surface) return rememberShownCut(word, { surfaces, index });
    at += text.length;
  }
}

// Rebuild one text node as tokenized, word-wrapped DOM (gaps kept as plain text).
// Exported for the cut tests: what it records is what a mined card points into.
export function buildWrapper(text: string, tokens: ParsedToken[], showFurigana: boolean): HTMLElement {
  const wrapper = document.createElement("span");
  wrapper.dataset[PARSED_FLAG] = "1";
  const cuts = shownCuts(text, tokens);
  let cursor = 0;
  for (const token of tokens) {
    if (token.start > cursor) wrapper.append(text.slice(cursor, token.start));
    const rendered = renderToken(token, showFurigana);
    if (rendered instanceof HTMLElement) {
      const sentence = sentenceAt(text, token.start);
      rendered.dataset.sentence = sentence.text;
      rendered.dataset.targetStart = String(token.start - sentence.start);
      rendered.dataset.targetEnd = String(token.start - sentence.start + token.length);
      recordShownCut(rendered, cuts.get(sentence.start), token.surface, token.start - sentence.start);
    }
    wrapper.append(rendered);
    cursor = token.start + token.length;
  }
  if (cursor < text.length) wrapper.append(text.slice(cursor));
  return wrapper;
}

// Sentence terminators and the quote pairs that suspend them, following
// Yomitan's sentence-parsing defaults.
const SENTENCE_BOUNDARY = /[。．！？!?…\n]/;
const QUOTE_PAIRS = new Map([["「", "」"], ["『", "』"], ["（", "）"], ["(", ")"], ["“", "”"]]);
const CLOSING_QUOTES = new Map([...QUOTE_PAIRS].map(([open, close]) => [close, open]));

// The sentence around `offset`, used as the mined card's context. A terminator
// inside quoted speech does NOT end the sentence: 「行くぞ。」と彼は言った。 is one
// sentence, and breaking on that inner 。 mined the fragment 」と彼は言った。 :
// stray quote, speech lost. Scanning outward, an unmatched closing quote behind
// us (or opening quote ahead) means we started inside a quotation, so keep going
// until it is balanced.
function sentenceAt(text: string, offset: number): { text: string; start: number } {
  let start = offset;
  let depth = 0;
  let insideQuote = false; // we began within a quotation, so it opens before us
  while (start > 0) {
    const char = text[start - 1];
    if (CLOSING_QUOTES.has(char)) depth += 1; // entering a quotation, scanning back
    else if (QUOTE_PAIRS.has(char)) {
      if (depth === 0) { insideQuote = true; break; } // unmatched opener: quotation starts here
      depth -= 1;
    } else if (depth === 0 && SENTENCE_BOUNDARY.test(char)) break;
    start -= 1;
  }

  let end = offset;
  depth = 0;
  while (end < text.length) {
    const char = text[end];
    if (QUOTE_PAIRS.has(char)) depth += 1;
    else if (CLOSING_QUOTES.has(char)) {
      if (depth === 0) break; // an unmatched closer: the quotation ends here
      depth -= 1;
    } else if (depth === 0 && SENTENCE_BOUNDARY.test(char)) break;
    end += 1;
  }
  // Keep the terminator itself, plus any closing quote that follows it (。」) :
  // but not when the word sat inside the quotation, where the opening 「 was
  // excluded too: mining 行く from 「行くぞ。」 gives 行くぞ。, not 行くぞ。」.
  let stop = Math.min(text.length, end + 1);
  if (!insideQuote) while (stop < text.length && CLOSING_QUOTES.has(text[stop])) stop += 1;

  const raw = text.slice(start, stop);
  const leading = raw.length - raw.trimStart().length;
  return { text: raw.trim(), start: start + leading };
}

// Parse everything under `root` eagerly (used for a selection, where the user
// wants it now). Returns how many text nodes were processed.
export async function parse(root: Node, showFurigana: boolean, opts: ParseOptions = {}): Promise<number> {
  if (paused) return 0;
  const nodes = collectTextNodes(root, opts.filter);
  // Sequential outer batches keep request size and rendered memory bounded. A
  // failed batch doesn't sink the rest.
  for (const batch of batchNodes(nodes)) {
    try {
      await parseBatch(batch, showFurigana);
    } catch (err) {
      console.warn("[Shirabe] parse failed for a batch:", err);
    }
  }
  return nodes.length;
}

// The active <video>'s current time in milliseconds, or null when the frame has
// no video: stamped onto caption cues (data-media-timestamp) so a mined card
// can deep-link back to the moment. Read once per caption pass, not per cue.
export function mediaTimestamp(): string | null {
  const video = document.querySelector("video");
  return video ? String(Math.round(video.currentTime * 1000)) : null;
}

/** True when `root` still has Japanese text outside our wraps. */
function hasUnparsedJapanese(root: Node, filter?: string): boolean {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => parseableTextNode(node, filter),
  });
  return walker.nextNode() != null;
}

// Atomic parse for short single-cue subtitle nodes (YouTube segments, asbplayer
// lines). Uses the full flattened source so nested progressive spans don't split
// mid-word, and re-runs whenever bare Japanese remains after a partial wrap.
// Netflix keeps the structure-preserving page parser instead.
//
// Read the source with `sourceText`, not raw `textContent`: once a cue is
// rendered with furigana on, our own `<rt>` readings live in the DOM and
// `textContent` folds them back in (考え → 考えかんがえ). YouTube streams a cue by
// appending to the same segment, so each growth trips the re-parse below: with
// raw textContent the leaked reading re-tokenizes as literal source and
// compounds on every update (考えかんがえかんがえかんがえた…). Stripping `<rt>`
// keeps the snapshot to the actual caption text.
export async function parseCaptionElement(root: HTMLElement, showFurigana: boolean): Promise<number> {
  if (paused) return 0;
  // Cheap tree-walk first: a fully-parsed cue just sitting on screen bails here
  // without paying the deep clone in `sourceText` on every streamed-cue tick.
  if (!hasUnparsedJapanese(root)) return 0;
  const snapshot = sourceText(root);
  if (!snapshot.trim() || !JAPANESE.test(snapshot)) return 0;

  try {
    const res = await send({ type: "parseBatch", texts: [snapshot] });
    if (!res.ok) throw new Error(res.error);
    if (res.dictionaryInstalling) throw new Error("The offline dictionary is still installing.");
    // Cue moved on while we looked words up: drop the stale result.
    if (!root.isConnected || sourceText(root) !== snapshot) return 0;
    const tokens = res.tokens[0] ?? [];
    reconcileCaption(root, buildWrapper(snapshot, tokens, showFurigana));
    queueStateRefresh(tokens);
    return 1;
  } catch (err) {
    console.warn("[Shirabe] caption parse failed:", err);
    return 0;
  }
}

// Mount a freshly built caption wrapper by reconciling against the one already
// on screen, not by replacing it wholesale. Streamed captions grow by re-parsing
// the whole line each cue (a late character can change a word boundary), but the
// leading run of words is usually identical: replacing everything re-rendered
// stable furigana on every frame, which read as a twitch. Keep the matching
// prefix mounted so only the growing tail (and its ruby) actually re-renders.
function reconcileCaption(root: HTMLElement, next: HTMLElement): void {
  const mounted = [...root.children].find(
    (child): child is HTMLElement => child instanceof HTMLElement && !!child.dataset[PARSED_FLAG],
  );
  if (!mounted) {
    root.replaceChildren(next);
    return;
  }

  const olds = [...mounted.childNodes];
  const news = [...next.childNodes];
  let i = 0;
  while (i < olds.length && i < news.length && sameRendered(olds[i], news[i])) {
    syncCaptionMining(olds[i], news[i]);
    i += 1;
  }
  for (let j = olds.length - 1; j >= i; j -= 1) olds[j].remove();
  for (let j = i; j < news.length; j += 1) mounted.append(news[j]);

  // Drop the raw text YouTube appended alongside the wrapper as it streamed.
  for (const sibling of [...root.childNodes]) if (sibling !== mounted) sibling.remove();
}

// Two rendered caption nodes are interchangeable when they read identically :
// same gap text, or same word surface and furigana. State colour (a className)
// is deliberately ignored so a word recoloured by a review stays put.
function sameRendered(a: Node, b: Node): boolean {
  if (a.nodeType !== b.nodeType) return false;
  if (a.nodeType === Node.TEXT_NODE) return a.nodeValue === b.nodeValue;
  return a instanceof HTMLElement && b instanceof HTMLElement
    && a.dataset.lemma === b.dataset.lemma
    && a.dataset.surface === b.dataset.surface
    && a.innerHTML === b.innerHTML;
}

// The sentence around a kept word grows as the cue streams, so refresh its
// mining offsets from the new render: a data-attribute write, no layout cost.
function syncCaptionMining(a: Node, b: Node): void {
  if (!(a instanceof HTMLElement) || !(b instanceof HTMLElement)) return;
  a.dataset.sentence = b.dataset.sentence ?? "";
  a.dataset.targetStart = b.dataset.targetStart ?? "";
  a.dataset.targetEnd = b.dataset.targetEnd ?? "";
}

// ── Lazy viewport parsing ─────────────────────────────────────────────────────
// Instead of parsing a whole page at once, discover its text blocks in idle
// slices and parse them only as they near the viewport.
const BLOCK_SELECTOR = "p,li,td,th,dd,dt,h1,h2,h3,h4,h5,h6,blockquote,figcaption,article,section,main,div";
const LAZY_BLOCK_FLAG = "sbBlock"; // dataset key marking a block already parsed

let io: IntersectionObserver | null = null;
let lazyShowFurigana = true;
let lazyOpts: ParseOptions = {};
const queuedBlocks = new Set<HTMLElement>();
const pendingBlocks = new Set<HTMLElement>();
const visibleBlocks = new Set<HTMLElement>();
// In-flight lazy batches, so a block that scrolls out of view can cancel the
// background lookups for its batch once none of the batch's blocks are visible.
let parseRequestSeq = 0;
const batchBlocks = new Map<number, Set<HTMLElement>>(); // requestId → the batch's blocks
const blockRequest = new Map<HTMLElement, number>(); // block → its in-flight requestId
const cancelledRequests = new Set<number>(); // requestIds we've told the worker to drop
let blockFlushFrame = 0;
const pendingStateLemmas = new Set<string>();
let stateRefreshFrame = 0;
let renderGeneration = 0;

// The block a text node belongs to: its nearest block-level ancestor (falling
// back to the immediate parent), so parsing is paragraph-grained, not all-or-nothing.
function ownerBlock(node: Node): Element | null {
  const parent = node.parentElement;
  return parent?.closest(BLOCK_SELECTOR) ?? parent ?? null;
}

// Discovery itself is incremental. The old implementation TreeWalked the whole
// article synchronously before IntersectionObserver could do anything, so a
// "lazy" parse still froze large documents at startup.
export function observeLazy(root: Node, showFurigana: boolean, opts: ParseOptions = {}): void {
  if (paused) return;
  lazyShowFurigana = showFurigana;
  lazyOpts = opts;
  if (!io) io = new IntersectionObserver(onIntersect, { rootMargin: "300px 0px" });
  observeViewportBlocks(root, opts.filter);
  discoverBlocks(root, opts.filter);
}

function observeViewportBlocks(root: Node, filter?: string): void {
  const xs = [window.innerWidth * 0.2, window.innerWidth * 0.5, window.innerWidth * 0.8];
  for (let y = 0; y < window.innerHeight; y += 120) {
    for (const x of xs) {
      for (const element of document.elementsFromPoint(x, y)) {
        const block = element.closest<HTMLElement>(BLOCK_SELECTOR);
        if (!block || !root.contains(block) || block.dataset[LAZY_BLOCK_FLAG] || (filter && block.closest(filter))) continue;
        if (JAPANESE.test(block.textContent ?? "")) io?.observe(block);
        break;
      }
    }
  }
}

function discoverBlocks(root: Node, filter?: string): void {
  const startedAt = performance.now();
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let done = false;
  let visited = 0;
  let observed = 0;
  const blocks = new Set<HTMLElement>();

  const work = (deadline?: IdleDeadline) => {
    if (paused || done) {
      if (done) recordPerformance("discover", startedAt, { nodes: visited, blocks: observed });
      return;
    }
    let slice = 0;
    while (slice < DISCOVERY_SLICE_NODES || (deadline?.timeRemaining() ?? 0) > 2) {
      const next = walker.nextNode();
      if (!next) {
        done = true;
        break;
      }
      if (parseableTextNode(next, filter) === NodeFilter.FILTER_ACCEPT) {
        const owner = ownerBlock(next);
        if (owner instanceof HTMLElement && !owner.dataset[LAZY_BLOCK_FLAG] && !blocks.has(owner)) {
          blocks.add(owner);
          io?.observe(owner);
          observed += 1;
        }
      }
      visited += 1;
      slice += 1;
    }
    if (!done) scheduleIdle(work);
    else recordPerformance("discover", startedAt, { nodes: visited, blocks: observed });
  };

  work();
}

function scheduleIdle(callback: (deadline?: IdleDeadline) => void): void {
  if ("requestIdleCallback" in window) {
    window.requestIdleCallback(callback, { timeout: 100 });
  } else {
    globalThis.setTimeout(() => callback(), 0);
  }
}

function onIntersect(entries: IntersectionObserverEntry[]): void {
  for (const entry of entries) {
    const block = entry.target as HTMLElement;
    if (entry.isIntersecting) {
      visibleBlocks.add(block);
      enterBlock(block);
    } else {
      visibleBlocks.delete(block);
      exitBlock(block);
    }
  }
}

function enterBlock(block: HTMLElement): void {
  if (paused || block.dataset[LAZY_BLOCK_FLAG] || pendingBlocks.has(block) || queuedBlocks.has(block)) return;
  queuedBlocks.add(block);
  if (!blockFlushFrame) blockFlushFrame = requestAnimationFrame(() => void flushQueuedBlocks());
}

function exitBlock(block: HTMLElement): void {
  queuedBlocks.delete(block);
  // If the block's batch is still in flight and none of its blocks are visible
  // any more, cancel the remaining background lookups: nothing on screen needs
  // them, and they'll re-parse if the reader scrolls back.
  const requestId = blockRequest.get(block);
  if (requestId === undefined || cancelledRequests.has(requestId)) return;
  const members = batchBlocks.get(requestId);
  if (members && ![...members].some((member) => visibleBlocks.has(member))) {
    cancelledRequests.add(requestId);
    void send({ type: "cancelParse", requestId }).catch(() => undefined);
  }
}

export function setParsingPaused(value: boolean): void {
  paused = value;
  if (!value) {
    for (const block of visibleBlocks) enterBlock(block);
    return;
  }
  queuedBlocks.clear();
  cancelAnimationFrame(blockFlushFrame);
  blockFlushFrame = 0;
}

// The element's text as it reads on the page: our injected `<rt>` furigana
// readings stripped out, so re-parsing never mistakes a reading for source.
function sourceText(element: HTMLElement): string {
  const clone = element.cloneNode(true) as HTMLElement;
  for (const reading of clone.querySelectorAll("rt")) reading.remove();
  return clone.textContent ?? "";
}

type PreparedBlock = { block: HTMLElement; nodes: Text[]; starts: number[]; text: string };

function prepareBlock(block: HTMLElement): PreparedBlock | null {
  const nodes = collectFragmentTextNodes(block, lazyOpts.filter).filter((node) => ownerBlock(node) === block);
  if (!nodes.length) return null;
  const starts: number[] = [];
  let text = "";
  for (const node of nodes) {
    starts.push(text.length);
    text += node.nodeValue ?? "";
  }
  return { block, nodes, starts, text };
}

async function flushQueuedBlocks(): Promise<void> {
  blockFlushFrame = 0;
  const prepared = [...queuedBlocks]
    .filter((block) => block.isConnected && visibleBlocks.has(block) && !block.dataset[LAZY_BLOCK_FLAG])
    .map(prepareBlock)
    .filter((block): block is PreparedBlock => !!block);
  queuedBlocks.clear();

  let batch: PreparedBlock[] = [];
  let chars = 0;
  for (const block of prepared) {
    if (batch.length && chars + block.text.length > BATCH_CHARS) {
      runBlockBatch(batch);
      batch = [];
      chars = 0;
    }
    batch.push(block);
    chars += block.text.length;
  }
  if (batch.length) runBlockBatch(batch);
}

function runBlockBatch(blocks: PreparedBlock[]): void {
  void parseBlockBatch(blocks).catch((error) => {
    console.warn("[Shirabe] lazy parse failed:", error);
    scheduleBlockRetry(blocks, 250);
  });
}

function scheduleBlockRetry(blocks: PreparedBlock[], delay: number): void {
  window.setTimeout(() => {
    for (const item of blocks) {
      if (visibleBlocks.has(item.block)) enterBlock(item.block);
    }
  }, delay);
}

async function parseBlockBatch(blocks: PreparedBlock[]): Promise<void> {
  const requestId = ++parseRequestSeq;
  batchBlocks.set(requestId, new Set(blocks.map((item) => item.block)));
  for (const item of blocks) {
    pendingBlocks.add(item.block);
    blockRequest.set(item.block, requestId);
  }
  const startedAt = performance.now();
  const generation = renderGeneration;
  try {
    const response = await send({ type: "parseBatch", texts: blocks.map((item) => item.text), requestId });
    if (!response.ok) throw new Error(response.error);
    if (response.dictionaryInstalling) {
      scheduleBlockRetry(blocks, 2_000);
      return;
    }
    // Reverted (full page revert) or fully cancelled (whole batch scrolled off).
    if (generation !== renderGeneration || cancelledRequests.has(requestId)) return;
    blocks.forEach((item, blockIndex) => {
      // A block that scrolled out of view mid-flight is left observed (not flagged
      // parsed) so it re-parses if the reader scrolls back: no wasted render now.
      if (!item.block.isConnected || !visibleBlocks.has(item.block)) return;
      const tokens = response.tokens[blockIndex] ?? [];
      const replacements = item.nodes.map((node, index) =>
        mappedWrapper(node.nodeValue ?? "", item.starts[index], item.text, tokens, lazyShowFurigana));
      item.nodes.forEach((node, index) => {
        if (node.parentNode) node.parentNode.replaceChild(replacements[index], node);
      });
      item.block.dataset[LAZY_BLOCK_FLAG] = "1";
      io?.unobserve(item.block);
      queueStateRefresh(tokens);
    });
    recordPerformance("parse-render", startedAt, {
      blocks: blocks.length, chars: blocks.reduce((sum, item) => sum + item.text.length, 0),
    });
  } finally {
    for (const item of blocks) {
      pendingBlocks.delete(item.block);
      blockRequest.delete(item.block);
    }
    batchBlocks.delete(requestId);
    cancelledRequests.delete(requestId);
    // A block can scroll back into view while its batch is still in flight: the
    // intersection fires, but `enterBlock` ignores it because the block is still
    // pending. Once the batch settles (cancelled, reverted, or a block that was
    // off-screen at render time) nothing re-queues it, and IntersectionObserver
    // will not fire again for a block that is already intersecting: the paragraph
    // stays blank until the reader scrolls it out and back. Re-queue here instead.
    for (const item of blocks) {
      if (visibleBlocks.has(item.block) && !item.block.dataset[LAZY_BLOCK_FLAG]) enterBlock(item.block);
    }
  }
}

// Word-status sync is deliberately outside the parse critical path. A page can
// put many blocks into the viewport at once. Render first, collect all newly
// seen lemmas, then refresh their cached profile state in one request and
// recolour every occurrence already on the page.
function queueStateRefresh(tokens: ParsedToken[]): void {
  for (const token of tokens) {
    if (token.content) pendingStateLemmas.add(token.lemma);
  }
  if (!pendingStateLemmas.size || stateRefreshFrame) return;
  // All block parses that resolve during this paint join one state request.
  stateRefreshFrame = requestAnimationFrame(() => void refreshQueuedStates());
}

async function refreshQueuedStates(): Promise<void> {
  stateRefreshFrame = 0;
  const lemmas = [...pendingStateLemmas];
  pendingStateLemmas.clear();
  if (!lemmas.length) return;
  const startedAt = performance.now();
  const response = await send({ type: "states", lemmas });
  if (!response.ok) return;
  for (const [lemma, state] of Object.entries(response.states)) applyStateEverywhere(lemma, state);
  recordPerformance("highlight", startedAt, { lemmas: lemmas.length });
}

export async function refreshRenderedStates(): Promise<void> {
  const lemmas = [...new Set([...document.querySelectorAll<HTMLElement>(".sb-word[data-lemma]")]
    .map((word) => word.dataset.lemma)
    .filter((lemma): lemma is string => !!lemma))];
  if (!lemmas.length) return;
  const response = await send({ type: "states", lemmas });
  if (!response.ok) return;
  for (const [lemma, state] of Object.entries(response.states)) applyStateEverywhere(lemma, state);
}

function collectFragmentTextNodes(root: Node, filter?: string): Text[] {
  const nodes: Text[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!node.nodeValue) return NodeFilter.FILTER_REJECT;
      const parent = node.parentElement;
      if (!parent || SKIP_TAGS.has(parent.tagName) || parent.closest(ANNOTATION_SELECTOR) || parent.isContentEditable) return NodeFilter.FILTER_REJECT;
      if (parent.closest("[data-sb-parsed], .sb-word, .sb-popup")) return NodeFilter.FILTER_REJECT;
      if (filter && parent.closest(filter)) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  for (let node = walker.nextNode(); node; node = walker.nextNode()) nodes.push(node as Text);
  return nodes;
}

export function mappedWrapper(nodeText: string, nodeStart: number, context: string, tokens: ParsedToken[], showFurigana: boolean): HTMLElement {
  const wrapper = document.createElement("span");
  wrapper.dataset[PARSED_FLAG] = "1";
  // Off the CONTEXT, which is the whole paragraph these fragments belong to:
  // the sentence a fragment sits in may start in a text node before this one.
  const cuts = shownCuts(context, tokens);
  const nodeEnd = nodeStart + nodeText.length;
  let cursor = 0;
  for (const token of tokens) {
    const tokenEnd = token.start + token.length;
    const start = Math.max(token.start, nodeStart);
    const end = Math.min(tokenEnd, nodeEnd);
    if (start >= end) continue;
    const localStart = start - nodeStart;
    if (localStart > cursor) wrapper.append(nodeText.slice(cursor, localStart));
    const surface = nodeText.slice(localStart, end - nodeStart);
    // A token can straddle inline markup (`<b>日本</b>語`), leaving one fragment
    // per text node. The reading belongs to the whole word and cannot be split
    // across them, so rendering it on a fragment stamps the full にほんご over
    // 日本 *and* again over 語. Drop the furigana rather than show it twice.
    const clipped = surface.length !== token.length;
    const rendered = renderToken(
      { ...token, start: localStart, length: surface.length, surface, reading: clipped ? null : token.reading },
      showFurigana,
    );
    if (rendered instanceof HTMLElement) {
      // Fragments after the first are the same word continuing across inline
      // markup. They stay real words for lookup and state, but the page metrics
      // must not count one word as two occurrences.
      if (token.start < nodeStart) rendered.dataset.continuation = "1";
      const sentence = sentenceAt(context, token.start);
      rendered.dataset.sentence = sentence.text;
      rendered.dataset.targetStart = String(token.start - sentence.start);
      rendered.dataset.targetEnd = String(token.start - sentence.start + token.length);
      // The WHOLE token's surface, not this fragment's: a word split across
      // inline markup is one chip of the line, and the cut has to read as the
      // line does.
      recordShownCut(rendered, cuts.get(sentence.start), token.surface, token.start - sentence.start);
    }
    wrapper.append(rendered);
    cursor = end - nodeStart;
  }
  if (cursor < nodeText.length) wrapper.append(nodeText.slice(cursor));
  return wrapper;
}

const performanceTotals = new Map<string, { runs: number; totalMs: number; maxMs: number }>();

function recordPerformance(stage: string, startedAt: number, counts: Record<string, number>): void {
  const durationMs = performance.now() - startedAt;
  const prior = performanceTotals.get(stage) ?? { runs: 0, totalMs: 0, maxMs: 0 };
  const next = {
    runs: prior.runs + 1,
    totalMs: prior.totalMs + durationMs,
    maxMs: Math.max(prior.maxMs, durationMs),
  };
  performanceTotals.set(stage, next);
  if (durationMs < 50 && next.runs % 20 !== 0) return;
  console.debug("[Shirabe performance]", {
    stage,
    durationMs: Math.round(durationMs * 10) / 10,
    averageMs: Math.round((next.totalMs / next.runs) * 10) / 10,
    maxMs: Math.round(next.maxMs * 10) / 10,
    runs: next.runs,
    ...counts,
  });
}
