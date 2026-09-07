import assert from "node:assert/strict";
import test from "node:test";
import { inflectionsAgree, intentErrors, readingsAgree, studyIdentityErrors } from "./support/search-intent.js";

test("study identity checks the selected entry independently of its grammatical explanation", () => {
  const expected = { headword: "確かに", readings: ["たしかに"] };
  assert.deepEqual(studyIdentityErrors("確かに", "タシカニ", expected), []);
  assert.deepEqual(studyIdentityErrors("確か", "たしか", expected), ["unexpected study headword 確か", "unexpected study reading たしか"]);
  assert.deepEqual(studyIdentityErrors("確かに", undefined, expected), ["unexpected study reading undefined"]);
  assert.deepEqual(studyIdentityErrors("確かに", "たしかに", undefined), ["missing study identity reference"]);
});

test("strict inflection parity checks labels and bases without an intent expectation", () => {
  const word = { surface: "でした", entry: "desu", candidates: [], inflection: ["past"], inflectionBase: "です" };
  assert.equal(inflectionsAgree([word], [word]), true);
  assert.equal(inflectionsAgree([word], [{ ...word, inflection: [] }]), false);
  assert.equal(inflectionsAgree([word], [{ ...word, inflectionBase: "する" }]), false);
  assert.equal(inflectionsAgree([word], []), false);
  assert.equal(inflectionsAgree([{ ...word, inflectionBase: undefined }], [{ ...word, inflectionBase: null }]), true);
});

test("paired readings compare every recognized token and normalize only kana representation", () => {
  const word = { surface: "弾ける", reading: "ハジケル", entry: "burst", candidates: [] };
  assert.equal(readingsAgree([word], [{ ...word, reading: "はじける" }]), true);
  assert.equal(readingsAgree([word], [{ ...word, reading: "ﾊｼﾞｹﾙ" }]), true);
  assert.equal(readingsAgree([word], [{ ...word, reading: "ひける" }]), false);
  assert.equal(readingsAgree([word], [{ ...word, reading: null }]), false);
  assert.equal(readingsAgree([word], []), false);
  const symbol = { surface: "。", reading: "。", entry: null, candidates: [] };
  assert.equal(readingsAgree([symbol], [{ ...symbol, reading: null }]), true);
});

test("shared intent rejects a wrong displayed reading even with the correct entry", () => {
  const tokens = [{ surface: "弾ける", reading: "ひける", entry: "burst", candidates: ["burst"] }];
  const expected = [{ surface: "弾ける", reading: "はじける", leaders: ["burst"] }];
  assert.deepEqual(intentErrors(tokens, expected), ["弾ける: unexpected reading ひける"]);
  tokens[0]!.reading = "はじける";
  assert.deepEqual(intentErrors(tokens, expected), []);
  tokens[0]!.reading = "ハジケル";
  assert.deepEqual(intentErrors(tokens, expected), []);
  assert.deepEqual(intentErrors([{ surface: "弾ける", entry: "burst", candidates: [] }], expected),
    ["弾ける: unexpected reading undefined"]);
});

test("declared reading alternatives remain separate from strict reading parity", () => {
  const expected = [{ surface: "明日", reading: ["あした", "あす"], leaders: ["tomorrow"] }];
  const word = { surface: "明日", reading: "アス", entry: "tomorrow", candidates: [] };
  assert.deepEqual(intentErrors([word], expected), []);
  assert.deepEqual(intentErrors([{ ...word, reading: "あした" }], expected), []);
  assert.deepEqual(intentErrors([{ ...word, reading: "みょうにち" }], expected), ["明日: unexpected reading みょうにち"]);
  assert.deepEqual(intentErrors([{ ...word, reading: null }], expected), ["明日: unexpected reading null"]);
  assert.equal(readingsAgree([word], [{ ...word, reading: "あした" }]), false);
});

test("shared intent rejects a wrong inflection explanation even with the correct entry", () => {
  const tokens = [{ surface: "でした", entry: "desu", candidates: ["desu"], inflection: ["suru verb"] }];
  const expected = [{ surface: "でした", leaders: ["desu"], inflection: ["past"] }];
  assert.deepEqual(intentErrors(tokens, expected), ['でした: unexpected inflection ["suru verb"]']);
  tokens[0]!.inflection = ["past"];
  assert.deepEqual(intentErrors(tokens, expected), []);
});

test("shared intent rejects an explanation naming the selected entry instead of its grammatical base", () => {
  const tokens = [{ surface: "なら", entry: "nara", candidates: ["nara"], inflectionBase: "なら" }];
  assert.deepEqual(intentErrors(tokens, [{ surface: "なら", leaders: ["nara"], inflectionBase: "だ" }]),
    ["なら: unexpected inflection base なら"]);
});

test("shared intent rejects duplicate candidates even without a surface expectation", () => {
  assert.deepEqual(intentErrors([{ surface: "ひとつ", entry: "one", candidates: ["one", "other", "one"] }], []),
    ["ひとつ: duplicate alternative one"]);
});

test("shared intent rejects a wrong leader even when the right word is offered", () => {
  assert.deepEqual(intentErrors([{ surface: "きみ", entry: "millet", candidates: ["millet", "you"] }],
    [{ surface: "きみ", leaders: ["you"] }]), ["きみ: unexpected leader millet"]);
});

test("shared intent checks whole-word boundaries", () => {
  assert.deepEqual(intentErrors([{ surface: "は", entry: "particle", candidates: [] }],
    [{ surface: "はし", leaders: ["bridge", "chopsticks", "edge"] }]), ["Missing whole token はし"]);
});

test("shared intent preserves acceptable ambiguity and required alternatives", () => {
  const expected = [{ surface: "はし", leaders: ["bridge", "chopsticks"], offers: ["edge"] }];
  assert.deepEqual(intentErrors([{ surface: "はし", entry: "bridge", candidates: ["edge"] }], expected), []);
  assert.deepEqual(intentErrors([{ surface: "はし", entry: "chopsticks", candidates: [] }], expected),
    ["はし: missing alternative edge"]);
});

test("shared intent rejects alternatives ruled out by context", () => {
  assert.deepEqual(intentErrors([{ surface: "だった", entry: "copula", candidates: ["dialectal-verb"] }],
    [{ surface: "だった", leaders: ["copula"], excludes: ["dialectal-verb"] }]), ["だった: context excludes dialectal-verb"]);
});
test("shared intent rejects a wrong base even when the entry is correct", () => {
  const tokens = [{ surface: "3つ", lemma: "3", entry: "three-things", candidates: ["three-things"] }];
  const expected = [{ surface: "3つ", lemma: "三つ", leaders: ["three-things"] }];
  assert.deepEqual(intentErrors(tokens, expected), ["3つ: unexpected lemma 3"]);
  tokens[0]!.lemma = "三つ";
  assert.deepEqual(intentErrors(tokens, expected), []);
});
