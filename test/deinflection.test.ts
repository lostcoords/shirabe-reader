import assert from "node:assert/strict";
import test from "node:test";
import { deinflect, inflectionLabel } from "../src/common/deinflect.js";

const forms = (text: string) => deinflect(text).map((candidate) => candidate.term);

test("deinflects nested ichidan causative passive negative past", () => {
  assert.ok(forms("食べさせられなかった").includes("食べる"));
});

test("deinflects godan polite and past forms", () => {
  assert.ok(forms("読みました").includes("読む"));
  assert.ok(forms("書いた").includes("書く"));
});

test("deinflects i-adjective negative", () => {
  assert.ok(forms("高くない").includes("高い"));
  assert.ok(forms("高くなかった").includes("高い"));
});

test("deinflects progressive, potential, passive, and polite-negative godan forms", () => {
  assert.ok(forms("書いている").includes("書く"));
  assert.ok(forms("読める").includes("読む"));
  assert.ok(forms("読まれる").includes("読む"));
  assert.ok(forms("読みませんでした").includes("読む"));
});

test("deinflects suru and kuru irregular forms", () => {
  assert.ok(forms("勉強していた").includes("勉強する"));
  assert.ok(forms("勉強できる").includes("勉強する"));
  assert.ok(forms("持ってきました").includes("持ってくる"));
});

// Chains and their names must match daidai's, because the website renders those
// labels (tokens_helper.rb → Daidai.deinflect) — the same word has to read the
// same way in the popup and on the page. Expectations are daidai's own test
// cases (test/deinflector_test.rb), through its LABELS map.
const chain = (surface: string, lemma: string) =>
  deinflect(surface).find((candidate) => candidate.term === lemma)?.inflections.map(inflectionLabel);

test("inflection chains match daidai's, so labels read the same as the website", () => {
  assert.deepEqual(chain("食べてる", "食べる"), ["progressive", "te-form"]);
  assert.deepEqual(chain("食べている", "食べる"), ["progressive", "te-form"]);
  assert.deepEqual(chain("食べました", "食べる"), ["past", "polite"]);
  assert.deepEqual(chain("食べさせられた", "食べる"), ["past", "potential / passive", "causative"]);
});

// Colloquial contractions the old flat suffix table could not reach at all.
test("deinflects colloquial contractions", () => {
  assert.ok(forms("食べちゃう").includes("食べる"));
  assert.ok(forms("食べとく").includes("食べる"));
  assert.ok(forms("読んじゃった").includes("読む"));
});

// A rule only fires when the grammatical state allows it: い-adjectives are not
// verbs, which a flat table has no way to know.
test("rules are gated by grammatical condition", () => {
  assert.ok(forms("高くなかった").includes("高い"));
  assert.ok(!forms("高くなかった").includes("高る"), "an i-adjective must never deinflect as a verb");
  const found = deinflect("食べてる").find((candidate) => candidate.term === "食べる");
  assert.ok(found?.dictionaryForm, "食べる is a dictionary form");
});
