import corpus from "./resources/context-hints.json";

const contexts: Readonly<Record<string, Readonly<Record<string, number>>>> = corpus.counts;

export function contextCounts(prefix: string): Readonly<Record<string, number>> {
  return contexts[prefix] ?? {};
}

export function chooseContextHint(counts: Readonly<Record<string, number>>, candidates: readonly string[]): string | null {
  if (!Object.values(counts).every((count) => Number.isSafeInteger(count) && count >= 0)) return null;
  const support = new Map(Object.entries(counts));
  const ranked = [...new Set(candidates)].map((id) => ({ id, count: support.get(id) ?? 0 }))
    .sort((a, b) => b.count - a.count || a.id.localeCompare(b.id));
  const winner = ranked[0];
  if (!winner || winner.count < 5 || winner.count < 2 * (ranked[1]?.count ?? 0)) return null;
  return winner.id;
}
