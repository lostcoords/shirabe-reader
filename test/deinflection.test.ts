import assert from "node:assert/strict";
import test from "node:test";
import { deinflect, displayInflections, inflectionLabel, matchesPos, posConditionFlags } from "../src/common/deinflect.js";
import irregularCases from "./fixtures/irregular-parity.json";

// Deliberately NOT driven by test/tokenizer_eval/deinflection.yml, though at a
// glance the two look like the same table. That corpus asserts the hint the
// website renders under the search bar (Inflection.resolve), which is gated by
// whether the surface is its own headword: it holds `見れる → no hint at all`,
// because JMdict lists 見れる. This file asserts the raw rule chain, where 見れる
// deinflects to 見る and must keep doing so, or the popup stops opening on it.
// The same word, two answers, both correct: one corpus could only hold one.

const forms = (text: string) => deinflect(text).map((candidate) => candidate.term);

test("na adjective adverbials retain their class in direct and contextual lookup", () => {
  for (const contextual of [false, true]) {
    for (const surface of ["静かに", "確かに", "上手に"]) {
      const candidate = deinflect(surface, { contextual }).find((form) => form.term === surface.slice(0, -1) && matchesPos(form, ["adj-na"]));
      assert.ok(candidate, surface);
      assert.deepEqual(candidate.inflections, ["adverbial"]);
      assert.equal(matchesPos(candidate, ["n"]), false);
      assert.equal(matchesPos(candidate, ["cop"]), false);
    }
  }
});

test("de is a te-form of the copula, not of the past auxiliary", () => {
  for (const contextual of [false, true]) {
    const candidates = deinflect("で", { contextual }).filter((candidate) => candidate.term === "だ");
    assert.ok(candidates.some((candidate) => matchesPos(candidate, ["cop"]) && candidate.inflections.join() === "-て"));
    assert.ok(!candidates.some((candidate) => matchesPos(candidate, ["aux-v"])));
    assert.ok(!candidates.some((candidate) => matchesPos(candidate, ["v5r"])));
  }
});

test("contextual permission keeps the copula and following predicate separate", () => {
  for (const surface of ["でもいい", "じゃなくてもいい"]) {
    assert.ok(deinflect(surface).some((candidate) => candidate.term === "だ" && matchesPos(candidate, ["cop"])), surface);
    assert.ok(!deinflect(surface, { contextual: true }).some((candidate) => candidate.term === "だ" && matchesPos(candidate, ["cop"])), surface);
  }
  for (const surface of ["食べてもいい", "食べなくてもいい"]) {
    assert.ok(deinflect(surface, { contextual: true }).some((candidate) => candidate.term === "食べる" && matchesPos(candidate, ["v1"])), surface);
  }
  assert.ok(deinflect("で", { contextual: true }).some((candidate) => candidate.term === "だ" && matchesPos(candidate, ["cop"])));
});

test("contextual deinflection retains copulas but leaves nominal predicates as separate words", () => {
  for (const [surface, base, pos] of [["だった", "だ", "cop"], ["でした", "です", "cop"], ["しました", "する", "vs-i"]]) {
    assert.ok(deinflect(surface!, { contextual: true }).some((candidate) => candidate.term === base && matchesPos(candidate, [pos!])), surface);
  }
  for (const [surface, base, pos] of [["勉強しました", "勉強", "vs"], ["静かだった", "静か", "adj-na"], ["猫だった", "猫", "n"]]) {
    assert.ok(deinflect(surface!).some((candidate) => candidate.term === base && matchesPos(candidate, [pos!])), surface);
    assert.ok(!deinflect(surface!, { contextual: true }).some((candidate) => candidate.term === base && matchesPos(candidate, [pos!])), surface);
  }
});

test("irregular class decisions match Daidai across proper and regularized paradigms", () => {
  for (const { surface, base, pos, accepted } of irregularCases) {
    assert.equal(deinflect(surface).some((candidate) => candidate.term === base && matchesPos(candidate, [pos])), accepted, `${surface} → ${base} (${pos})`);
  }
});

test("irregular dictionary classes reject regularized forms without rejecting their real forms", () => {
  for (const [surface, base, pos] of [
    ["行いた", "行く", "v5k-s"], ["問った", "問う", "v5u-s"],
    ["あらない", "ある", "v5r-i"], ["くださります", "くださる", "v5aru"],
    ["行いていなかった", "行く", "v5k-s"],
  ]) {
    const candidates = deinflect(surface!).filter((candidate) => candidate.term === base);
    assert.ok(candidates.length, surface);
    assert.ok(!candidates.some((candidate) => matchesPos(candidate, [pos!])), surface);
  }
  for (const [surface, base, pos] of [
    ["行った", "行く", "v5k-s"], ["問うた", "問う", "v5u-s"],
    ["くださいます", "くださる", "v5aru"], ["下さいます", "下さる", "v5aru"],
    ["行っていなかった", "行く", "v5k-s"],
  ]) {
    assert.ok(deinflect(surface!).some((candidate) => candidate.term === base && matchesPos(candidate, [pos!])), surface);
  }
});

test("nominal and suru bases retain the grammatical class accepted by the dictionary", () => {
  const cases = [
    ["勉強しました", "勉強", "vs"],
    ["静かだった", "静か", "adj-na"],
    ["猫だった", "猫", "n"],
    ["静かなら", "静か", "adj-na"],
    ["でした", "です", "cop"],
    ["しましたり", "する", "vs-i"],
  ];
  for (const [surface, lemma, pos] of cases) {
    assert.ok(deinflect(surface!).some((candidate) =>
      candidate.term === lemma && candidate.dictionaryForm && (candidate.conditions & posConditionFlags([pos!])) !== 0),
    `${surface} → ${lemma} (${pos})`);
  }
  assert.ok(!deinflect("静かだった").some((candidate) =>
    candidate.term === "静か" && (candidate.conditions & posConditionFlags(["v5k"])) !== 0));
  assert.ok(!forms("でした").includes(""));
});

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

test("deinflects ら抜き potential forms to their dictionary form", () => {
  assert.ok(forms("食べれる").includes("食べる")); // ichidan ら抜き
  assert.ok(forms("見れる").includes("見る"));
  assert.ok(forms("来れる").includes("来る")); // kuru ら抜き
});

test("deinflects suru and kuru irregular forms", () => {
  assert.ok(forms("勉強していた").includes("勉強する"));
  assert.ok(forms("勉強できる").includes("勉強する"));
  assert.ok(forms("持ってきました").includes("持ってくる"));
});

test("deinflects the negative te-form 〜ないで (daidai extension beyond Yomitan)", () => {
  assert.ok(forms("食べないで").includes("食べる")); // ichidan
  assert.ok(forms("行かないで").includes("行く")); // godan
  assert.ok(forms("読まないで").includes("読む"));
});

// Chains and their names must match daidai's, because the website renders those
// labels (tokens_helper.rb → Daidai.deinflect): the same word has to read the
// same way in the popup and on the page. Expectations are daidai's own test
// cases (test/deinflector_test.rb), through its LABELS map.
const chain = (surface: string, lemma: string) =>
  deinflect(surface).find((candidate) => candidate.term === lemma)?.inflections.map(inflectionLabel);

test("popup labels match the website without changing the underlying derivation", () => {
  assert.deepEqual(displayInflections(chain("上手く", "上手い")!), ["adverbial (〜く)"]);
  assert.deepEqual(displayInflections(chain("静かに", "静か")!), ["adverbial (〜に)"]);
  assert.deepEqual(displayInflections(chain("行かなければならない", "行く")!), ["obligation (must)"]);
  assert.deepEqual(displayInflections(chain("食べてはいけない", "食べる")!), ["prohibition (must not)"]);
  assert.deepEqual(displayInflections(chain("食べました", "食べる")!), ["past", "polite"]);
  assert.deepEqual(displayInflections(["unknown rule"]), ["unknown rule"]);
});

test("inflection chains match daidai's, so labels read the same as the website", () => {
  assert.deepEqual(chain("食べてる", "食べる"), ["progressive", "te-form"]);
  assert.deepEqual(chain("食べている", "食べる"), ["progressive", "te-form"]);
  assert.deepEqual(chain("食べました", "食べる"), ["past", "polite"]);
  assert.deepEqual(chain("食べさせられた", "食べる"), ["past", "potential / passive", "causative"]);
});

// The obligation / prohibition constructions (daidai 0.2.3). Each strips only
// its helper and hands the rest to a rule that already existed, so the chain
// shows the whole derivation rather than one opaque step. Chains are pinned
// because the popup and the website must name the same grammar.
test("deinflects the obligation construction to its verb", () => {
  assert.deepEqual(chain("行かなければならない", "行く"), ["obligation (must)", "provisional (-ba)", "negative"]);
  assert.deepEqual(chain("行かなくてはいけない", "行く"), ["obligation (must)", "negative"]);
  assert.deepEqual(chain("行かないといけない", "行く"), ["obligation (must)", "negative"]);
  assert.deepEqual(chain("行かねばならない", "行く"), ["obligation (must)", "negative conditional (-neba)"]);
});

// The helper can be dropped entirely and it still reads as an obligation.
test("deinflects an obligation with its helper left off", () => {
  assert.ok(forms("行かなくちゃ").includes("行く"));
  assert.ok(forms("行かなきゃならない").includes("行く"));
});

// Prohibition leaves the verb un-negated, which is what makes it the opposite.
test("deinflects the prohibition construction to its verb", () => {
  assert.deepEqual(chain("食べてはいけない", "食べる"), ["prohibition (must not)", "te-form"]);
  assert.deepEqual(chain("読んではいけない", "読む"), ["prohibition (must not)", "te-form"]);
  assert.ok(forms("遊んじゃだめ").includes("遊ぶ"));
});

test("obligation and prohibition are labelled as the opposites they are", () => {
  assert.equal(inflectionLabel("obligation"), "obligation (must)");
  assert.equal(inflectionLabel("prohibition"), "prohibition (must not)");
});


// The four-part set learners meet together. なくてもいい contains てもいい, so the
// negated reading has to come out shorter or the wrong one wins: daidai lands it
// straight on ない for exactly that reason.
test("deinflects permission and exemption", () => {
  assert.deepEqual(chain("行ってもいい", "行く"), ["permission (may)", "te-form"]);
  assert.deepEqual(chain("行かなくてもいい", "行く"), ["exemption (need not)", "negative"]);
  assert.ok(forms("食べてもかまわない").includes("食べる"));
});

// The rest of the て-auxiliary family, alongside -おく and -しまう. conditionsIn is
// the auxiliary's own class, so it may conjugate and still reach the verb.
test("deinflects the remaining te-auxiliaries", () => {
  assert.deepEqual(chain("読んでみる", "読む"), ["attempt (-temiru)", "te-form"]);
  assert.deepEqual(chain("置いてある", "置く"), ["resultant state (-tearu)", "te-form"]);
  assert.ok(forms("増えていく").includes("増える"));
  assert.ok(forms("増えてくる").includes("増える"));
  assert.deepEqual(chain("読んでみた", "読む"), ["past", "attempt (-temiru)", "te-form"]);
});

test("deinflects renyoukei suffixes and べき", () => {
  assert.deepEqual(chain("食べながら", "食べる"), ["simultaneous (-nagara)"]);
  assert.deepEqual(chain("読みやすい", "読む"), ["easy to (-yasui)"]);
  assert.deepEqual(chain("読みにくい", "読む"), ["hard to (-nikui)"]);
  assert.deepEqual(chain("行くべき", "行く"), ["obligation (-beki)"]);
  assert.ok(forms("すべき").includes("する"));
});

test("deinflects aspectual compound verbs", () => {
  assert.deepEqual(chain("読み始める", "読む"), ["begin (-hajimeru)"]);
  assert.ok(forms("読み続ける").includes("読む"));
  assert.ok(forms("読み終わる").includes("読む"));
});

// The benefactives: who the action is done for.
test("deinflects the benefactives", () => {
  assert.deepEqual(chain("読んであげる", "読む"), ["doing for someone (-teageru)", "te-form"]);
  assert.deepEqual(chain("読んでくれる", "読む"), ["done for me (-tekureru)", "te-form"]);
  assert.deepEqual(chain("読んでもらう", "読む"), ["having someone do (-temorau)", "te-form"]);
  assert.ok(forms("教えていただく").includes("教える"));
  assert.ok(forms("書いてくださる").includes("書く"));
});


// The commonest polite request there is; ください is くださる's irregular imperative.
test("deinflects the polite request and further renyoukei suffixes", () => {
  assert.deepEqual(chain("読んでください", "読む"), ["polite request (-tekudasai)", "te-form"]);
  assert.ok(forms("来てください").includes("来る"));
  assert.deepEqual(chain("忘れがち", "忘れる"), ["tends to (-gachi)"]);
  assert.deepEqual(chain("分かりかねる", "分かる"), ["cannot (-kaneru)"]);
  assert.ok(forms("出しっぱなし").includes("出す"));
});

// 〜だす, 〜なおす and 〜きる lexicalise and the dictionary already carries them
// (見直す is "to review"; every 〜だす compound checked is a JMdict entry). A rule
// would win nothing there while 出す as a main verb is everywhere: it read 外に出す
// as に出す. They stay the dictionary's job.
test("lexicalised compounds are left to the dictionary", () => {
  assert.ok(!forms("見直す").includes("見る"));
  assert.ok(!forms("読み直す").includes("読む"));
  assert.ok(!forms("泣き出す").includes("泣く"));
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
