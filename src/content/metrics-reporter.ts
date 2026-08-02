import { send } from "../common/messages.js";
import { EMPTY_METRICS, iPlusOneTargets, PageMetricIndex, type IPlusOneOptions } from "./page-metrics.js";

// How much of the open page the reader can already read. Nothing here draws:
// the numbers go to the background, which puts the coverage percentage on the
// toolbar badge and hands the detail to the action popup. What this module does
// paint is the i+1 cue: the sentences one new word away from being readable.
//
// There used to be an on-page bar showing the same counts inline (and Pause /
// Reparse / Revert buttons beside them). It's parked, not deleted: see
// docs/specs/browser-extension.md § Post-MVP.
let running = false;
let timer: number | undefined;
let options: IPlusOneOptions = { includesLearning: true, frequencyMax: 10_000 };
let metricIndex = new PageMetricIndex();
let metricObserver: MutationObserver | null = null;
const dirtyBlocks = new Set<HTMLElement>();

export function setMetricsOptions(next: IPlusOneOptions): void {
  options = next;
  dirtyBlocks.clear();
  refreshMetrics();
}

export function startMetrics(): void {
  running = true;
  startMetricIndex();
  refresh();
}

export function refreshMetrics(): void {
  window.clearTimeout(timer);
  timer = window.setTimeout(refresh, 80);
}

export function stopMetrics(): void {
  window.clearTimeout(timer);
  clearIPlusOne();
  running = false;
  stopMetricIndex();
  void send({ type: "pageMetrics", metrics: EMPTY_METRICS }).catch(() => undefined);
}

function refresh(): void {
  if (!running) return;
  const startedAt = performance.now();
  const metrics = { ...metricIndex.metrics(), iPlusOne: markIPlusOne() };
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
  for (const word of document.querySelectorAll(".sb-i-plus-one-word")) word.classList.remove("sb-i-plus-one-word");
}

// Toggles the cue on changed blocks, then counts every marked block on the page
//: a whole-page count stays right no matter which blocks this pass touched.
function markIPlusOne(): number {
  const blocks = dirtyBlocks.size
    ? [...dirtyBlocks]
    : [...document.querySelectorAll<HTMLElement>(BLOCK_SELECTOR)];
  dirtyBlocks.clear();
  for (const block of blocks) {
    if (!block.isConnected) continue;
    // Only the words this block owns. `querySelectorAll` is a deep query, so a
    // `<blockquote><p>` pair would otherwise both see the same sentence: two
    // cues and a doubled count: and `markDirty` only ever reaches the inner
    // one, so the outer cue would never be cleared again. Matching on the
    // word's own closest block also keeps a blockquote that mixes direct text
    // with a nested paragraph counting its own half.
    const owned = [...block.querySelectorAll<HTMLElement>(".sb-word")].filter((word) => word.closest(BLOCK_SELECTOR) === block);
    const words = owned.filter((word) => !word.dataset.continuation);
    if (!words.length) {
      block.classList.remove("sb-i-plus-one");
      continue;
    }
    const targets = iPlusOneTargets(words, options);
    block.classList.toggle("sb-i-plus-one", targets.length > 0);
    // A word split across inline markup renders as several spans, and only the
    // head is a target: cue by lemma so the highlight covers the whole word.
    const lemma = targets[0]?.dataset.lemma;
    for (const word of owned) word.classList.toggle("sb-i-plus-one-word", lemma != null && word.dataset.lemma === lemma);
  }
  return document.querySelectorAll(".sb-i-plus-one").length;
}

function startMetricIndex(): void {
  if (metricObserver) return;
  metricIndex = new PageMetricIndex();
  for (const word of document.querySelectorAll<HTMLElement>(WORD_SELECTOR)) metricIndex.update(word);
  metricObserver = new MutationObserver((records) => {
    for (const record of records) {
      if (record.target instanceof Element && record.target.closest(".sb-popup, .sb-host")) continue;
      if (record.type === "attributes" && record.target instanceof HTMLElement) {
        // Only our own words. Plenty of component libraries drive their widgets
        // with `data-state="open"`, and the removal path below is `.sb-word`-only,
        // so anything else counted as a phantom unknown word and never left the
        // index: inflating the totals and retaining the detached node with it.
        if (!record.target.matches(WORD_SELECTOR)) continue;
        metricIndex.update(record.target);
        markDirty(record.target);
        continue;
      }
      for (const node of record.addedNodes) visitWords(node, (word) => metricIndex.update(word));
      for (const node of record.removedNodes) visitWords(node, (word) => metricIndex.remove(word));
      if (record.target instanceof HTMLElement) markDirty(record.target);
    }
    refreshMetrics();
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
