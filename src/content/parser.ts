import { send } from "../common/messages.js";
import type { ParsedToken } from "../common/types.js";
import { applyStateEverywhere, renderToken } from "./word.js";

const JAPANESE = /[぀-ヿ一-龯㐀-䶿ｦ-ﾟ]/;
const SKIP_TAGS = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEXTAREA", "INPUT", "CODE", "PRE", "RUBY", "RT", "RP"]);
const PARSED_FLAG = "sbParsed"; // dataset key on the wrapper we insert
let paused = false;

// One background message covers many text nodes at once. The local worker
// returns one token list per input, preserving offsets and keeping message and
// IndexedDB overhead bounded.
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
// the network — we only ever /parse Japanese text.
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
  if (parent.closest("[data-sb-parsed], .sb-word, .sb-popup")) return NodeFilter.FILTER_REJECT;
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

// Rebuild one text node as tokenized, word-wrapped DOM (gaps kept as plain text).
function buildWrapper(text: string, tokens: ParsedToken[], showFurigana: boolean): HTMLElement {
  const wrapper = document.createElement("span");
  wrapper.dataset[PARSED_FLAG] = "1";
  let cursor = 0;
  for (const token of tokens) {
    if (token.start > cursor) wrapper.append(text.slice(cursor, token.start));
    const rendered = renderToken(token, showFurigana);
    if (rendered instanceof HTMLElement) {
      const sentence = sentenceAt(text, token.start);
      rendered.dataset.sentence = sentence.text;
      rendered.dataset.targetStart = String(token.start - sentence.start);
      rendered.dataset.targetEnd = String(token.start - sentence.start + token.length);
    }
    wrapper.append(rendered);
    cursor = token.start + token.length;
  }
  if (cursor < text.length) wrapper.append(text.slice(cursor));
  return wrapper;
}

function sentenceAt(text: string, offset: number): { text: string; start: number } {
  let start = offset;
  let end = offset;
  const boundary = /[。！？!?\n]/;
  while (start > 0 && !boundary.test(text[start - 1])) start -= 1;
  while (end < text.length && !boundary.test(text[end])) end += 1;
  const raw = text.slice(start, Math.min(text.length, end + 1));
  const leading = raw.length - raw.trimStart().length;
  return { text: raw.trim(), start: start + leading };
}

// Parse everything under `root` eagerly (used for a selection, where the user
// wants it now). Returns how many text nodes were processed.
export async function parse(root: Node, showFurigana: boolean, opts: ParseOptions = {}): Promise<number> {
  if (paused) return 0;
  const nodes = collectTextNodes(root, opts.filter);
  // Sequential outer batches keep memory flat; each batch uses bounded
  // concurrency inside the local worker. A failed batch doesn't sink the rest.
  for (const batch of batchNodes(nodes)) {
    try {
      await parseBatch(batch, showFurigana);
    } catch (err) {
      console.warn("[Shirabe] parse failed for a batch:", err);
    }
  }
  return nodes.length;
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

export function revertParsedPage(): void {
  renderGeneration += 1;
  setParsingPaused(true);
  io?.disconnect();
  io = null;
  visibleBlocks.clear();
  queuedBlocks.clear();
  for (const wrapper of document.querySelectorAll<HTMLElement>("[data-sb-parsed]")) {
    wrapper.replaceWith(document.createTextNode(visibleSource(wrapper)));
  }
  for (const block of document.querySelectorAll<HTMLElement>("[data-sb-block]")) delete block.dataset[LAZY_BLOCK_FLAG];
}

function visibleSource(wrapper: HTMLElement): string {
  const clone = wrapper.cloneNode(true) as HTMLElement;
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
  for (const item of blocks) pendingBlocks.add(item.block);
  const startedAt = performance.now();
  const generation = renderGeneration;
  try {
    const response = await send({ type: "parseBatch", texts: blocks.map((item) => item.text) });
    if (!response.ok) throw new Error(response.error);
    if (response.dictionaryInstalling) {
      scheduleBlockRetry(blocks, 2_000);
      return;
    }
    if (generation !== renderGeneration) return;
    blocks.forEach((item, blockIndex) => {
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
    for (const item of blocks) pendingBlocks.delete(item.block);
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
      if (!parent || SKIP_TAGS.has(parent.tagName) || parent.closest("ruby") || parent.isContentEditable) return NodeFilter.FILTER_REJECT;
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
    const rendered = renderToken({ ...token, start: localStart, length: surface.length, surface }, showFurigana);
    if (rendered instanceof HTMLElement) {
      const sentence = sentenceAt(context, token.start);
      rendered.dataset.sentence = sentence.text;
      rendered.dataset.targetStart = String(token.start - sentence.start);
      rendered.dataset.targetEnd = String(token.start - sentence.start + token.length);
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
