import { send } from "../common/messages.js";
import type { ParsedToken } from "../common/types.js";
import { renderToken } from "./word.js";

const JAPANESE = /[぀-ヿ一-龯㐀-䶿ｦ-ﾟ]/;
const SKIP_TAGS = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEXTAREA", "INPUT", "CODE", "PRE", "RUBY", "RT", "RP"]);
const PARSED_FLAG = "sbParsed"; // dataset key on the wrapper we insert
let paused = false;

// One /v1/parse request covers many text nodes at once: we send their text as a
// `texts[]` array (capped at this many combined chars) and the server returns one
// token list per node — offsets already rebased — over a shared vocab pool. Turns
// a page's hundreds of nodes into a handful of requests (JitenReader style).
const BATCH_CHARS = 8000;

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
    acceptNode(node) {
      const text = node.nodeValue;
      if (!text || !JAPANESE.test(text)) return NodeFilter.FILTER_REJECT;

      const parent = node.parentElement;
      if (!parent) return NodeFilter.FILTER_REJECT;
      if (SKIP_TAGS.has(parent.tagName)) return NodeFilter.FILTER_REJECT;
      if (parent.isContentEditable) return NodeFilter.FILTER_REJECT;
      if (parent.closest("[data-sb-parsed], .sb-word, .sb-popup")) return NodeFilter.FILTER_REJECT;
      if (filter && parent.closest(filter)) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });

  for (let n = walker.nextNode(); n; n = walker.nextNode()) nodes.push(n as Text);
  return nodes;
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

// Parse a batch of nodes in one request. The server returns one token list per
// node (index-aligned, offsets rebased), so we just wrap each node with its list.
// A requestId makes the request abortable (lazy parsing cancels off-screen work).
async function parseBatch(nodes: Text[], showFurigana: boolean, requestId?: number): Promise<void> {
  const res = await send({ type: "parseBatch", texts: nodes.map((node) => node.nodeValue ?? ""), requestId });
  if (!res.ok) throw new Error(res.error);

  res.tokens.forEach((tokens, i) => {
    const node = nodes[i];
    if (!node?.parentNode) return; // removed while we waited
    node.parentNode.replaceChild(buildWrapper(node.nodeValue ?? "", tokens, showFurigana), node);
  });
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
  // Sequential batches: the background worker rate-limits, and serial requests
  // keep memory flat on long pages. A failed batch doesn't sink the rest.
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
// Instead of parsing a whole page at once, observe its text blocks and parse each
// only as it nears the viewport; abort a block's request if it scrolls away
// before the tokens land. On a long page this parses just what's read and never
// bursts the server (JitenReader's model, trimmed).
const BLOCK_SELECTOR = "p,li,td,th,dd,dt,h1,h2,h3,h4,h5,h6,blockquote,figcaption,article,section,main,div";
const LAZY_BLOCK_FLAG = "sbBlock"; // dataset key marking a block already parsed

let io: IntersectionObserver | null = null;
let lazyShowFurigana = true;
let lazyOpts: ParseOptions = {};
const pendingBlocks = new Map<Element, number>(); // block → requestId while in flight
let nextRequestId = 1;

// The block a text node belongs to: its nearest block-level ancestor (falling
// back to the immediate parent), so parsing is paragraph-grained, not all-or-nothing.
function ownerBlock(node: Node): Element | null {
  const parent = node.parentElement;
  return parent?.closest(BLOCK_SELECTOR) ?? parent ?? null;
}

function collectBlocks(root: Node, filter?: string): Element[] {
  const blocks = new Set<Element>();
  for (const node of collectTextNodes(root, filter)) {
    const owner = ownerBlock(node);
    if (owner) blocks.add(owner);
  }
  return [...blocks];
}

// Observe every text block under `root`, parsing on approach. Reuses one shared
// IntersectionObserver so later calls (dynamic content) add to the same pool.
export function observeLazy(root: Node, showFurigana: boolean, opts: ParseOptions = {}): void {
  if (paused) return;
  lazyShowFurigana = showFurigana;
  lazyOpts = opts;
  if (!io) io = new IntersectionObserver(onIntersect, { rootMargin: "300px 0px" });
  for (const block of collectBlocks(root, opts.filter)) {
    if (block instanceof HTMLElement && !block.dataset[LAZY_BLOCK_FLAG]) io.observe(block);
  }
}

function onIntersect(entries: IntersectionObserverEntry[]): void {
  for (const entry of entries) {
    const block = entry.target as HTMLElement;
    if (entry.isIntersecting) void enterBlock(block);
    else exitBlock(block);
  }
}

async function enterBlock(block: HTMLElement): Promise<void> {
  if (paused || block.dataset[LAZY_BLOCK_FLAG] || pendingBlocks.has(block)) return;
  const requestId = nextRequestId++;
  pendingBlocks.set(block, requestId);
  try {
    await parseBlock(block, requestId);
    block.dataset[LAZY_BLOCK_FLAG] = "1";
    io?.unobserve(block);
  } catch {
    // Aborted (scrolled away) or a transient failure — leave it observed so it
    // retries the next time it comes into view.
  } finally {
    pendingBlocks.delete(block);
  }
}

function exitBlock(block: HTMLElement): void {
  const requestId = pendingBlocks.get(block);
  if (requestId != null) void send({ type: "abortParse", requestId });
}

export function setParsingPaused(value: boolean): void {
  paused = value;
  if (!value) return;
  for (const requestId of pendingBlocks.values()) void send({ type: "abortParse", requestId });
  pendingBlocks.clear();
}

export function revertParsedPage(): void {
  setParsingPaused(true);
  io?.disconnect();
  io = null;
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

// Parse just the text this block directly owns (nested blocks parse themselves
// when they scroll in), as one abortable request per block.
async function parseBlock(block: HTMLElement, requestId: number): Promise<void> {
  const nodes = collectFragmentTextNodes(block, lazyOpts.filter).filter((node) => ownerBlock(node) === block);
  if (!nodes.length) return;
  const starts: number[] = [];
  let text = "";
  for (const node of nodes) {
    starts.push(text.length);
    text += node.nodeValue ?? "";
  }
  const response = await send({ type: "parseBatch", texts: [text], requestId });
  if (!response.ok) throw new Error(response.error);
  const tokens = response.tokens[0] ?? [];
  const replacements = nodes.map((node, index) => mappedWrapper(node.nodeValue ?? "", starts[index], text, tokens, lazyShowFurigana));
  nodes.forEach((node, index) => {
    if (node.parentNode) node.parentNode.replaceChild(replacements[index], node);
  });
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
