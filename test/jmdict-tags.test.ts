import assert from "node:assert/strict";
import test from "node:test";
import { posLabel, posLabels, tagLabel, tagLabels } from "../src/common/jmdict-tags.js";

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

test("posLabels de-dupes collapsed verb classes", () => {
  assert.deepEqual(posLabels(["v5r", "vi"]), ["Godan verb", "Intransitive verb"]);
  assert.deepEqual(posLabels(["v5r", "v5r-i", "vi"]), ["Godan verb", "Intransitive verb"]);
});

test("tagLabel maps common misc codes", () => {
  assert.equal(tagLabel("uk"), "Usually kana");
  assert.equal(tagLabel("yoji"), "Yojijukugo");
  assert.equal(tagLabel("col"), "Colloquial");
  assert.equal(tagLabel("weird-code"), "weird-code");
  assert.equal(tagLabel("uk", "word usually written using kana alone"), "Usually kana");
});

test("tagLabels de-dupes in order", () => {
  assert.deepEqual(tagLabels(["uk", "col", "uk"]), ["Usually kana", "Colloquial"]);
});

test("name-type codes resolve for online nameType tags", () => {
  assert.equal(posLabel("surname"), "Surname");
  assert.equal(posLabel("place"), "Place name");
});
