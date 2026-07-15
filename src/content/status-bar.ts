import { revertParsedPage, setParsingPaused } from "./parser.js";
import { send } from "../common/messages.js";
import { EMPTY_METRICS, isIPlusOne, measurePageWords, type IPlusOneOptions } from "./page-metrics.js";

let host: HTMLElement | null = null;
let paused = false;
let timer: number | undefined;
let options: IPlusOneOptions = { includesLearning: true, frequencyMax: 20_000 };

export function setStatusOptions(next: IPlusOneOptions): void {
  options = next;
  refreshStatusBar();
}

export function showStatusBar(onReparse: () => void): void {
  if (!host) host = build(onReparse);
  refresh();
}

export function refreshStatusBar(): void {
  window.clearTimeout(timer);
  timer = window.setTimeout(refresh, 80);
}

function refresh(): void {
  if (!host) return;
  const words = [...document.querySelectorAll<HTMLElement>(".sb-word")];
  const metrics = measurePageWords(words);
  const counts = metrics.occurrences;
  const summary = host.querySelector<HTMLElement>("[data-summary]");
  if (summary) summary.textContent = `${metrics.occurrenceCoverage}% occurrence / ${metrics.uniqueCoverage}% unique · ${counts.known} known · ${counts.learning} learning · ${counts.unknown} unknown${counts.due ? ` · ${counts.due} due` : ""}`;
  void send({ type: "pageMetrics", metrics }).catch(() => undefined);
  markIPlusOne();
}

function markIPlusOne(): void {
  for (const block of document.querySelectorAll<HTMLElement>("p,li,blockquote,figcaption")) {
    block.classList.toggle("sb-i-plus-one", isIPlusOne([...block.querySelectorAll<HTMLElement>(".sb-word")], options));
  }
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
    element.remove();
    host = null;
  });
  element.append(summary, pause, reparse, revert);
  document.documentElement.append(element);
  return element;
}
