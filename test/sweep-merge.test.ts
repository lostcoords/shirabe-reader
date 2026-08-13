import assert from "node:assert/strict";
import test from "node:test";
// @ts-expect-error plain ESM helper shared with the sweep driver, no types needed
import { COUNTER_FIELDS, mergeShard } from "./support/sweep-merge.mjs";

// The sweep runs one process per core and sums their answers here. Nothing else
// checks that arithmetic, and a mistake in it does not look like a mistake: a
// dropped shard reads as a smaller corpus, a lost ranked entry reads as a rarer
// divergence, and both read as findings rather than as bugs. These numbers are
// what tokenizer decisions get made on.

const shard = (over: Record<string, unknown> = {}) => ({
  swept: 10, identical: 6, lemmaOverlapSum: 9, lemmaSentences: 10, bothAgreeFully: 7,
  aligned: 90, inside: 8, insideKanji: 5, straddle: 2, alignableRows: 10, spanTotal: 100,
  entryShared: 50, entryAgreed: 45,
  // Ranked rows are `[key, {count, example}]` pairs; typed loosely because the
  // merge is a plain ESM helper the sweep driver shares and carries no types.
  entryConflicts: [] as any[], lemmaConflicts: [] as any[], shattered: [] as any[], swallowed: [] as any[],
  insideCases: [] as any[], straddleCases: [] as any[],
  ...over,
});

// The merge folds shards into an empty object, so the seed has to be named as a
// total rather than inferred as `{}`: without it every counter the tests read is
// a property TypeScript has never heard of.
type Totals = ReturnType<typeof shard> & Record<string, any>;
const merge = (...shards: Totals[]): Totals => shards.reduce(mergeShard, {} as Totals);

test("shard counters add rather than average", () => {
  const total = merge(shard(), shard(), shard());

  assert.equal(total.swept, 30);
  assert.equal(total.spanTotal, 300);
  assert.equal(total.entryShared, 150);
  // A SUM over sentences, divided once at the end. Averaging each shard's
  // percentage here would weight a short shard exactly like a long one.
  assert.equal(total.lemmaOverlapSum, 27);
});

test("every counter the report reads is folded", () => {
  const total = merge(shard(), shard());

  for (const field of COUNTER_FIELDS) {
    assert.equal(typeof total[field], "number", `${field} was not merged`);
  }
});

test("a ranked entry seen by several shards accumulates its count", () => {
  const a = shard({ lemmaConflicts: [["すみません  web=すむ  ext=すみません", { count: 3, example: "A" }]] });
  const b = shard({ lemmaConflicts: [["すみません  web=すむ  ext=すみません", { count: 4, example: "B" }]] });

  const total = merge(a, b);

  assert.equal(total.lemmaConflicts.length, 1, "the same key from two shards is one row");
  assert.equal(total.lemmaConflicts[0][1].count, 7, "and its counts add: this is the whole ranking");
});

test("keys unique to one shard survive the merge", () => {
  const a = shard({ entryConflicts: [["こと", { count: 2, example: "A" }]] });
  const b = shard({ entryConflicts: [["明日", { count: 5, example: "B" }]] });

  const total = merge(a, b);

  assert.deepEqual(new Set(total.entryConflicts.map(([key]: [string]) => key)), new Set(["こと", "明日"]));
});

// The first shard folds into an empty object, so every field has to cope with
// nothing on the left. It ran that way in production from the first line.
test("merging into an empty total is the ordinary first step", () => {
  const total: Totals = mergeShard({}, shard({ shattered: [["わけ", { count: 1, example: "X" }]] }));

  assert.equal(total.swept, 10);
  assert.equal(total.shattered.length, 1);
});
