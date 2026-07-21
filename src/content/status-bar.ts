import { revertParsedPage, setParsingPaused } from "./parser.js";
import { send } from "../common/messages.js";
import { EMPTY_METRICS, isIPlusOne, PageMetricIndex, type IPlusOneOptions } from "./page-metrics.js";

let host: HTMLElement | null = null;
let paused = false;
let timer: number | undefined;
let options: IPlusOneOptions = { includesLearning: true, frequencyMax: 20_000 };
let metricIndex = new PageMetricIndex();
let metricObserver: MutationObserver | null = null;
const dirtyBlocks = new Set<HTMLElement>();

// The bar owns the pause state; a config change must not silently resume behind
// the user's back and leave the button reading "Resume" while parsing runs.
export const statusPaused = (): boolean => paused;

export function setStatusOptions(next: IPlusOneOptions): void {
  options = next;
  dirtyBlocks.clear();
  refreshStatusBar();
}

export function showStatusBar(onReparse: () => void): void {
  if (!host) host = build(onReparse);
  startMetricIndex();
  refresh();
}

export function refreshStatusBar(): void {
  window.clearTimeout(timer);
  timer = window.setTimeout(refresh, 80);
}

export function hideStatusBar(): void {
  window.clearTimeout(timer);
  clearIPlusOne();
  host?.remove();
  host = null;
  paused = false;
  stopMetricIndex();
  void send({ type: "pageMetrics", metrics: EMPTY_METRICS }).catch(() => undefined);
}

function refresh(): void {
  if (!host) return;
  const startedAt = performance.now();
  const metrics = { ...metricIndex.metrics(), iPlusOne: markIPlusOne() };
  const counts = metrics.occurrences;
  const summary = host.querySelector<HTMLElement>("[data-summary]");
  if (summary) summary.textContent = `${metrics.occurrenceCoverage}% occurrence / ${metrics.uniqueCoverage}% unique · ${counts.known} known · ${counts.learning} learning · ${counts.unknown} unknown${counts.due ? ` · ${counts.due} due` : ""}${metrics.iPlusOne ? ` · ${metrics.iPlusOne} i+1` : ""}`;
  void send({ type: "pageMetrics", metrics }).catch(() => undefined);
  const durationMs = performance.now() - startedAt;
  if (durationMs >= 16) {
    console.debug("[Shirabe performance]", {
      stage: "metrics",
      durationMs: Math.round(durationMs * 10) / 10,
      words: metrics.total,
      unique: metrics.unique,
    });
  }
}

const BLOCK_SELECTOR = "p,li,blockquote,figcaption";
// One word split across inline markup renders as several spans; only the head
// counts, or a `<b>日本</b>語` inflates every total by one.
const WORD_SELECTOR = ".sb-word:not([data-continuation])";

function clearIPlusOne(): void {
  for (const block of document.querySelectorAll(".sb-i-plus-one")) block.classList.remove("sb-i-plus-one");
}

// Toggles the cue on changed blocks, then counts every marked block on the page
// — a whole-page count stays right no matter which blocks this pass touched.
function markIPlusOne(): number {
  const blocks = dirtyBlocks.size
    ? [...dirtyBlocks]
    : [...document.querySelectorAll<HTMLElement>(BLOCK_SELECTOR)];
  dirtyBlocks.clear();
  for (const block of blocks) {
    if (!block.isConnected) continue;
    // Only the words this block owns. `querySelectorAll` is a deep query, so a
    // `<blockquote><p>` pair would otherwise both see the same sentence — two
    // badges and a doubled count — and `markDirty` only ever reaches the inner
    // one, so the outer badge would never be cleared again. Matching on the
    // word's own closest block also keeps a blockquote that mixes direct text
    // with a nested paragraph counting its own half.
    const words = [...block.querySelectorAll<HTMLElement>(WORD_SELECTOR)].filter((word) => word.closest(BLOCK_SELECTOR) === block);
    if (!words.length) {
      block.classList.remove("sb-i-plus-one");
      continue;
    }
    block.classList.toggle("sb-i-plus-one", isIPlusOne(words, options));
  }
  return document.querySelectorAll(".sb-i-plus-one").length;
}

function startMetricIndex(): void {
  if (metricObserver) return;
  metricIndex = new PageMetricIndex();
  for (const word of document.querySelectorAll<HTMLElement>(WORD_SELECTOR)) metricIndex.update(word);
  metricObserver = new MutationObserver((records) => {
    for (const record of records) {
      if (record.target instanceof Element && record.target.closest(".sb-status-bar, .sb-popup, .sb-host")) continue;
      if (record.type === "attributes" && record.target instanceof HTMLElement) {
        // Only our own words. Plenty of component libraries drive their widgets
        // with `data-state="open"`, and the removal path below is `.sb-word`-only,
        // so anything else counted as a phantom unknown word and never left the
        // index — inflating the totals and retaining the detached node with it.
        if (!record.target.matches(WORD_SELECTOR)) continue;
        metricIndex.update(record.target);
        markDirty(record.target);
        continue;
      }
      for (const node of record.addedNodes) visitWords(node, (word) => metricIndex.update(word));
      for (const node of record.removedNodes) visitWords(node, (word) => metricIndex.remove(word));
      if (record.target instanceof HTMLElement) markDirty(record.target);
    }
    refreshStatusBar();
  });
  metricObserver.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["data-state"] });
}

function stopMetricIndex(): void {
  metricObserver?.disconnect();
  metricObserver = null;
  metricIndex.clear();
  dirtyBlocks.clear();
}

function visitWords(node: Node, visit: (word: HTMLElement) => void): void {
  if (!(node instanceof Element)) return;
  if (node.matches(WORD_SELECTOR)) visit(node as HTMLElement);
  for (const word of node.querySelectorAll<HTMLElement>(WORD_SELECTOR)) visit(word);
}

function markDirty(element: HTMLElement): void {
  const block = element.closest<HTMLElement>(BLOCK_SELECTOR);
  if (block) dirtyBlocks.add(block);
}

function build(onReparse: () => void): HTMLElement {
  const element = document.createElement("div");
  element.className = "sb-status-bar";
  const summary = document.createElement("span");
  summary.dataset.summary = "";
  const pause = document.createElement("button");
  pause.textContent = "Pause";
  pause.addEventListener("click", () => {
    paused = !paused;
    setParsingPaused(paused);
    pause.textContent = paused ? "Resume" : "Pause";
    if (!paused) onReparse();
  });
  const reparse = document.createElement("button");
  reparse.textContent = "Reparse";
  reparse.addEventListener("click", onReparse);
  const revert = document.createElement("button");
  revert.textContent = "Revert";
  revert.addEventListener("click", () => {
    revertParsedPage();
    void send({ type: "pageMetrics", metrics: EMPTY_METRICS }).catch(() => undefined);
    stopMetricIndex();
    clearIPlusOne(); // the tint and the "i+1" badge outlive the words otherwise
    element.remove();
    host = null;
    paused = false;
  });
  element.append(summary, pause, reparse, revert);
  document.documentElement.append(element);
  return element;
}
