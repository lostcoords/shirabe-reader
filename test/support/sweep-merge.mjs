// Folding one sweep shard's counters into the running total.
//
// Extracted from divergence-sweep.mjs to be testable. It is fifteen lines and it
// decides every number the sweep reports: a shard dropped, a rate averaged
// instead of summed, or a ranked list overwritten rather than combined all read
// as a finding rather than as a bug. The sweep is what tokenizer decisions get
// made on, so being able to prove the arithmetic is worth the extra file.
//
// Two kinds of field, and they fold differently:
//
//   counters     add. `lemmaOverlapSum` is a SUM over sentences precisely so it
//                can be added here and divided once at the end; averaging the
//                shards' percentages would weight a short shard like a long one.
//   ranked maps  merge by key, adding counts and keeping the first example seen.
//                A key can appear in every shard, and the whole point of the
//                list is how often, so the counts have to accumulate.
export const COUNTER_FIELDS = [
  "swept", "identical", "lemmaOverlapSum", "lemmaSentences", "bothAgreeFully",
  "aligned", "inside", "insideKanji", "straddle", "alignableRows", "spanTotal",
  "entryShared", "entryAgreed",
];

export const RANKED_FIELDS = ["entryConflicts", "lemmaConflicts", "shattered", "swallowed", "insideCases", "straddleCases"];

export function mergeShard(into, shard) {
  for (const key of COUNTER_FIELDS) into[key] = (into[key] ?? 0) + (shard[key] ?? 0);

  for (const key of RANKED_FIELDS) {
    const seen = new Map(into[key] ?? []);
    for (const [name, row] of shard[key] ?? []) {
      const current = seen.get(name);
      if (current) current.count += row.count;
      else seen.set(name, { ...row });
    }
    into[key] = [...seen];
  }
  return into;
}
