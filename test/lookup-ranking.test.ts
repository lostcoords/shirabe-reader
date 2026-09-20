import "fake-indexeddb/auto";
import assert from "node:assert/strict";
import test from "node:test";
import { lookupOffline, parseOffline } from "../src/common/offline-dictionary.js";
import { installTestPack, packPayload, realPackPath, subsetPack } from "./support/pack.js";

type AsyncTest = () => void | Promise<void>;

const testWithPack = (name: string, callback: AsyncTest) =>
  test(name, { skip: realPackPath() ? false : "requires a local dictionary pack" }, callback);

testWithPack("lookup ranks whole inflections and distinguishes homophones by their own spellings", async () => {
  const path = realPackPath();
  assert.ok(path, "Build the dictionary pack before running lookup ranking tests");
  const lines = subsetPack(path, ["かかなかった", "くださいます", "とうた"]);
  await installTestPack(packPayload(lines), { contentRevision: "lookup-ranking", terms: lines.length - 1 });
  for (const [query, expected] of [
    ["かかなかった", "jmdict:1343950"], ["kakanakatta", "jmdict:1343950"],
    ["くださいます", "jmdict:1184280"], ["とうた", "jmdict:1448570"], ["touta", "jmdict:1448570"],
  ]) {
    assert.equal((await lookupOffline(query!, ["eng"], "https://shirabe.test"))?.entry, expected, query);
  }
});

testWithPack("explicit kana lookup prefers its grammatical word over a city sharing the reading", async () => {
  const path = realPackPath();
  assert.ok(path);
  const lines = subsetPack(path, ["なら", "ならば", "奈良"]);
  await installTestPack(packPayload(lines), { contentRevision: "lookup-kana-grammar", terms: lines.length - 1 });
  for (const [query, expected] of [["なら", "jmdict:1009470"], ["ならば", "jmdict:1009470"], ["奈良", "jmdict:2827768"]]) {
    assert.equal((await lookupOffline(query!, ["eng"], "https://shirabe.test"))?.entry, expected, query);
  }
});

testWithPack("contextual homophones use word frequency without discarding legitimate alternatives", async () => {
  const path = realPackPath();
  assert.ok(path);
  const lines = subsetPack(path, ["きみ", "あめ", "そこにいます。", "かく", "それ", "家", "行った"]);
  await installTestPack(packPayload(lines), { contentRevision: "context-ranking", terms: lines.length - 1 });
  const [kimi] = await parseOffline("きみ", ["eng"], "https://shirabe.test");
  assert.equal(kimi?.entry, "jmdict:1247250");
  assert.ok(kimi?.candidates?.some((candidate) => candidate.entry === "jmdict:1182060"));
  const [ame] = await parseOffline("あめ", ["eng"], "https://shirabe.test");
  assert.equal(ame?.entry, "jmdict:1171900");
  assert.ok(ame?.candidates?.some((candidate) => candidate.entry === "jmdict:1153520"));
  assert.ok(ame?.candidates?.some((candidate) => candidate.entry === "jmdict:1511950"));
  const tokens = await parseOffline("そこにいます。", ["eng"], "https://shirabe.test");
  assert.equal(tokens.find((token) => token.surface === "います")?.entry, "jmdict:1577980");
  assert.equal((await parseOffline("かく", ["eng"], "https://shirabe.test"))[0]?.entry, "jmdict:1343950");
  assert.equal((await parseOffline("それ", ["eng"], "https://shirabe.test"))[0]?.entry, "jmdict:1006970");
  const house = (await parseOffline("家", ["eng"], "https://shirabe.test"))[0];
  const alternatives = house?.candidates ?? [];
  const inside = alternatives.findIndex((candidate) => candidate.entry === "jmdict:1457730");
  const family = alternatives.findIndex((candidate) => candidate.entry === "jmdict:1191750");
  assert.equal(house?.entry, "jmdict:1191730");
  assert.ok(inside >= 0 && family > inside);
  assert.equal(alternatives[inside]?.common, true);
  const past = (await parseOffline("行った", ["eng"], "https://shirabe.test"))[0];
  const verbs = past?.candidates?.map((candidate) => candidate.entry) ?? [];
  assert.equal(past?.entry, "jmdict:1578850");
  assert.ok(verbs.indexOf("jmdict:1589060") >= 0 && verbs.indexOf("jmdict:1012980") > verbs.indexOf("jmdict:1589060"));
});

testWithPack("a complete word keeps its boundary before punctuation and non-Japanese text", async () => {
  const path = realPackPath();
  assert.ok(path);
  const sentences = ["はし", "はし。", "はし！", "はし?", "はし\n", "はし abc", "はし\u3000猫", "はし\u00a0猫", "はし\u0085猫", "はし。猫"];
  const lines = subsetPack(path, sentences);
  await installTestPack(packPayload(lines), { contentRevision: "word-boundary", terms: lines.length - 1 });
  for (const sentence of sentences) {
    const tokens = await parseOffline(sentence, ["eng"], "https://shirabe.test");
    assert.equal(tokens[0]?.surface, "はし", sentence);
    assert.equal(tokens[0]?.entry, "jmdict:1581610", sentence);
    assert.ok(tokens[0]?.candidates?.some((candidate) => candidate.entry === "jmdict:1565560"), sentence);
    assert.equal(tokens.map((token) => token.surface).join(""), sentence);
  }
});

testWithPack("an adverb reading fits before a verb without replacing standalone or attributive verbs", async () => {
  const path = realPackPath();
  assert.ok(path);
  const sentences = ["かく語った。", "かく", "かく。", "かく人", "字をかく。", "かいて語った。"];
  const lines = subsetPack(path, sentences);
  await installTestPack(packPayload(lines), { contentRevision: "adverb-context", terms: lines.length - 1 });
  const contextual = await parseOffline(sentences[0]!, ["eng"], "https://shirabe.test");
  assert.equal(contextual[0]?.surface, "かく");
  assert.equal(contextual[0]?.entry, "jmdict:2076890");
  assert.ok(contextual[0]?.candidates?.some((candidate) => candidate.entry === "jmdict:1343950"));
  for (const sentence of sentences.slice(1)) {
    const tokens = await parseOffline(sentence, ["eng"], "https://shirabe.test");
    const verb = tokens.find((token) => token.surface === "かく" || token.surface === "かいて");
    assert.equal(verb?.entry, "jmdict:1343950", sentence);
  }
});

testWithPack("a particle before an adverb and verb is not swallowed into a noun", async () => {
  const path = realPackPath();
  assert.ok(path);
  const sentences = ["彼はかく語った。", "彼がかく語った。", "先生もかく語った。", "はかくの商品。"];
  const lines = subsetPack(path, sentences);
  await installTestPack(packPayload(lines), { contentRevision: "particle-adverb-context", terms: lines.length - 1 });
  for (const [index, particle] of ["は", "が", "も"].entries()) {
    const tokens = await parseOffline(sentences[index]!, ["eng"], "https://shirabe.test");
    assert.ok(tokens.some((token) => token.surface === particle && token.pos === "prt"), sentences[index]);
    assert.equal(tokens.find((token) => token.surface === "かく")?.entry, "jmdict:2076890", sentences[index]);
  }
  const literal = await parseOffline(sentences[3]!, ["eng"], "https://shirabe.test");
  assert.equal(literal[0]?.surface, "はかく");
  assert.equal(literal[0]?.entry, "jmdict:1471290");
});

testWithPack("contextual copulas follow nominal predicates without offering verbal auxiliaries", async () => {
  const path = realPackPath();
  assert.ok(path);
  const sentences = ["静かだった", "猫だった", "いつだった"];
  const lines = subsetPack(path, sentences);
  await installTestPack(packPayload(lines), { contentRevision: "context-copula", terms: lines.length - 1 });
  for (const sentence of sentences) {
    const tokens = await parseOffline(sentence, ["eng"], "https://shirabe.test");
    assert.deepEqual(tokens.map((token) => token.surface), [sentence.slice(0, -3), "だった"], sentence);
    assert.equal(tokens[1]?.entry, "jmdict:2819970");
    assert.ok(tokens[1]?.candidates?.some((candidate) => candidate.entry === "jmdict:2089020" && candidate.headword === "だ"));
    assert.deepEqual(tokens[1]?.candidates?.map((candidate) => candidate.entry), ["jmdict:2819970", "jmdict:2089020"], sentence);
  }
  const [isolated] = await parseOffline("だった", ["eng"], "https://shirabe.test");
  assert.ok(isolated?.candidates?.some((candidate) => candidate.entry === "jmdict:2867372"));
});

testWithPack("contextual particles keep grammatical alternatives rather than noun homophones", async () => {
  const path = realPackPath();
  assert.ok(path);
  const sentences = ["昨日は静かだった。", "先生が来た。", "いつだったか考えた。"];
  const lines = subsetPack(path, sentences);
  await installTestPack(packPayload(lines), { contentRevision: "context-particles", terms: lines.length - 1 });
  for (const [index, surface, entries] of [
    [0, "は", ["jmdict:2028920"]],
    [1, "が", ["jmdict:2028930", "jmdict:2872273"]],
    [2, "か", ["jmdict:2028970"]],
  ] as const) {
    const tokens = await parseOffline(sentences[index]!, ["eng"], "https://shirabe.test");
    const token = tokens.find((item) => item.surface === surface);
    assert.ok(token, surface);
    assert.deepEqual(token.candidates?.map((candidate) => candidate.entry) ?? [token.entry], entries, surface);
  }
});

testWithPack("a suru noun constrains its complement without erasing isolated verb ambiguity", async () => {
  const path = realPackPath();
  assert.ok(path);
  const lines = subsetPack(path, ["明日勉強します。", "します"]);
  await installTestPack(packPayload(lines), { contentRevision: "context-suru-complement", terms: lines.length - 1 });
  const [isolated] = await parseOffline("します", ["eng"], "https://shirabe.test");
  assert.ok(isolated?.candidates?.some((candidate) => candidate.entry === "jmdict:1389440" && candidate.headword === "占む"));
  const tokens = await parseOffline("明日勉強します。", ["eng"], "https://shirabe.test");
  const complement = tokens.find((token) => token.surface === "します");
  assert.ok(complement);
  assert.deepEqual(complement.candidates?.map((candidate) => candidate.entry) ?? [complement.entry], ["jmdict:1157170"]);
});
