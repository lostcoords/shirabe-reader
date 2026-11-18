import assert from "node:assert/strict";
import test from "node:test";
import { assertFixtureCovers, corpusTexts } from "./support/pack.js";

test("the committed fixture pack was cut for every text in the shared corpora", () => {
  assertFixtureCovers(corpusTexts());
});

test("a text the fixture pack was not cut for is refused rather than judged against missing entries", () => {
  assert.throws(() => assertFixtureCovers(["鬱蒼とした森"]), /not cut for \["鬱蒼とした森"\]/);
});
