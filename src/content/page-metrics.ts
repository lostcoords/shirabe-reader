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

export function measurePageWords(words: HTMLElement[]): DetailedPageMetrics {
  const occurrences = emptyCounts();
  const states = new Map<string, WordState>();
  for (const word of words) {
    const state = wordState(word);
    count(occurrences, state);
    const lemma = word.dataset.lemma || word.dataset.surface || word.textContent || "";
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

function count(counts: StateCounts, state: WordState): void {
  if (state === "known") counts.known += 1;
  else if (state === "due") { counts.known += 1; counts.due += 1; }
  else if (state === "new" || state === "learning") counts.learning += 1;
  else counts.unknown += 1;
}

function coverage(counts: StateCounts, total: number): number {
  return total ? Math.round(((counts.known + counts.learning) / total) * 100) : 0;
}
