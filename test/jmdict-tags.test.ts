import assert from "node:assert/strict";
import test from "node:test";
import { posChips, posLabel, tagChips, tagLabel } from "../src/common/jmdict-tags.js";

test("posLabel maps JMdict codes to the same short labels as the site", () => {
  assert.equal(posLabel("v5r"), "Godan verb");
  assert.equal(posLabel("v5r-i"), "Godan verb");
  assert.equal(posLabel("v1"), "Ichidan verb");
  assert.equal(posLabel("vi"), "Intransitive verb");
  assert.equal(posLabel("vt"), "Transitive verb");
  assert.equal(posLabel("n"), "Noun");
  assert.equal(posLabel("adj-i"), "I-adjective");
  assert.equal(posLabel("adj-na"), "Na-adjective");
  assert.equal(posLabel("vs-i"), "Suru verb");
  assert.equal(posLabel("exp"), "Expression");
});

test("posLabel prefers curated short form over verbose JMdict entity strings", () => {
  assert.equal(
    posLabel("v5r", "Godan verb with 'ru' ending"),
    "Godan verb",
  );
  assert.equal(
    posLabel("n", "noun (common) (futsuumeishi)"),
    "Noun",
  );
});

test("posLabel falls back by stripping parentheticals on unknown codes", () => {
  assert.equal(posLabel("xyz", "some rare tag (note)"), "Some rare tag");
  assert.equal(posLabel("unknown-code"), "unknown-code");
});

// De-duped by LABEL, not by code: JMdict splits finer than a reader can tell
// apart, and drawing "Godan verb" twice says nothing the second time.
test("posChips de-dupe collapsed verb classes, keeping the code that named each", () => {
  assert.deepEqual(posChips(["v5r", "vi"]).map((chip) => chip.label), ["Godan verb", "Intransitive verb"]);
  assert.deepEqual(posChips(["v5r", "v5r-i", "vi"]).map((chip) => chip.label), ["Godan verb", "Intransitive verb"]);
  assert.deepEqual(posChips(["v5r"]), [{ label: "Godan verb", code: "v5r", category: "pos" }]);
});

test("tagLabel maps common misc codes", () => {
  assert.equal(tagLabel("uk"), "Usually kana");
  assert.equal(tagLabel("yoji"), "Yojijukugo");
  assert.equal(tagLabel("col"), "Colloquial");
  assert.equal(tagLabel("weird-code"), "weird-code");
  assert.equal(tagLabel("uk", "word usually written using kana alone"), "Usually kana");
});

test("tagChips de-dupe in order", () => {
  assert.deepEqual(tagChips({ misc: ["uk", "col", "uk"] }).map((chip) => chip.label), ["Usually kana", "Colloquial"]);
});

// The family travels with the chip, because it is what colours it: a field of
// study and a usage note are different claims about a sense, and a single grey
// run of text made them read as one list.
test("a tag keeps the family it came from", () => {
  const chips = tagChips({ fields: ["comp"], misc: ["uk"], dialects: ["ksb"] });

  assert.deepEqual(chips.map((chip) => chip.category), ["field", "misc", "dialect"]);
  assert.deepEqual(chips.map((chip) => chip.code), ["comp", "uk", "ksb"]);
});

test("name-type codes resolve for online nameType tags", () => {
  assert.equal(posLabel("surname"), "Surname");
  assert.equal(posLabel("place"), "Place name");
});
