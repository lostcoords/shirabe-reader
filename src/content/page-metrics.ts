import type { PageMetrics, StateCounts } from "../common/messages.js";
import type { WordState } from "../common/types.js";

export type { StateCounts };
export type DetailedPageMetrics = PageMetrics;
export type IPlusOneOptions = { includesLearning: boolean; frequencyMax: number };

const priority: Record<WordState, number> = { none: 0, new: 1, learning: 2, due: 3, known: 4 };

// A reverted page has no words: the same shape, all zero, so callers never
// special-case "parsed but empty" against "not parsed".
export const EMPTY_METRICS: DetailedPageMetrics = {
  occurrenceCoverage: 0, uniqueCoverage: 0, total: 0, unique: 0,
  occurrences: { known: 0, learning: 0, due: 0, unknown: 0 },
  uniques: { known: 0, learning: 0, due: 0, unknown: 0 },
};

type TrackedWord = { lemma: string; state: WordState };

export class PageMetricIndex {
  private tracked = new Map<HTMLElement, TrackedWord>();
  private occurrenceCounts = emptyCounts();
  private uniqueCounts = emptyCounts();
  private statesByLemma = new Map<string, Map<WordState, number>>();

  update(word: HTMLElement): void {
    const next = { lemma: lemmaOf(word), state: wordState(word) };
    const prior = this.tracked.get(word);
    if (prior?.lemma === next.lemma && prior.state === next.state) return;
    if (prior) this.removeValue(prior);
    this.tracked.set(word, next);
    this.addValue(next);
  }

  remove(word: HTMLElement): void {
    const prior = this.tracked.get(word);
    if (!prior) return;
    this.tracked.delete(word);
    this.removeValue(prior);
  }

  clear(): void {
    this.tracked.clear();
    this.statesByLemma.clear();
    this.occurrenceCounts = emptyCounts();
    this.uniqueCounts = emptyCounts();
  }

  metrics(): DetailedPageMetrics {
    return {
      occurrenceCoverage: coverage(this.occurrenceCounts, this.tracked.size),
      uniqueCoverage: coverage(this.uniqueCounts, this.statesByLemma.size),
      total: this.tracked.size,
      unique: this.statesByLemma.size,
      occurrences: { ...this.occurrenceCounts },
      uniques: { ...this.uniqueCounts },
    };
  }

  private addValue(word: TrackedWord): void {
    count(this.occurrenceCounts, word.state, 1);
    const states = this.statesByLemma.get(word.lemma) ?? new Map<WordState, number>();
    const prior = highestState(states);
    states.set(word.state, (states.get(word.state) ?? 0) + 1);
    this.statesByLemma.set(word.lemma, states);
    replaceUnique(this.uniqueCounts, prior, highestState(states));
  }

  private removeValue(word: TrackedWord): void {
    count(this.occurrenceCounts, word.state, -1);
    const states = this.statesByLemma.get(word.lemma);
    if (!states) return;
    const prior = highestState(states);
    const remaining = (states.get(word.state) ?? 0) - 1;
    if (remaining > 0) states.set(word.state, remaining);
    else states.delete(word.state);
    if (!states.size) this.statesByLemma.delete(word.lemma);
    replaceUnique(this.uniqueCounts, prior, highestState(states));
  }
}

export function measurePageWords(words: HTMLElement[]): DetailedPageMetrics {
  const occurrences = emptyCounts();
  const states = new Map<string, WordState>();
  for (const word of words) {
    const state = wordState(word);
    count(occurrences, state);
    const lemma = lemmaOf(word);
    const prior = states.get(lemma);
    if (!prior || priority[state] > priority[prior]) states.set(lemma, state);
  }

  const uniques = emptyCounts();
  for (const state of states.values()) count(uniques, state);
  return {
    occurrenceCoverage: coverage(occurrences, words.length),
    uniqueCoverage: coverage(uniques, states.size),
    total: words.length,
    unique: states.size,
    occurrences,
    uniques,
  };
}

export function isIPlusOne(words: HTMLElement[], options: IPlusOneOptions): boolean {
  const unknown = new Map<string, number | null>();
  for (const word of words) {
    const state = wordState(word);
    const learned = state === "known" || state === "due" || (options.includesLearning && (state === "new" || state === "learning"));
    if (learned) continue;
    const lemma = word.dataset.lemma || word.dataset.surface || word.textContent || "";
    const frequency = Number(word.dataset.frequency);
    unknown.set(lemma, Number.isFinite(frequency) && frequency > 0 ? frequency : null);
  }
  if (unknown.size !== 1) return false;
  const frequency = [...unknown.values()][0];
  return frequency == null || frequency <= options.frequencyMax;
}

function wordState(word: HTMLElement): WordState {
  const state = word.dataset.state;
  return state === "new" || state === "learning" || state === "due" || state === "known" ? state : "none";
}

function emptyCounts(): StateCounts {
  return { known: 0, learning: 0, due: 0, unknown: 0 };
}

function lemmaOf(word: HTMLElement): string {
  return word.dataset.lemma || word.dataset.surface || word.textContent || "";
}

function highestState(states: Map<WordState, number>): WordState | undefined {
  let highest: WordState | undefined;
  for (const [state, amount] of states) {
    if (amount > 0 && (!highest || priority[state] > priority[highest])) highest = state;
  }
  return highest;
}

function replaceUnique(counts: StateCounts, prior?: WordState, next?: WordState): void {
  if (prior === next) return;
  if (prior) count(counts, prior, -1);
  if (next) count(counts, next, 1);
}

function count(counts: StateCounts, state: WordState, by = 1): void {
  if (state === "known") counts.known += by;
  else if (state === "due") { counts.known += by; counts.due += by; }
  else if (state === "new" || state === "learning") counts.learning += by;
  else counts.unknown += by;
}

function coverage(counts: StateCounts, total: number): number {
  return total ? Math.round(((counts.known + counts.learning) / total) * 100) : 0;
}
