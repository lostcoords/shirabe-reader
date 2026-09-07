import assert from "node:assert/strict";
import test from "node:test";
import cases from "./fixtures/context-hints.json";
import { chooseContextHint } from "../src/common/context-hints.js";

for (const row of cases) {
  test(`context hint: ${row.name}`, () => {
    const counts = structuredClone(row.counts) as Record<string, number>;
    const candidates = [...row.candidates];
    assert.equal(chooseContextHint(counts, candidates), row.expected);
    assert.deepEqual(counts, row.counts);
    assert.deepEqual(candidates, row.candidates);
  });
}
