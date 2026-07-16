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
  for (const block of document.querySelectorAll(".sb-i-plus-one")) block.classList.remove("sb-i-plus-one");
  host?.remove();
  host = null;
  paused = false;
  stopMetricIndex();
  void send({ type: "pageMetrics", metrics: EMPTY_METRICS }).catch(() => undefined);
}

function refresh(): void {
  if (!host) return;
  const startedAt = performance.now();
  const metrics = metricIndex.metrics();
  const counts = metrics.occurrences;
  const summary = host.querySelector<HTMLElement>("[data-summary]");
  if (summary) summary.textContent = `${metrics.occurrenceCoverage}% occurrence / ${metrics.uniqueCoverage}% unique · ${counts.known} known · ${counts.learning} learning · ${counts.unknown} unknown${counts.due ? ` · ${counts.due} due` : ""}`;
  void send({ type: "pageMetrics", metrics }).catch(() => undefined);
  markIPlusOne();
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

function markIPlusOne(): void {
  const blocks = dirtyBlocks.size
    ? [...dirtyBlocks]
    : [...document.querySelectorAll<HTMLElement>("p,li,blockquote,figcaption")];
  dirtyBlocks.clear();
  for (const block of blocks) {
    if (!block.isConnected) continue;
    block.classList.toggle("sb-i-plus-one", isIPlusOne([...block.querySelectorAll<HTMLElement>(".sb-word")], options));
  }
}

function startMetricIndex(): void {
  if (metricObserver) return;
  metricIndex = new PageMetricIndex();
  for (const word of document.querySelectorAll<HTMLElement>(".sb-word")) metricIndex.update(word);
  metricObserver = new MutationObserver((records) => {
    for (const record of records) {
      if (record.target instanceof Element && record.target.closest(".sb-status-bar, .sb-popup, .sb-host")) continue;
      if (record.type === "attributes" && record.target instanceof HTMLElement) {
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
  if (node.matches(".sb-word")) visit(node as HTMLElement);
  for (const word of node.querySelectorAll<HTMLElement>(".sb-word")) visit(word);
}

function markDirty(element: HTMLElement): void {
  const block = element.closest<HTMLElement>("p,li,blockquote,figcaption");
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
    element.remove();
    host = null;
  });
  element.append(summary, pause, reparse, revert);
  document.documentElement.append(element);
  return element;
}
