import "fake-indexeddb/auto";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { lookupEntryOffline, lookupOffline, parseOffline } from "../src/common/offline-dictionary.js";
import { installTestPack, packPayload } from "./support/pack.js";
import contextEvidence from "../../db/reference/context_hints.json";

// The offline half of `POST /api/v1/words/identify`.
//
// One answer is a claim we often cannot support: きみ is 君, 黄身 or 黍, and only
// the reader knows which they meant. The parser has always ranked this list to
// pick its winner and then thrown the runners-up away at the last step, which is
// exactly the bug the server had before candidates, on the other side.
//
// It matters more offline than online: the extension resolves against the pack
// and never calls the API for a lookup, so nothing the server learned reaches it
// unless it is ported.

const HOST = "https://shirabe.test";

test("an ambiguous written word uses its applicable dictionary reading while explicit kana preserves the chosen reading", async () => {
  const tomorrow = JSON.parse(term("jmdict:tomorrow", "明日", "明日", "あした", "tomorrow", true, "n"));
  tomorrow.readings.push({ text: "あす", kind: "kana" }, { text: "みょうにち", kind: "kana" });
  tomorrow.expressions.push(...tomorrow.readings.map(({ text }: { text: string }) => ({ text, script: "kana", common: true, tags: [] })));
  await install([JSON.stringify(tomorrow)]);
  assert.equal((await parseOffline("明日。", ["eng"], HOST))[0].reading, "あした");
  for (const reading of ["あした", "あす", "みょうにち"]) {
    for (const popup of [await lookupOffline(reading, ["eng"], HOST),
      await lookupEntryOffline("jmdict:tomorrow", reading, ["eng"], HOST)]) {
      assert.equal(popup?.entry, "jmdict:tomorrow");
      assert.equal(popup?.reading, reading);
    }
  }
});

test("a kana popup displays the matched spelling but studies the selected entry's canonical headword", async () => {
  const word = JSON.parse(term("jmdict:bridge", "橋", "橋", "はし", "bridge", true, "n"));
  word.expressions.push({ text: "はし", script: "kana", common: true, tags: [] });
  await install([JSON.stringify(word)]);
  const popup = await lookupEntryOffline("jmdict:bridge", "はし", ["eng"], HOST);
  assert.equal(popup?.headword, "はし");
  assert.equal(popup?.baseForm, "橋");
  assert.equal(popup?.reading, "はし");
  assert.equal(popup?.entry, "jmdict:bridge");
});

test("a lexical imperative explains its referenced verb without replacing the selected entry", async () => {
  const please = JSON.parse(term("jmdict:please", "ください", "下さい", "ください", "please give me", true, "exp"));
  please.senses[0].xrefs = [{ kind: "related", text: "下さる", reading: "くださる" }];
  const give = term("jmdict:give", "下さる", "下さる", "くださる", "give", true, "v5aru");
  await install([JSON.stringify(please), give]);
  for (const surface of ["下さい", "ください"]) {
    const popup = await lookupEntryOffline("jmdict:please", surface, ["eng"], HOST);
    assert.equal(popup?.entry, "jmdict:please");
    assert.equal(popup?.reading, "ください");
    assert.equal(popup?.baseForm, "ください");
    assert.equal(popup?.baseReading ?? popup?.reading, "ください");
    assert.deepEqual(popup?.inflection, ["imperative"]);
    assert.equal(popup?.inflectionBase, surface === "下さい" ? "下さる" : "くださる");
  }
  please.senses[0].xrefs[0].reading = "おろさる";
  await install([JSON.stringify(please), give]);
  assert.equal((await lookupEntryOffline("jmdict:please", "下さい", ["eng"], HOST))?.inflectionBase, undefined);
  please.senses[0].xrefs = [];
  await install([JSON.stringify(please), give]);
  assert.equal((await lookupEntryOffline("jmdict:please", "下さい", ["eng"], HOST))?.inflectionBase, undefined);
});

test("a listing particle stays whole beside suru without replacing the conjunction", async () => {
  const ranks: Record<string, number> = { "する": 10, "すると": 128162, "とか": 91, "と": 3, "か": 12, "で": 7 };
  await install([
    term("jmdict:do", "する", null, "する", "do", true, "vs-i"),
    term("jmdict:then", "すると", null, "すると", "then", true, "conj"),
    term("jmdict:list", "とか", null, "とか", "such as", true, "exp"),
    term("jmdict:quote", "と", null, "と", "quotation", true, "prt"),
    term("jmdict:question", "か", null, "か", "question", true, "prt"),
    term("jmdict:de", "で", null, "で", "at", true, "prt"),
  ].map((line) => {
    const entry = JSON.parse(line);
    entry.frequencies = [{ source: "jiten-global", text: entry.headword, reading: entry.readings[0].text, rank: ranks[entry.headword] }];
    return JSON.stringify(entry);
  }));
  const tokens = await parseOffline("するとかで", ["eng"], HOST);
  assert.deepEqual(tokens.map((token) => token.surface), ["する", "とか", "で"]);
  assert.equal(tokens[1]?.entry, "jmdict:list");
  assert.equal((await lookupOffline("すると", ["eng"], HOST))?.entry, "jmdict:then");
  assert.equal((await parseOffline("すると、", ["eng"], HOST))[0]?.entry, "jmdict:then");
});

test("parsed inflections use surface readings while popups keep dictionary readings", async () => {
  const cases = [
    ["eat", "食べる", "たべる", "v1", "食べました", "たべました"],
    ["write", "書く", "かく", "v5k", "書いた", "かいた"],
    ["go", "行く", "いく", "v5k-s", "行った", "いった"],
    ["come-past", "来る", "くる", "vk", "来た", "きた"],
    ["come-negative", "来る", "くる", "vk", "来ない", "こない"],
    ["study", "勉強する", "べんきょうする", "vs-i", "勉強した", "べんきょうした"],
    ["high", "高い", "たかい", "adj-i", "高くなかった", "たかくなかった"],
    ["eat-causative-passive", "食べる", "たべる", "v1", "食べさせられなかった", "たべさせられなかった"],
    ["read-progressive", "読む", "よむ", "v5m", "読んでいる", "よんでいる"],
    ["read-negative-past", "読む", "よむ", "v5m", "読みませんでした", "よみませんでした"],
    ["bring-negative", "持って来る", "もってくる", "vk", "持って来なかった", "もってこなかった"],
    ["give-honorific", "下さる", "くださる", "v5aru", "下さった", "くださった"],
    ["say-honorific", "仰る", "おっしゃる", "v5aru", "仰います", "おっしゃいます"],
    ["go-negative-te", "行く", "いく", "v5k-s", "行かないで", "いかないで"],
  ] as const;
  for (const [id, base, reading, pos, surface, expected] of cases) {
    await install([term(`jmdict:${id}`, base, base, reading, id, true, pos)]);
    const token = (await parseOffline(`${surface}。`, ["eng"], HOST))[0];
    assert.equal(token?.surface, surface);
    assert.equal(token?.entry, `jmdict:${id}`, surface);
    assert.equal(token?.lemma, base, surface);
    assert.equal(token?.reading, expected, surface);
    const popup = await lookupEntryOffline(`jmdict:${id}`, surface, ["eng"], HOST);
    assert.equal(popup?.reading, reading, surface);
  }
});

test("inflected expression readings use their validated conjugation rather than the first POS tag", async () => {
  const rain = JSON.parse(term("jmdict:rain", "雨が降る", "雨が降る", "あめがふる", "rain", true, "exp"));
  rain.senses[0].partsOfSpeech.push("v5r");
  const debt = JSON.parse(term("jmdict:debt", "首が回らない", "首が回らない", "くびがまわらない", "be in debt", true, "exp"));
  debt.expressions[0].inflectionClass = "adj-i";
  const come = JSON.parse(term("jmdict:bring", "持って来る", "持って来る", "もってくる", "bring", true, "exp"));
  come.expressions[0].inflectionClass = "vk";
  await install([rain, debt, come].map((row) => JSON.stringify(row)));
  for (const [surface, reading] of [["雨が降った", "あめがふった"], ["首が回らなく", "くびがまわらなく"], ["持って来た", "もってきた"]]) {
    const [token] = await parseOffline(`${surface}。`, ["eng"], HOST);
    assert.equal(token.surface, surface);
    assert.equal(token.reading, reading, surface);
  }
});

test("a lexical adverb does not inherit a rare adjective explanation", async () => {
  await install([
    term("jmdict:entirely", "全く", "全く", "まったく", "entirely", true, "adv"),
    term("jmdict:complete", "全い", "全い", "まったい", "complete", false, "adj-i"),
  ]);
  for (const popup of [await lookupOffline("全く", ["eng"], HOST),
    await lookupEntryOffline("jmdict:entirely", "全く", ["eng"], HOST)]) {
    assert.equal(popup?.entry, "jmdict:entirely");
    assert.deepEqual(popup?.inflection, []);
    assert.equal(popup?.inflectionBase, undefined);
    assert.equal(popup?.baseForm, "全く");
  }
});

test("a lexical adjective adverb wins only when the inflected reading agrees", async () => {
  const adverb = JSON.parse(term("jmdict:well", "上手く", "上手く", "うまく", "well", false, "adv"));
  adverb.expressions.push({ text: "甘く", script: "kanji", common: false, tags: [] });
  adverb.senses[0].misc = ["uk"];
  adverb.frequencies = [{ source: "jiten-global", text: "上手く", reading: "うまく", rank: 285081 }];
  const skilled = JSON.parse(term("jmdict:skilled", "上手い", "上手い", "うまい", "skilled", true, "adj-i"));
  skilled.frequencies = [{ source: "jiten-global", text: "上手い", reading: "うまい", rank: 3224 }];
  const sweet = JSON.parse(term("jmdict:sweet", "甘い", "甘い", "あまい", "sweet", true, "adj-i"));
  await install([adverb, skilled, sweet].map((row) => JSON.stringify(row)));
  const [token] = await parseOffline("上手く。", ["eng"], HOST);
  assert.equal(token.entry, "jmdict:well");
  assert.equal(token.lemma, "上手い");
  assert.equal(token.reading, "うまく");
  assert.deepEqual(token.candidates?.map((candidate) => candidate.entry), ["jmdict:well", "jmdict:skilled"]);
  const popup = await lookupEntryOffline(token.entry, token.surface, ["eng"], HOST);
  assert.equal(popup?.reading, "うまく");
  assert.equal(popup?.entry, "jmdict:well");
  assert.deepEqual(popup?.inflection, ["adverbial (〜く)"]);
  assert.equal(popup?.inflectionBase, "上手い");
  assert.equal(popup?.baseForm, "上手く");
  assert.equal(popup?.baseReading ?? popup?.reading, "うまく");
  assert.equal((await lookupEntryOffline(token.entry, "甘く", ["eng"], HOST))?.inflectionBase, undefined);
  assert.equal((await parseOffline("甘く。", ["eng"], HOST))[0].entry, "jmdict:sweet");
  for (const tag of ["sK", "rK"]) {
    adverb.expressions[0].tags = [tag];
    await install([adverb, skilled].map((row) => JSON.stringify(row)));
    assert.equal((await parseOffline("上手く。", ["eng"], HOST))[0].entry, "jmdict:skilled", tag);
  }
  adverb.expressions[0].tags = [];
  for (const tag of ["arch", "obs"]) {
    adverb.senses[0].misc = ["uk", tag];
    await install([adverb, skilled].map((row) => JSON.stringify(row)));
    assert.equal((await parseOffline("上手く。", ["eng"], HOST))[0].entry, "jmdict:skilled", tag);
  }
});

test("a rare spelling does not demote a common reading in the alternative list", async () => {
  const rows = [
    ["house", "家", "いえ", 188, true], ["inside", "内", "うち", 2082, true],
    ["family", "家", "け", 2917, true], ["suffix", "屋", "や", 1740, false],
  ] as const;
  await install(rows.map(([id, writing, reading, rank, common]) => {
    const row = JSON.parse(term(`jmdict:${id}`, writing, writing, reading, id, common));
    row.expressions.push({ text: reading, script: "kana", common, tags: [] });
    if (writing !== "家") row.expressions.push({ text: "家", script: "kanji", common: false, tags: ["sK"] });
    row.frequencies = [{ source: "jiten-global", text: writing, reading, rank }];
    return JSON.stringify(row);
  }));
  const token = (await parseOffline("家。", ["eng"], HOST))[0];
  assert.equal(token?.entry, "jmdict:house");
  assert.deepEqual(token?.candidates?.map((candidate) => candidate.entry),
    ["jmdict:house", "jmdict:inside", "jmdict:family", "jmdict:suffix"]);
  assert.equal(token?.candidates?.find((candidate) => candidate.entry === "jmdict:inside")?.common, true);
  assert.equal(token?.candidates?.find((candidate) => candidate.entry === "jmdict:suffix")?.common, false);
});

test("alternatives display the matched reading without borrowing another reading's common flag", async () => {
  const alternate = JSON.parse(term("jmdict:alternate", "生", "生", "なま", "alternate", true));
  alternate.expressions.push({ text: "なま", script: "kana", common: true, tags: [] },
    { text: "しょう", script: "kana", common: false, tags: [] });
  alternate.readings.push({ text: "しょう", kind: "kana" });
  await install([term("jmdict:chapter", "章", "章", "しょう", "chapter"), JSON.stringify(alternate)]);
  const token = (await parseOffline("しょう。", ["eng"], HOST))[0];
  const candidate = token?.candidates?.find((row) => row.entry === "jmdict:alternate");
  assert.ok(candidate);
  assert.equal(candidate.reading, "しょう");
  assert.equal(candidate.common, false);
});

test("learned contexts choose attested homophones while retaining alternatives and explicit spellings", async () => {
  const verbs = [["1587040", "言う", "いう", "v5u", 145], ["1546640", "要る", "いる", "v5r", 38],
    ["1578850", "行く", "いく", "v5k-s", 172]] as const;
  await install([
    ...verbs.map(([id, kanji, kana, pos, rank]) => {
      const row = JSON.parse(term(`jmdict:${id}`, kanji, kanji, kana, kanji, true, pos));
      row.expressions.push({ text: kana, script: "kana", common: true, tags: [] });
      row.frequencies = [{ source: "jiten-global", text: kana, reading: kana, rank }];
      return JSON.stringify(row);
    }),
    term("jmdict:school", "学校", "学校", "がっこう", "school", true, "n"),
    term("jmdict:teacher", "先生", "先生", "せんせい", "teacher", true, "n"),
    term("jmdict:ni", "に", null, "に", "to", true, "prt"),
    term("jmdict:to", "と", null, "と", "quotation", true, "prt"),
  ]);
  for (const [text, id, lemma] of [["学校にいった。", "1578850", "いく"], ["先生にいった。", "1587040", "いう"],
    ["「行く」と学校にいった。", "1587040", "いう"]]) {
    const tokens = await parseOffline(text, ["eng"], HOST);
    const token = tokens.find((row) => row.surface === "いった");
    assert.equal(token?.entry, `jmdict:${id}`, text);
    assert.equal(token?.lemma, lemma, text);
    assert.equal(tokens.map((row) => row.surface).join(""), text);
    const definition = await lookupEntryOffline(token!.entry!, token!.surface, ["eng"], HOST);
    assert.equal(definition?.baseForm, verbs.find(([sourceId]) => sourceId === id)?.[1], text);
    assert.deepEqual(definition?.inflection, ["past"], text);
    for (const [alternative] of verbs) {
      assert.ok(token?.entry === `jmdict:${alternative}` || token?.candidates?.some((row) => row.entry === `jmdict:${alternative}`), text);
    }
  }
  assert.equal((await parseOffline("学校に要った。", ["eng"], HOST)).find((row) => row.surface === "要った")?.entry, "jmdict:1546640");
});

test("quotation and purpose distinguish inflected homophones without deleting alternatives", async () => {
  const travel = JSON.parse(term("jmdict:travel", "旅行", "旅行", "りょこう", "travel"));
  travel.senses[0].partsOfSpeech = ["n", "vs", "vi"];
  const ranked = (id: string, kanji: string, kana: string, pos: string, kanaRank: number, wordRank: number) => {
    const row = JSON.parse(term(id, kanji, kanji, kana, id, true, pos));
    row.expressions.push({ text: kana, script: "kana", common: true, tags: [] });
    row.frequencies = [
      { source: "jiten-global", text: kana, reading: kana, rank: kanaRank },
      { source: "jiten-global", text: kanji, reading: kana, rank: wordRank },
    ];
    return JSON.stringify(row);
  };
  await install([
    ranked("jmdict:say", "言う", "いう", "v5u", 145, 25),
    ranked("jmdict:need", "要る", "いる", "v5r", 38, 2905),
    ranked("jmdict:go", "行く", "いく", "v5k-s", 172, 48),
    term("jmdict:quote", "と", null, "と", "quotation", true, "prt"),
    term("jmdict:purpose", "に", null, "に", "purpose", true, "prt"),
    term("jmdict:meet", "会う", "会う", "あう", "meet", true, "v5u"),
    term("jmdict:teacher", "先生", "先生", "せんせい", "teacher", true, "n"),
    JSON.stringify(travel),
  ]);
  for (const text of ["「行かない」といった。", "行かないといった。", "『行く』といった。", "「行く」と先生にいった。"]) {
    const tokens = await parseOffline(text, ["eng"], HOST);
    const past = tokens.find((token) => token.surface === "いった");
    assert.equal(past?.entry, "jmdict:say", text);
    assert.ok(past?.candidates?.some((candidate) => candidate.entry === "jmdict:need"), text);
    assert.ok(past?.candidates?.some((candidate) => candidate.entry === "jmdict:go"), text);
  }
  assert.equal((await parseOffline("行った。", ["eng"], HOST))[0]?.entry, "jmdict:go");
  assert.equal((await parseOffline("要った。", ["eng"], HOST))[0]?.entry, "jmdict:need");
  for (const text of ["会いにいった。", "旅行にいった。"]) {
    const purpose = await parseOffline(text, ["eng"], HOST);
    const motion = purpose.find((token) => token.surface === "いった");
    assert.equal(motion?.entry, "jmdict:go", text);
    assert.ok(motion?.candidates?.some((candidate) => candidate.entry === "jmdict:need"), text);
    assert.ok(motion?.candidates?.some((candidate) => candidate.entry === "jmdict:say"), text);
  }
  const isolated = (await parseOffline("いった。", ["eng"], HOST))[0]?.entry;
  for (const text of ["旅行に。いった。", "旅行にhelloいった。", "旅行に未未いった。"]) {
    const tokens = await parseOffline(text, ["eng"], HOST);
    assert.equal(tokens.find((token) => token.surface === "いった")?.entry, isolated, text);
  }
});

test("sentence-ending quoted speech splits without changing explicit listing lookup", async () => {
  const solve = JSON.parse(term("jmdict:solve", "解く", "解く", "とく", "solve", true, "v5k"));
  solve.expressions.push({ text: "とく", script: "kana", common: true, tags: [] });
  solve.frequencies = [{ source: "jiten-global", text: "解く", reading: "とく", rank: 1900 }];
  await install([
    term("jmdict:quote", "と", null, "と", "quotation", true, "prt"),
    term("jmdict:say", "言う", "言う", "いう", "say", true, "v5u"),
    JSON.stringify(solve),
    term("jmdict:listing", "といった", null, "といった", "such as", true, "conj"),
    term("jmdict:naming", "という", null, "という", "called", true, "exp"),
    term("jmdict:cat", "猫", "猫", "ねこ", "cat", true, "n"),
    term("jmdict:animal", "動物", "動物", "どうぶつ", "animal", true, "n"),
  ]);
  for (const surface of ["といった", "と言った"]) {
    const tokens = await parseOffline(`猫${surface}。`, ["eng"], HOST);
    assert.deepEqual(tokens.map((token) => token.surface), ["猫", "と", surface.slice(1), "。"]);
    assert.equal(tokens[2]?.entry, "jmdict:say");
  }
  assert.equal((await lookupOffline("といった", ["eng"], HOST))?.entry, "jmdict:listing");
  assert.ok((await parseOffline("猫といった動物", ["eng"], HOST)).some((token) => token.entry === "jmdict:listing"));
});

test("curated listing categories distinguish examples from a speaker", async () => {
  const listing = JSON.parse(term("jmdict:listing", "といった", "と言った", "といった", "such as", true, "conj"));
  listing.expressions.push({ text: "といった", script: "kana", common: true, tags: [] });
  await install([
    JSON.stringify(listing),
    term("jmdict:quote", "と", null, "と", "quotation", true, "prt"),
    term("jmdict:list", "や", null, "や", "and", true, "prt"),
    term("jmdict:say", "言う", "言う", "いう", "say", true, "v5u"),
    term("jmdict:naming", "と言う", "と言う", "という", "called", true, "exp"),
    ...["犬", "猫", "牛", "鳥", "魚", "医者", "先生", "作家", "動物", "人"].map((text) =>
      term(`jmdict:${text}`, text, text, text, text, true, "n")),
  ]);
  for (const text of ["犬や猫と言った動物", "鳥や魚と言った動物", "医者や先生と言った人", "作家や医者と言った人"]) {
    assert.ok((await parseOffline(text, ["eng"], HOST)).some((token) => token.entry === "jmdict:listing"), text);
  }
  for (const text of ["犬や猫と言った人", "犬や牛と言った人"]) {
    const tokens = await parseOffline(text, ["eng"], HOST);
    assert.ok(tokens.some((token) => token.entry === "jmdict:quote"), text);
    assert.ok(tokens.some((token) => token.entry === "jmdict:say"), text);
    assert.ok(!tokens.some((token) => token.entry === "jmdict:listing"), text);
  }
});

test("a dropped ra potential label follows the selected verb class", async () => {
  await install([
    term("jmdict:eat", "食べる", "食べる", "たべる", "eat", true, "v1"),
    term("jmdict:come", "来る", "来る", "くる", "come", true, "vk"),
    term("jmdict:return", "帰る", "帰る", "かえる", "return", true, "v5r"),
  ]);
  for (const surface of ["食べれる", "食べれない", "来れません"]) {
    assert.ok((await lookupOffline(surface, ["eng"], HOST))?.inflection?.includes("potential (ら抜き)"), surface);
  }
  assert.equal((await parseOffline("食べれない", ["eng"], HOST))[0]?.reading, "たべれない");
  for (const surface of ["帰れる", "食べられる", "来られる"]) {
    const popup = await lookupOffline(surface, ["eng"], HOST);
    assert.ok(popup?.inflection?.length, surface);
    assert.ok(!popup.inflection.includes("potential (ら抜き)"), surface);
  }
});

test("a specified or relatively modified man does not select the sexual idiom", async () => {
  const idiom = JSON.parse(term("jmdict:idiom", "男を知る", "男を知る", "おとこをしる", "lose one's virginity", true, "v5r"));
  idiom.senses[0].partsOfSpeech.push("exp");
  await install([
    JSON.stringify(idiom),
    term("jmdict:man", "男", "男", "おとこ", "man", true, "n"),
    term("jmdict:know", "知る", "知る", "しる", "know", true, "v5r"),
    term("jmdict:object", "を", null, "を", "object", true, "prt"),
    term("jmdict:this", "この", null, "この", "this", true, "adj-pn"),
    term("jmdict:that", "その", null, "その", "that", true, "adj-pn"),
    term("jmdict:first", "初めて", "初めて", "はじめて", "first time", true, "adv"),
    term("jmdict:play", "弾ける", "弾ける", "ひける", "can play", true, "v1"),
    term("jmdict:read", "読む", "読む", "よむ", "read", true, "v5m"),
    term("jmdict:speak", "話す", "話す", "はなす", "speak", true, "v5s"),
    term("jmdict:she", "彼女", "彼女", "かのじょ", "she", true, "pn"),
    term("jmdict:topic", "は", null, "は", "topic", true, "prt"),
    term("jmdict:question", "か", null, "か", "question", true, "prt"),
  ]);
  for (const text of ["この男を知っているか", "初めてその男を知った", "弾ける男を知っている", "読む男を知っている", "話さない男を知っている"]) {
    const tokens = await parseOffline(text, ["eng"], HOST);
    const diagnosis = JSON.stringify({ text, tokens: tokens.map(({ surface, entry }) => ({ surface, entry })) });
    assert.ok(tokens.some((token) => token.entry === "jmdict:man"), diagnosis);
    assert.ok(tokens.some((token) => token.entry === "jmdict:know"), diagnosis);
    assert.ok(!tokens.some((token) => token.entry === "jmdict:idiom"), diagnosis);
  }
  for (const text of ["男を知る", "初めて男を知った", "彼女は男を知った"]) {
    assert.ok((await parseOffline(text, ["eng"], HOST)).some((token) => token.entry === "jmdict:idiom"), text);
  }
  assert.equal((await lookupOffline("男を知った", ["eng"], HOST))?.entry, "jmdict:idiom");
});

test("de ii does not invent a progressive copula stem across the adjective boundary", async () => {
  const good = JSON.parse(term("jmdict:good", "いい", null, "いい", "good", true, "adj-ix"));
  good.frequencies = [{ source: "jiten-global", text: "いい", reading: "いい", rank: 100 }];
  const say = JSON.parse(term("jmdict:say", "言う", "言う", "いう", "say", true, "v5u"));
  say.expressions.push({ text: "いう", script: "kana", common: true, tags: [] });
  await install([
    JSON.stringify(good),
    JSON.stringify(say),
    term("jmdict:self", "私", "私", "わたし", "I", true, "pn"),
    term("jmdict:copula", "だ", null, "だ", "be", true, "cop"),
    term("jmdict:de", "で", null, "で", "with", true, "prt"),
    term("jmdict:quote", "と", null, "と", "quotation", true, "prt"),
    term("jmdict:thread", "糸", "糸", "いと", "thread", true, "n"),
  ]);
  assert.deepEqual((await parseOffline("私でいいと", ["eng"], HOST)).map((token) => token.surface), ["私", "で", "いい", "と"]);
  const adjective = (await parseOffline("いいと", ["eng"], HOST))[0];
  assert.equal(adjective.entry, "jmdict:good");
  assert.ok(!adjective.candidates?.some((candidate) => candidate.entry === "jmdict:say"));
  assert.ok((await parseOffline("いい", ["eng"], HOST))[0].candidates?.some((candidate) => candidate.entry === "jmdict:say"));
  for (const predicate of ["でいる", "でいたい", "でいて"]) {
    assert.deepEqual((await parseOffline(`私${predicate}`, ["eng"], HOST)).map((token) => token.surface), ["私", predicate]);
  }
});

test("benefactive reported speech keeps the quotation particle separate", async () => {
  const naming = JSON.parse(term("jmdict:naming", "と言う", "と言う", "という", "called", true, "exp"));
  naming.expressions.push({ text: "という", script: "kana", common: true, tags: [] });
  await install([
    JSON.stringify(naming),
    term("jmdict:quote", "と", null, "と", "quotation", true, "prt"),
    term("jmdict:say", "言う", "言う", "いう", "say", true, "v5u"),
    term("jmdict:good", "いい", null, "いい", "good", true, "adj-i"),
    term("jmdict:person", "人", "人", "ひと", "person", true, "n"),
  ]);
  for (const verb of ["言ってくれた", "言ってくれる", "言ってもらった", "言ってあげた", "言ってくださった", "言っていただいた", "言ってやった", "言って差し上げた"]) {
    const tokens = await parseOffline(`いいと${verb}人`, ["eng"], HOST);
    assert.deepEqual(tokens.map((token) => token.surface), ["いい", "と", verb, "人"]);
    assert.equal(tokens[2]?.entry, "jmdict:say");
  }
});

test("romaji compares both kana scripts before choosing a name over a common word", async () => {
  const name = JSON.parse(term("jmnedict:name", "花捺", "花捺", "ばなな", "Banana (name)", false));
  name.dictionary = "jmnedict";
  name.senses[0].partsOfSpeech = [];
  await install([term("jmdict:banana", "バナナ", null, "バナナ", "banana"), JSON.stringify(name)]);
  assert.equal((await lookupOffline("banana", ["eng"], HOST))?.entry, "jmdict:banana");
  assert.equal((await lookupOffline("ばなな", ["eng"], HOST))?.entry, "jmnedict:name");
  assert.equal((await lookupOffline("バナナ", ["eng"], HOST))?.entry, "jmdict:banana");
});

test("half-width voiced katakana keeps its whole word and original offsets", async () => {
  const ha = JSON.parse(term("jmdict:ha", "ハ", null, "ハ", "ha"));
  ha.frequencies = [{ source: "test", text: "ハ", reading: "ハ", rank: 1 }];
  await install([
    term("jmdict:banana", "バナナ", null, "バナナ", "banana"),
    JSON.stringify(ha),
    term("jmdict:nana", "ナナ", null, "ナナ", "Nana"),
    term("jmdict:bread", "パン", null, "パン", "bread"),
    term("jmdict:coffee", "コーヒー", null, "コーヒー", "coffee"),
  ]);
  for (const [surface, entry] of [["バナナ", "banana"], ["ﾊﾞﾅﾅ", "banana"], ["ﾊﾟﾝ", "bread"], ["ｺｰﾋｰ", "coffee"]]) {
    const tokens = await parseOffline(surface + "。", ["eng"], HOST);
    assert.equal(tokens[0]?.surface, surface);
    assert.equal(tokens[0]?.entry, `jmdict:${entry}`);
    assert.equal(tokens[0]?.length, surface.length);
    assert.equal(tokens[1]?.start, surface.length);
    assert.equal(tokens.map((token) => token.surface).join(""), surface + "。");
  }
});

test("decomposed kana inside a sentence keeps its entry and original UTF16 offsets", async () => {
  await install([term("jmdict:eat", "食べる", "食べる", "たべる", "eat", true, "v1")]);
  const text = "🍣を食へ\u3099ました。";
  const tokens = await parseOffline(text, ["eng"], HOST);
  assert.equal(tokens.map((token) => token.surface).join(""), text);
  const token = tokens.find((item) => item.surface === "食へ\u3099ました");
  assert.ok(token);
  assert.equal(token.entry, "jmdict:eat");
  assert.equal(token.lemma, "食べる");
  assert.equal(token.start, 3);
  assert.equal(token.length, 6);
  assert.equal(tokens[tokens.length - 1]?.start, 9);
});

test("a selected copula does not offer the voiced past auxiliary", async () => {
  const past = JSON.parse(term("jmdict:past", "た", null, "た", "past", false, "aux-v"));
  past.expressions.push({ text: "だ", script: "kana", common: false, tags: [] });
  past.readings.push({ text: "だ", kind: "kana" });
  await install([
    term("jmdict:thus", "そう", null, "そう", "so", true, "adv"),
    term("jmdict:copula", "だ", null, "だ", "be", true, "cop"),
    JSON.stringify(past),
  ]);
  const token = (await parseOffline("そうだ", ["eng"], HOST)).find((candidate) => candidate.surface === "だ");
  assert.equal(token?.entry, "jmdict:copula");
  assert.ok(!token?.candidates?.some((candidate) => candidate.entry === "jmdict:past"));
  assert.equal((await lookupEntryOffline("jmdict:past", "だ", ["eng"], HOST))?.entry, "jmdict:past");
});

test("de connects a na-adjective through the copula without changing a noun's case particle", async () => {
  await install([
    term("jmdict:quiet", "静か", "静か", "しずか", "quiet", true, "adj-na"),
    term("jmdict:beautiful", "美しい", "美しい", "うつくしい", "beautiful", true, "adj-i"),
    term("jmdict:school", "学校", "学校", "がっこう", "school"),
    term("jmdict:learn", "学ぶ", "学ぶ", "まなぶ", "learn", true, "v5b"),
    term("jmdict:copula", "だ", null, "だ", "be", true, "cop"),
    term("jmdict:particle", "で", null, "で", "at", true, "prt"),
  ]);
  for (const text of ["静かで美しい。", "静かで"]) {
    const token = (await parseOffline(text, ["eng"], HOST)).find((candidate) => candidate.surface === "で");
    assert.equal(token?.entry, "jmdict:copula", text);
    assert.equal(token?.lemma, "だ", text);
  }
  for (const text of ["学校で学ぶ。", "で"]) {
    const token = (await parseOffline(text, ["eng"], HOST)).find((candidate) => candidate.surface === "で");
    assert.equal(token?.entry, "jmdict:particle", text);
    assert.equal(token?.lemma, "で", text);
  }
});

test("an unfinished noun plus de retains both case particle and copula readings", async () => {
  await install([
    term("jmdict:eye", "目", "目", "め", "eye", true, "n"),
    term("jmdict:doctor", "医者", "医者", "いしゃ", "doctor", true, "n"),
    term("jmdict:copula", "だ", null, "だ", "be", true, "cop"),
    term("jmdict:particle", "で", null, "で", "with", true, "prt"),
  ]);
  for (const text of ["目で", "医者で", "目で  "]) {
    const token = (await parseOffline(text, ["eng"], HOST)).find((candidate) => candidate.surface === "で");
    const entries = token?.candidates?.map((candidate) => candidate.entry) ?? [token?.entry];
    assert.ok(entries.includes("jmdict:particle"), text);
    assert.ok(entries.includes("jmdict:copula"), text);
  }
});

test("a topic-marked occupation ends with a copula rather than a location particle", async () => {
  await install([
    term("jmdict:he", "彼", "彼", "かれ", "he", true, "pn"),
    term("jmdict:doctor", "医者", "医者", "いしゃ", "doctor", true, "n"),
    term("jmdict:school", "学校", "学校", "がっこう", "school", true, "n"),
    term("jmdict:topic", "は", null, "は", "topic", true, "prt"),
    term("jmdict:subject", "が", null, "が", "subject", true, "prt"),
    term("jmdict:also", "も", null, "も", "also", true, "prt"),
    term("jmdict:copula", "だ", null, "だ", "be", true, "cop"),
    term("jmdict:particle", "で", null, "で", "at", true, "prt"),
  ]);
  for (const text of ["彼は医者で", "彼が医者で", "彼も医者で", "彼は  医者で", "彼は\u3000医者で", "彼は医者で  "]) {
    const predicate = (await parseOffline(text, ["eng"], HOST)).find((token) => token.surface === "で");
    assert.equal(predicate?.entry, "jmdict:copula", text);
    assert.equal(predicate?.lemma, "だ", text);
    assert.ok(predicate?.candidates?.some((candidate) => candidate.entry === "jmdict:particle"), text);
  }
  for (const text of ["彼は学校で", "彼も学校で", "彼は\u3000学校で"]) {
    const location = (await parseOffline(text, ["eng"], HOST)).find((token) => token.surface === "で");
    assert.equal(location?.entry, "jmdict:particle", text);
  }
});

test("path scoring keeps a noun compound before its particle rather than starting an idiom inside it", async () => {
  const words: [string, string, string, string, number][] = [
    ["天気", "てんき", "weather", "n", 3428], ["天", "てん", "heaven", "n", 2147],
    ["気", "き", "spirit", "n", 253], ["気になる", "きになる", "be concerned", "exp", 436],
    ["に", "に", "result marker", "prt", 3], ["なる", "なる", "become", "v5r", 19],
  ];
  await install(words.map(([word, reading, gloss, pos, rank]) => {
    const record = JSON.parse(term(`jmdict:${word}`, word, word, reading, gloss, true, pos));
    record.frequencies = [{ source: "test", text: word, reading, rank }];
    return JSON.stringify(record);
  }));
  assert.deepEqual((await parseOffline("天気になる", ["eng"], HOST)).map((token) => token.surface), ["天気", "に", "なる"]);
  assert.equal((await lookupOffline("気になる", ["eng"], HOST))?.entry, "jmdict:気になる");
});

test("resultative ni prefers become while explicit ringing remains a separate word", async () => {
  const become = JSON.parse(term("jmdict:become", "成る", "成る", "なる", "become", true, "v5r"));
  become.senses[0].partsOfSpeech.push("aux-v");
  become.expressions.push({ text: "なる", script: "kana", common: true, tags: [] });
  become.frequencies = [{ source: "test", text: "成る", reading: "なる", rank: 9019 }];
  const ring = JSON.parse(term("jmdict:ring", "鳴る", "鳴る", "なる", "ring", true, "v5r"));
  ring.expressions.push({ text: "なる", script: "kana", common: true, tags: [] });
  ring.frequencies = [{ source: "test", text: "鳴る", reading: "なる", rank: 1477 }];
  await install([JSON.stringify(become), JSON.stringify(ring),
    term("jmdict:weather", "天気", "天気", "てんき", "weather"),
    term("jmdict:ni", "に", null, "に", "result marker", true, "prt"),
    term("jmdict:bell", "鐘", "鐘", "かね", "bell"),
    term("jmdict:ga", "が", null, "が", "subject", true, "prt"),
  ]);
  for (const surface of ["なる", "なった", "ならなかった"]) {
    const token = (await parseOffline(`天気に${surface}`, ["eng"], HOST)).find((token) => token.surface === surface);
    assert.equal(token?.entry, "jmdict:become", surface);
    assert.ok(token?.candidates?.some((candidate) => candidate.entry === "jmdict:ring"), surface);
  }
  const explicit = (await parseOffline("天気に鳴る", ["eng"], HOST)).find((token) => token.surface === "鳴る");
  assert.equal(explicit?.entry, "jmdict:ring");
  const sounding = (await parseOffline("鐘がなる", ["eng"], HOST)).find((token) => token.surface === "なる");
  assert.equal(sounding?.entry, "jmdict:ring");
});

test("suru after a verbal noun excludes unrelated suru-reading verbs", async () => {
  await install([
    term("jmdict:study", "勉強", "勉強", "べんきょう", "study", true, "vs"),
    term("jmdict:do", "する", null, "する", "do", true, "vs-i"),
    term("jmdict:print", "刷る", "刷る", "する", "print", true, "v5r"),
  ]);
  const suru = (await parseOffline("勉強する", ["eng"], HOST)).find((token) => token.surface === "する");
  assert.equal(suru?.entry, "jmdict:do");
  assert.ok(!suru?.candidates?.some((candidate) => candidate.entry === "jmdict:print"));
  assert.ok((await parseOffline("する", ["eng"], HOST))[0]?.candidates?.some((candidate) => candidate.entry === "jmdict:print"));
  assert.equal((await lookupEntryOffline("jmdict:print", "刷る", ["eng"], HOST))?.entry, "jmdict:print");
});

test("a selected case particle keeps its particle alternatives instead of conjugating the copula", async () => {
  await install([
    term("jmdict:school", "学校", "学校", "がっこう", "school"),
    term("jmdict:de", "で", null, "で", "at", true, "prt"),
    term("jmdict:connective", "で", null, "で", "and", false, "conj"),
    term("jmdict:copula", "だ", null, "だ", "be", true, "cop"),
    term("jmdict:learn", "学ぶ", "学ぶ", "まなぶ", "learn", true, "v5b"),
  ]);
  const particle = (await parseOffline("学校で学ぶ", ["eng"], HOST)).find((token) => token.surface === "で");
  assert.equal(particle?.entry, "jmdict:de");
  assert.deepEqual(particle?.candidates?.map((candidate) => candidate.entry), ["jmdict:de", "jmdict:connective"]);
});

test("a complete written name survives more frequent single-character names", async () => {
  const name = (id: string, writing: string, reading: string, rank: number) => {
    const record = JSON.parse(term(id, writing, writing, reading, writing, false));
    record.dictionary = "jmnedict";
    record.senses[0].partsOfSpeech = [];
    record.frequencies = [{ source: "test", text: writing, reading, rank }];
    return JSON.stringify(record);
  };
  await install([
    name("jmnedict:5238722", "啓太", "けいた", 84_941),
    name("jmnedict:5238365", "啓", "あきら", 49_469),
    name("jmnedict:5484340", "太", "おお", 17_649),
    name("jmnedict:student-name", "学生", "がくせい", 200_000),
    term("jmdict:student", "学生", "学生", "がくせい", "student"),
    name("jmnedict:verb-prefix", "仰", "あお", 200_000),
    term("jmdict:honorific", "仰有る", "仰有る", "おっしゃる", "say respectfully", false, "v5aru"),
    term("jmdict:question", "か", null, "か", "question", true, "prt"),
  ]);
  for (const text of ["啓太", "啓太。", "啓太か。", "啓太　啓"]) {
    const tokens = await parseOffline(text, ["eng"], HOST);
    assert.equal(tokens[0]?.surface, "啓太", text);
    assert.equal(tokens[0]?.entry, "jmnedict:5238722", text);
  }
  assert.equal((await parseOffline("学生か。", ["eng"], HOST))[0]?.entry, "jmdict:student");
  assert.deepEqual((await parseOffline("啓太学生", ["eng"], HOST)).map((token) => token.surface), ["啓太", "学生"]);
  assert.notEqual((await parseOffline("啓未", ["eng"], HOST))[0]?.surface, "啓未");
  assert.equal((await parseOffline("仰有いました。", ["eng"], HOST))[0]?.surface, "仰有いました");
});

test("a lexical past copula supplies the reading of its study base", async () => {
  await install([
    term("jmdict:plain", "だ", null, "だ", "be", true, "cop"),
    term("jmdict:past", "だった", null, "だった", "was", false, "exp"),
  ]);
  const definition = await lookupEntryOffline("jmdict:past", "だった", ["eng"], HOST);
  assert.equal(definition?.headword, "だった");
  assert.equal(definition?.reading, "だった");
  assert.equal(definition?.baseForm, "だ");
  assert.equal(definition?.baseReading, "だ");
  assert.equal(definition?.entry, "jmdict:past");
});

test("a polite past copula explains itself as past rather than a suru verb", async () => {
  await install([
    term("jmdict:plain", "だ", null, "だ", "be", true, "cop"),
    term("jmdict:polite", "です", null, "です", "polite be", true, "cop"),
    term("jmdict:noun-homophone", "です", null, "です", "noun homophone", false, "n"),
  ]);
  const definition = await lookupOffline("でした", ["eng"], HOST);
  assert.equal(definition?.headword, "です");
  assert.deepEqual(definition?.inflection, ["past"]);
  const selected = await lookupEntryOffline("jmdict:polite", "でした", ["eng"], HOST);
  assert.equal(selected?.entry, "jmdict:polite");
  assert.deepEqual(selected?.inflection, ["past"]);
  for (const surface of ["deshita", "de  shita", "ＤＥＳＨＩＴＡ"]) {
    const romanized = await lookupEntryOffline("jmdict:polite", surface, ["eng"], HOST);
    assert.equal(romanized?.entry, "jmdict:polite");
    assert.deepEqual(romanized?.inflection, ["past"], surface);
  }
  assert.deepEqual((await lookupEntryOffline("jmdict:polite", "食べた", ["eng"], HOST))?.inflection, []);
  const noun = await lookupEntryOffline("jmdict:noun-homophone", "でした", ["eng"], HOST);
  assert.equal(noun?.entry, "jmdict:noun-homophone");
  assert.deepEqual(noun?.inflection, []);
});

test("a conditional auxiliary retains its entry while recovering the copula base", async () => {
  await install([
    term("jmdict:conditional", "なら", null, "なら", "if", true, "aux"),
    term("jmdict:plain", "だ", null, "だ", "be", true, "cop"),
    term("jmdict:student", "学生", "学生", "がくせい", "student"),
    term("jmdict:nara", "奈良", "奈良", "なら", "Nara", true, "n"),
    term("jmdict:polite", "です", null, "です", "polite be", true, "aux"),
  ]);
  const tokens = await parseOffline("学生なら", ["eng"], HOST);
  assert.equal(tokens[1]?.surface, "なら");
  assert.equal(tokens[1]?.entry, "jmdict:conditional");
  assert.equal(tokens[1]?.lemma, "だ");
  assert.ok(tokens[1]?.candidates?.some((candidate) => candidate.entry === "jmdict:plain"));
  assert.equal((await parseOffline("奈良", ["eng"], HOST))[0]?.lemma, "奈良");
  assert.equal((await parseOffline("です", ["eng"], HOST))[0]?.lemma, "です");
  assert.equal((await lookupOffline("なら", ["eng"], HOST))?.headword, "なら");
  for (const definition of [
    await lookupOffline("なら", ["eng"], HOST),
    await lookupEntryOffline("jmdict:conditional", "なら", ["eng"], HOST),
    await lookupEntryOffline("jmdict:conditional", "ＮＡ  ＲＡ", ["eng"], HOST),
  ]) {
    assert.equal(definition?.entry, "jmdict:conditional");
    assert.equal(definition?.headword, "なら");
    assert.deepEqual(definition?.inflection, ["conditional (〜なら)"]);
    assert.equal(definition?.inflectionBase, "だ");
  }
  for (const [entry, surface] of [["jmdict:nara", "奈良"], ["jmdict:nara", "なら"], ["jmdict:conditional", "食べた"]]) {
    const definition = await lookupEntryOffline(entry!, surface!, ["eng"], HOST);
    assert.deepEqual(definition?.inflection, []);
    assert.equal(definition?.inflectionBase, undefined);
  }
  await install([term("jmdict:conditional", "なら", null, "なら", "if", true, "aux")]);
  const missingBase = await lookupEntryOffline("jmdict:conditional", "なら", ["eng"], HOST);
  assert.deepEqual(missingBase?.inflection, []);
  assert.equal(missingBase?.inflectionBase, undefined);
  await install([
    term("jmdict:conditional", "なら", null, "なら", "if", true, "aux"),
    term("jmdict:homophone", "だ", null, "だ", "noun homophone", true, "n"),
  ]);
  assert.deepEqual((await lookupEntryOffline("jmdict:conditional", "なら", ["eng"], HOST))?.inflection, []);
});

test("a lexical past-copula entry keeps its identity but uses the copula base", async () => {
  await install([
    term("jmdict:past", "だった", null, "だった", "was", true, "exp"),
    term("jmdict:plain", "だ", null, "だ", "be", true, "cop"),
    term("jmdict:cat", "猫", "猫", "ねこ", "cat"),
  ]);
  for (const text of ["だった", "猫だった。"]) {
    const tokens = await parseOffline(text, ["eng"], HOST);
    const past = tokens.find((token) => token.surface === "だった");
    assert.equal(past?.entry, "jmdict:past");
    assert.equal(past?.lemma, "だ");
    assert.ok(past?.candidates?.some((candidate) => candidate.entry === "jmdict:plain"));
  }
  assert.equal((await lookupOffline("だった", ["eng"], HOST))?.headword, "だった");
  const past = await lookupEntryOffline("jmdict:past", "だった", ["eng"], HOST);
  assert.deepEqual(past?.inflection, ["past"]);
  assert.equal(past?.inflectionBase, "だ");
  await install([term("jmdict:past", "だった", null, "だった", "was", true, "exp")]);
  assert.equal((await parseOffline("だった", ["eng"], HOST))[0]?.lemma, "だった");
  await install([
    term("jmdict:literal", "だった", null, "だった", "literal noun", true, "n"),
    term("jmdict:plain", "だ", null, "だ", "be", true, "cop"),
  ]);
  assert.equal((await parseOffline("だった", ["eng"], HOST))[0]?.lemma, "だった");
});

function term(id: string, headword: string, kanji: string | null, kana: string, gloss: string, common = true, pos = "n") {
  return JSON.stringify({
    type: "term", id, dictionary: "jmdict", headword,
    expressions: kanji
      ? [ { text: kanji, script: "kanji", common, tags: [] } ]
      : [ { text: kana, script: "kana", common, tags: [] } ],
    readings: [ { text: kana, kind: "kana" } ],
    senses: [ { glosses: { eng: [ gloss ] }, partsOfSpeech: [ pos ], fields: [], misc: [], dialects: [], restrictions: [] } ],
  });
}

const HEADER = JSON.stringify({ type: "header", schemaVersion: 6, languages: [ "eng", "spa" ], source: "Shirabe candidates" });

// The revision has to differ per pack: the installer treats a repeated one as
// "already have this" and keeps whatever is installed, so two tests sharing a
// revision silently run against each other's dictionary.
async function install(lines: string[]): Promise<void> {
  const revision = createHash("sha256").update(lines.join("\n")).digest("hex").slice(0, 12);
  await installTestPack(packPayload([ HEADER, ...lines ]), { contentRevision: revision, terms: lines.length });
}

test("a literal written noun survives common shorter competitors without swallowing a following adverb", async () => {
  const ranked = (id: string, writing: string, reading: string, rank: number, pos = "n") => {
    const record = JSON.parse(term(id, writing, writing, reading, writing, rank < 10_000, pos));
    record.frequencies = [{ source: "test", text: writing, reading, rank }];
    return JSON.stringify(record);
  };
  await install([
    ranked("jmdict:rare-homograph", "一人静", "いちにんせい", 300_000),
    ranked("jmdict:plant", "一人静", "ひとりしずか", 261_000),
    ranked("jmdict:alone", "一人", "ひとり", 588),
    ranked("jmdict:quiet", "静", "せい", 23_725),
    ranked("jmdict:quietly", "静かに", "しずかに", 1170, "adv"),
  ]);
  for (const text of ["一人静", "一人静。", "一人静　静かに"]) {
    const tokens = await parseOffline(text, ["eng"], HOST);
    assert.equal(tokens[0]?.surface, "一人静", text);
    assert.equal(tokens[0]?.entry, "jmdict:plant", text);
  }
  const sentence = await parseOffline("一人静かに", ["eng"], HOST);
  assert.deepEqual(sentence.map((token) => token.surface), ["一人", "静かに"]);
});

test("a lexical number word retains its entry even when its suffix is a counter", async () => {
  await install([
    term("jmdict:alone", "一人", "一人", "ひとり", "alone"),
    term("jmdict:people", "人", "人", "にん", "people counter", true, "ctr"),
    term("jmdict:seven", "七本", "七本", "ななほん", "seven long objects"),
    term("jmdict:counter", "本", "本", "ほん", "long object counter", true, "ctr"),
  ]);
  for (const [text, entry] of [["一人", "jmdict:alone"], ["七本", "jmdict:seven"]]) {
    const tokens = await parseOffline(text!, ["eng"], HOST);
    assert.equal(tokens.length, 1, text);
    assert.equal(tokens[0]?.entry, entry, text);
  }
});

test("ASCII and full-width digits enter the same Japanese word lookup", async () => {
  await install([
    term("jmdict:three", "三つ", "３つ", "みっつ", "three"),
    term("jmdict:horn", "角", null, "つの", "horn"),
    term("jmdict:of", "の", null, "の", "of", true, "prt"),
  ]);
  for (const surface of ["3つ", "３つ"]) {
    const tokens = await parseOffline(`hello ${surface}の`, ["eng"], HOST);
    assert.equal(tokens[0]?.surface, "hello ");
    assert.equal(tokens[1]?.surface, surface);
    assert.equal(tokens[1]?.entry, "jmdict:three");
    assert.equal(tokens[1]?.lemma, "三つ");
    assert.equal(tokens[2]?.surface, "の");
  }
  for (const number of ["12345", "１２３４５"]) {
    const tokens = await parseOffline(`hello ${number} world`, ["eng"], HOST);
    assert.deepEqual(tokens.map((token) => token.surface), ["hello ", number, " world"]);
    assert.ok(tokens.every((token) => !token.entry));
  }
  const card = await lookupEntryOffline("jmdict:three", "3つ", ["eng"], HOST);
  assert.equal(card?.headword, "３つ");
  assert.equal(card?.baseForm, "三つ");
});

test("kana and digit numeral spellings share a base without changing their popup spelling", async () => {
  const one = JSON.parse(term("jmdict:one", "一つ", "一つ", "ひとつ", "one", true, "num"));
  one.expressions.push({ text: "ひとつ", script: "kana", common: true, tags: [] });
  one.expressions.push({ text: "１つ", script: "kanji", common: false, tags: [] });
  await install([JSON.stringify(one)]);
  for (const [surface, title] of [["ひとつ", "ひとつ"], ["一つ", "一つ"], ["1つ", "１つ"], ["１つ", "１つ"]]) {
    const [token] = await parseOffline(surface!, ["eng"], HOST);
    assert.equal(token?.entry, "jmdict:one", surface);
    assert.equal(token?.lemma, "一つ", surface);
    assert.equal((await lookupOffline(surface!, ["eng"], HOST))?.headword, title, surface);
    assert.equal((await lookupOffline(surface!, ["eng"], HOST))?.baseForm, "一つ", surface);
    assert.equal((await lookupEntryOffline("jmdict:one", surface!, ["eng"], HOST))?.baseForm, "一つ", surface);
  }
});

test("an adjective with attached ni retains its literal name alternative", async () => {
  const name = JSON.parse(term("jmnedict:kamite", "上手", "上手", "かみて", "Kamite", false));
  name.dictionary = "jmnedict";
  name.senses[0].partsOfSpeech = [];
  await install([
    term("jmdict:skilled", "上手", "上手", "じょうず", "skilled", true, "adj-na"),
    term("jmdict:speak", "話す", "話す", "はなす", "speak", true, "v5s"),
    JSON.stringify(name),
  ]);
  const [token] = await parseOffline("上手に話す", ["eng"], HOST);
  assert.equal(token.surface, "上手に");
  assert.equal(token.entry, "jmdict:skilled");
  assert.ok(token.candidates?.some((candidate) => candidate.entry === "jmnedict:kamite"));
});

test("adverbial na-adjectives keep ni without absorbing noun particles or word prefixes", async () => {
  await install([
    term("jmdict:skilled", "上手", "上手", "じょうず", "skilled", true, "adj-na"),
    term("jmdict:school", "学校", "学校", "がっこう", "school"),
    term("jmdict:ni", "に", null, "に", "to", true, "prt"),
    term("jmdict:speak", "話す", "話す", "はなす", "speak", true, "v5s"),
    term("jmdict:blur", "滲む", null, "にじむ", "blur", true, "v5m"),
  ]);
  const adverbial = await parseOffline("上手に話す", ["eng"], HOST);
  assert.deepEqual(adverbial.map((token) => token.surface), ["上手に", "話す"]);
  assert.equal(adverbial[0]?.lemma, "上手");
  assert.equal(adverbial[0]?.reading, "じょうずに");
  assert.equal(adverbial[0]?.entry, "jmdict:skilled");
  for (const text of ["学校に話す", "上手にじむ"]) {
    const tokens = await parseOffline(text, ["eng"], HOST);
    assert.equal(tokens[0]?.surface, text.slice(0, 2));
    assert.equal(tokens.map((token) => token.surface).join(""), text);
  }
});

test("verbatim inflections do not offer homophones created by collapsing emphasis", async () => {
  await install([
    term("jmdict:meet", "会う", "会う", "あう", "meet", true, "v5u"),
    term("jmdict:unit", "咫", null, "あた", "old unit of length", false),
    term("jmdict:great", "凄い", null, "すごい", "great", true, "adj-i"),
    term("jmdict:katakana", "カク", null, "カク", "katakana word"),
    term("jmdict:write", "書く", "書く", "かく", "write", true, "v5k"),
  ]);
  const [past] = await parseOffline("あった", ["eng"], HOST);
  assert.equal(past?.entry, "jmdict:meet");
  assert.ok(!past?.candidates?.some((candidate) => candidate.entry === "jmdict:unit"));
  assert.equal((await parseOffline("あた", ["eng"], HOST))[0]?.entry, "jmdict:unit");
  assert.equal((await parseOffline("すっごーい", ["eng"], HOST))[0]?.entry, "jmdict:great");
  const [katakana] = await parseOffline("カク", ["eng"], HOST);
  assert.ok(katakana?.candidates?.some((candidate) => candidate.entry === "jmdict:write"));
});

test("a particle does not offer an auxiliary verb stem merely tagged as an expression", async () => {
  const auxiliary = JSON.parse(term("jmdict:progressive", "てる", null, "でる", "be doing", false, "exp"));
  auxiliary.senses[0].partsOfSpeech.push("aux-v", "v1");
  await install([
    term("jmdict:particle", "で", null, "で", "by", true, "prt"),
    term("jmdict:expression", "で", null, "で", "and then", false, "exp"),
    term("jmdict:copula", "で", null, "で", "being", false, "cop"),
    JSON.stringify(auxiliary),
  ]);
  const [particle] = await parseOffline("で", ["eng"], HOST);
  assert.equal(particle?.entry, "jmdict:particle");
  const entries = particle?.candidates?.map((candidate) => candidate.entry) ?? [];
  assert.ok(!entries.includes("jmdict:progressive"));
  assert.ok(entries.includes("jmdict:expression"));
  assert.ok(entries.includes("jmdict:copula"));
  assert.equal((await lookupOffline("でる", ["eng"], HOST))?.entry, "jmdict:progressive");
});

test("a rebuilt expression retains its base and same-span alternatives", async () => {
  const ranked = (id: string, headword: string, writing: string, reading: string, pos: string, rank: number) => {
    const record = JSON.parse(term(id, headword, writing, reading, headword, true, pos));
    record.frequencies = [{ source: "test", text: writing, reading, rank }];
    return JSON.stringify(record);
  };
  await install([
    ranked("jmdict:expression", "そうとも", "然うとも", "そうとも", "exp", 1_000_000),
    ranked("jmdict:alternative", "そうとも", "然うとも", "そうとも", "exp", 2_000_000),
    ranked("jmdict:so", "然う", "然う", "そう", "adv", 1),
    ranked("jmdict:to", "と", "と", "と", "prt", 1),
    ranked("jmdict:mo", "も", "も", "も", "prt", 1),
    ranked("jmdict:think", "思う", "思う", "おもう", "v5u", 1),
  ]);
  const tokens = await parseOffline("然うとも思う", ["eng"], HOST);
  assert.equal(tokens.length, 2);
  assert.equal(tokens[0]?.surface, "然うとも");
  assert.equal(tokens[0]?.lemma, "そうとも");
  assert.equal(tokens[0]?.entry, "jmdict:expression");
  assert.deepEqual(tokens[0]?.candidates?.map((candidate) => candidate.entry), ["jmdict:expression", "jmdict:alternative"]);
});

test("a span several words claim offers them all, the chosen one first", async () => {
  await install([
    term("jmdict:1247250", "君", "君", "きみ", "you"),
    term("jmdict:1182060", "黄身", "黄身", "きみ", "egg yolk", false),
  ]);

  const [ token ] = await parseOffline("きみ", [ "eng" ], HOST);

  assert.ok(token.candidates, "a span two words claim is a question, not an answer");
  assert.equal(token.candidates[0].entry, token.entry,
    "the head is the word this token resolved to, so a caller reading only the first gets `entry`");
  assert.deepEqual(new Set(token.candidates.map((candidate) => candidate.entry)),
    new Set([ "jmdict:1247250", "jmdict:1182060" ]),
    "both are reachable: ranked, never filtered");
});

test("independent interjections lead without replacing attached explanatory auxiliaries", async () => {
  const auxiliary = JSON.parse(term("jmdict:aux", "なのだ", null, "なんだ", "it is that", true, "aux"));
  auxiliary.expressions.push({ text: "なのだ", script: "kana", common: true, tags: [] });
  await install([
    term("jmdict:int", "なんだ", null, "なんだ", "oh", false, "int"),
    JSON.stringify(auxiliary),
    term("jmdict:student", "学生", "学生", "がくせい", "student"),
    term("jmdict:this", "これ", null, "これ", "this", true, "pn"),
    term("jmdict:topic", "は", null, "は", "topic", true, "prt"),
    term("jmdict:possessive", "の", null, "の", "possessive", true, "prt"),
    term("jmdict:me", "僕", "僕", "ぼく", "I", true, "pn"),
  ]);
  for (const text of ["なんだ、啓太か。", "なんだ。", "なんだ", "　なんだ、", "学生。なんだ、", "これはなんだ。"]) {
    const tokens = await parseOffline(text, ["eng"], HOST);
    const token = tokens.find((word) => word.surface === "なんだ");
    assert.equal(token?.entry, "jmdict:int", text);
    assert.ok(token?.candidates?.some((candidate) => candidate.entry === "jmdict:aux"), text);
  }
  for (const text of ["学生なんだ。", "学生なんだ、", "なのだ。", "これのなんだ。", "これは僕のなんだ。"]) {
    const tokens = await parseOffline(text, ["eng"], HOST);
    assert.ok(!tokens.some((token) => token.entry === "jmdict:int"), text);
    assert.ok(tokens.some((token) => token.entry === "jmdict:aux"), text);
  }
});

test("a particle-marked pronoun excludes verb inflections but isolated kana keeps them", async () => {
  await install([
    term("jmdict:that", "それ", null, "それ", "that", true, "pn"),
    term("jmdict:homophone", "それ", null, "それ", "an exact homophone", false, "n"),
    term("jmdict:shave", "剃る", "剃る", "そる", "to shave", true, "v5r"),
    term("jmdict:object", "を", null, "を", "object marker", true, "prt"),
  ]);

  const [pronoun] = await parseOffline("それを", ["eng"], HOST);
  assert.equal(pronoun.entry, "jmdict:that");
  assert.deepEqual(pronoun.candidates?.map((candidate) => candidate.entry), ["jmdict:that", "jmdict:homophone"]);

  const [isolated] = await parseOffline("それ", ["eng"], HOST);
  assert.ok(isolated.candidates?.some((candidate) => candidate.entry === "jmdict:shave"));

  const [imperative] = await parseOffline("剃れ", ["eng"], HOST);
  assert.equal(imperative.entry, "jmdict:shave");
});

test("a noun before an actual particle excludes imperatives but keeps isolated ambiguity", async () => {
  await install([
    term("jmdict:rain", "雨", null, "あめ", "rain"),
    term("jmdict:knit", "編む", "編む", "あむ", "knit", true, "v5m"),
    term("jmdict:object", "を", null, "を", "object marker", true, "prt"),
    term("jmdict:blur", "滲む", null, "にじむ", "blur", true, "v5m"),
  ]);
  const [marked] = await parseOffline("あめを", ["eng"], HOST);
  assert.equal(marked?.entry, "jmdict:rain");
  assert.ok(!marked?.candidates?.some((candidate) => candidate.entry === "jmdict:knit"));
  for (const text of ["あめ", "あめにじむ"]) {
    const [word] = await parseOffline(text, ["eng"], HOST);
    assert.ok(word?.candidates?.some((candidate) => candidate.entry === "jmdict:knit"), text);
  }
});

test("alternatives prefer the selected reading before a more frequent derived verb", async () => {
  const ranked = (record: string, rank: number) => {
    const row = JSON.parse(record);
    row.frequencies = [{ source: "test", text: row.headword, reading: row.readings[0].text, rank }];
    return JSON.stringify(row);
  };
  await install([
    ranked(term("jmdict:rain", "雨", null, "あめ", "rain"), 1),
    ranked(term("jmdict:candy", "飴", "飴", "あめ", "candy"), 100),
    ranked(term("jmdict:knit", "編む", "編む", "あむ", "knit", true, "v5m"), 10),
  ]);
  const [word] = await parseOffline("あめ", ["eng"], HOST);
  assert.equal(word?.entry, "jmdict:rain");
  assert.deepEqual(word?.candidates?.map((candidate) => candidate.entry),
    ["jmdict:rain", "jmdict:candy", "jmdict:knit"]);
});

test("an adverb directly before a predicate excludes a finite n-negative but keeps isolated ambiguity", async () => {
  const plenty = JSON.parse(term("jmdict:plenty", "たくさん", null, "たくさん", "plenty"));
  plenty.senses[0].partsOfSpeech = ["adj-no", "adj-na", "n", "adv"];
  await install([
    JSON.stringify(plenty),
    term("jmdict:entrust", "託す", "託す", "たくす", "entrust", true, "v5s"),
    term("jmdict:eat", "食べる", "食べる", "たべる", "eat", true, "v1"),
    term("jmdict:quote", "と", null, "と", "quote", true, "prt"),
  ]);
  const [contextual] = await parseOffline("たくさん食べた。", ["eng"], HOST);
  assert.equal(contextual?.entry, "jmdict:plenty");
  assert.ok(!contextual?.candidates?.some((candidate) => candidate.entry === "jmdict:entrust"));
  for (const text of ["たくさん", "たくさん。", "たくさんと食べた。"]) {
    const [word] = await parseOffline(text, ["eng"], HOST);
    assert.ok(word?.candidates?.some((candidate) => candidate.entry === "jmdict:entrust"), text);
  }
});

test("an adjective before a nominalizer excludes continuative verb alternatives without losing isolated ambiguity", async () => {
  await install([
    term("jmdict:good", "いい", null, "いい", "good", true, "adj-ix"),
    term("jmdict:say", "言う", "言う", "いう", "say", true, "v5u"),
    term("jmdict:although", "のに", null, "のに", "although", true, "prt"),
  ]);
  const [contextual] = await parseOffline("いいのに", ["eng"], HOST);
  assert.equal(contextual?.entry, "jmdict:good");
  assert.ok(!contextual?.candidates?.some((candidate) => candidate.entry === "jmdict:say"));
  const [isolated] = await parseOffline("いい", ["eng"], HOST);
  assert.equal(isolated?.entry, "jmdict:good");
  assert.ok(isolated?.candidates?.some((candidate) => candidate.entry === "jmdict:say"));
  assert.equal((await lookupOffline("言い", ["eng"], HOST))?.entry, "jmdict:say");
});

test("an adverbial expression offers its validated adjective base without unrelated stem homophones", async () => {
  const expression = JSON.parse(term("jmdict:adverb", "確かに", "確かに", "たしかに", "certainly", true, "adv"));
  expression.frequencies = [{ source: "test", text: "確かに", reading: "たしかに", rank: 100 }];
  const adjective = JSON.parse(term("jmdict:adjective", "確か", "確か", "たしか", "certain", true, "adj-na"));
  adjective.frequencies = [{ source: "test", text: "確か", reading: "たしか", rank: 10 }];
  await install([
    JSON.stringify(expression), JSON.stringify(adjective),
    term("jmdict:noun", "確か", "確か", "たしか", "a different stem homophone", false, "n"),
  ]);

  const [token] = await parseOffline("確かに", ["eng"], HOST);
  assert.equal(token.entry, "jmdict:adverb");
  assert.equal(token.lemma, "確か");
  assert.deepEqual(token.candidates?.map((candidate) => candidate.entry), ["jmdict:adverb", "jmdict:adjective"]);
  for (const popup of [await lookupOffline("確かに", ["eng"], HOST), await lookupEntryOffline(token.entry!, "確かに", ["eng"], HOST)]) {
    assert.equal(popup?.headword, "確かに");
    assert.equal(popup?.baseForm, "確かに");
    assert.equal(popup?.entry, token.entry);
    assert.deepEqual(popup?.inflection, ["adverbial (〜に)"]);
    assert.equal(popup?.inflectionBase, "確か");
    assert.equal(popup?.reading, "たしかに");
    assert.equal(popup?.baseReading ?? popup?.reading, "たしかに");
  }
});

test("quietly in context studies the adverb while an explicit adjective pick studies the adjective", async () => {
  const adverb = JSON.parse(term("jmdict:quietly", "静かに", "静かに", "しずかに", "quietly", true, "adv"));
  adverb.frequencies = [{ source: "test", text: "静かに", reading: "しずかに", rank: 1170 }];
  const adjective = JSON.parse(term("jmdict:quiet", "静か", "静か", "しずか", "quiet", true, "adj-na"));
  adjective.frequencies = [{ source: "test", text: "静か", reading: "しずか", rank: 500 }];
  await install([JSON.stringify(adverb), JSON.stringify(adjective),
    term("jmdict:walk", "歩く", "歩く", "あるく", "walk", true, "v5k")]);
  const [token] = await parseOffline("静かに歩く。", ["eng"], HOST);
  assert.equal(token.surface, "静かに");
  assert.equal(token.entry, "jmdict:quietly");
  assert.ok(token.candidates?.some((candidate) => candidate.entry === "jmdict:quiet"));
  const popup = await lookupEntryOffline(token.entry!, token.surface, ["eng"], HOST);
  assert.equal(popup?.baseForm, "静かに");
  assert.equal(popup?.baseReading ?? popup?.reading, "しずかに");
  assert.equal(popup?.inflectionBase, "静か");
  const picked = await lookupEntryOffline("jmdict:quiet", token.surface, ["eng"], HOST);
  assert.equal(picked?.baseForm, "静か");
  assert.equal(picked?.baseReading ?? picked?.reading, "しずか");
});

test("a selected lexical na form preserves its study spelling and reading", async () => {
  await install([
    term("jmdict:form", "好きな", "好きな", "すきな", "favorite", false, "exp"),
    term("jmdict:base", "好き", "好き", "すき", "liked", true, "adj-na"),
  ]);
  const popup = await lookupEntryOffline("jmdict:form", "好きな", ["eng"], HOST);
  assert.equal(popup?.headword, "好きな");
  assert.equal(popup?.reading, "すきな");
  assert.equal(popup?.baseForm, "好きな");
  assert.equal(popup?.baseReading ?? popup?.reading, "すきな");
});

test("a lexical adverb does not acquire an unrelated adjective by dropping its final ni", async () => {
  const adverb = JSON.parse(term("jmdict:further", "さらに", null, "さらに", "furthermore", true, "adv"));
  adverb.frequencies = [{ source: "test", text: "さらに", reading: "さらに", rank: 1 }];
  const adjective = JSON.parse(term("jmdict:fresh", "さら", null, "さら", "new", true, "adj-na"));
  adjective.frequencies = [{ source: "test", text: "さら", reading: "さら", rank: 1000 }];
  await install([JSON.stringify(adverb), JSON.stringify(adjective)]);

  const [token] = await parseOffline("さらに", ["eng"], HOST);
  assert.equal(token.entry, "jmdict:further");
  assert.equal(token.lemma, "さらに");
  assert.equal(token.candidates, undefined);
  assert.equal((await lookupEntryOffline(token.entry!, "さらに", ["eng"], HOST))?.baseForm, "さらに");
  assert.equal((await lookupEntryOffline(token.entry!, "さらに", ["eng"], HOST))?.inflectionBase, undefined);
});

test("an uncommon potential retains its lexical entry behind the common base", async () => {
  const base = JSON.parse(term("jmdict:eat", "食べる", "食べる", "たべる", "to eat", true, "v1"));
  base.frequencies = [{ source: "test", text: "食べる", reading: "たべる", rank: 100 }];
  const potential = JSON.parse(term("jmdict:edible", "食べられる", "食べられる", "たべられる", "to be edible", false, "v1"));
  potential.frequencies = [{ source: "test", text: "食べられる", reading: "たべられる", rank: 200 }];
  const independent = JSON.parse(term("jmdict:come-off", "取れる", "取れる", "とれる", "to come off", true, "v1"));
  independent.frequencies = [{ source: "test", text: "取れる", reading: "とれる", rank: 1000 }];
  const take = JSON.parse(term("jmdict:take", "取る", "取る", "とる", "to take", true, "v5r"));
  take.frequencies = [{ source: "test", text: "取る", reading: "とる", rank: 1 }];
  const able = JSON.parse(term("jmdict:able", "出来る", "出来る", "できる", "to be able", true, "v1"));
  able.frequencies = [{ source: "test", text: "出来る", reading: "できる", rank: 1000 }];
  const doVerb = JSON.parse(term("jmdict:do", "する", null, "する", "to do", true, "vs-i"));
  doVerb.frequencies = [{ source: "test", text: "する", reading: "する", rank: 1 }];
  await install([base, potential, independent, take, able, doVerb].map((record) => JSON.stringify(record)));

  for (const text of ["食べられる", "食べられなかった"]) {
    const [token] = await parseOffline(text, ["eng"], HOST);
    assert.equal(token.entry, "jmdict:eat", text);
    assert.ok(token.candidates?.some((candidate) => candidate.entry === "jmdict:edible"), text);
  }
  const [common] = await parseOffline("取れなかった", ["eng"], HOST);
  assert.equal(common.entry, "jmdict:come-off");
  const [suppletive] = await parseOffline("出来なかった", ["eng"], HOST);
  assert.equal(suppletive.entry, "jmdict:able");
});

// Absence means "nothing to choose between", so a client tests for the key
// rather than counting a list that is usually one long.
test("a potential interpretation needs lexical support before replacing an independent verb", async () => {
  const burst = JSON.parse(term("jmdict:burst", "弾ける", "弾ける", "はじける", "burst", false, "v1"));
  const flick = JSON.parse(term("jmdict:flick", "弾く", "弾く", "はじく", "flick", true, "v5k"));
  burst.senses.push({ ...burst.senses[0], xrefs: [{ kind: "related", text: "弾く" }] });
  const speakable = JSON.parse(term("jmdict:speakable", "話せる", "話せる", "はなせる", "be able to speak", false, "v1"));
  const speak = JSON.parse(term("jmdict:speak", "話す", "話す", "はなす", "speak", true, "v5s"));
  speakable.senses[0].xrefs = [{ kind: "related", text: "話す" }];
  for (const [row, rank] of [[burst, 20000], [flick, 1000], [speakable, 20000], [speak, 1000]] as const) {
    row.frequencies = [{ source: "test", text: row.headword, reading: row.readings[0].text, rank }];
  }
  await install([burst, flick, speakable, speak].map((row) => JSON.stringify(row)));
  const [token] = await parseOffline("弾ける。", ["eng"], HOST);
  assert.equal(token.entry, "jmdict:burst");
  assert.ok(token.candidates?.some((candidate) => candidate.entry === "jmdict:flick"));
  assert.equal((await parseOffline("話せない。", ["eng"], HOST))[0].entry, "jmdict:speak");
});

test("object evidence selects a potential without erasing lexical alternatives", async () => {
  const counts = contextEvidence.counts as Record<string, Record<string, number>>;
  const original = counts["ギターを"];
  counts["ギターを"] = { "jmdict:play": 47 };
  try {
    await install([
      term("jmdict:guitar", "ギター", null, "ギター", "guitar"),
      term("jmdict:bubble", "泡", "泡", "あわ", "bubble"),
      term("jmdict:subject", "が", null, "が", "subject", true, "prt"),
      term("jmdict:object", "を", null, "を", "object", true, "prt"),
      term("jmdict:quite", "かなり", null, "かなり", "quite", true, "adv"),
      term("jmdict:well", "上手く", "上手く", "うまく", "well", true, "adv"),
      term("jmdict:play", "弾く", "弾く", "ひく", "play", true, "v5k"),
      term("jmdict:flick", "弾く", "弾く", "はじく", "flick", true, "v5k"),
      term("jmdict:burst", "弾ける", "弾ける", "はじける", "burst", false, "v1"),
    ].map((line) => {
      const row = JSON.parse(line);
      row.frequencies = [{ source: "test", text: row.headword, reading: row.readings[0].text,
        rank: row.id === "jmdict:burst" ? 20000 : 1000 }];
      return JSON.stringify(row);
    }));
    for (const [surface, reading] of [["弾ける", "ひける"], ["弾けない", "ひけない"], ["弾けた", "ひけた"]]) {
      for (const particle of ["が", "を", "がかなり上手く"]) {
        const text = `ギター${particle}${surface}。`;
        const token = (await parseOffline(text, ["eng"], HOST)).find((item) => item.surface === surface);
        assert.equal(token?.entry, "jmdict:play", text);
        assert.equal(token?.lemma, "弾く", text);
        assert.equal(token?.reading, reading, text);
        assert.ok(token?.candidates?.some((candidate) => candidate.entry === "jmdict:burst"), text);
      }
    }
    for (const text of ["泡が弾ける。", "弾ける。", "ギターが。弾ける。"]) {
      assert.equal((await parseOffline(text, ["eng"], HOST)).find((item) => item.surface === "弾ける")?.entry, "jmdict:burst", text);
    }
    const weakOrConflicting: Record<string, number>[] = [{ "jmdict:play": 4 },
      { "jmdict:play": 47, "jmdict:flick": 24 }, { "jmdict:play": 47, "jmdict:burst": 94 }];
    for (const votes of weakOrConflicting) {
      counts["ギターを"] = votes;
      assert.equal((await parseOffline("ギターが弾ける。", ["eng"], HOST)).find((item) => item.surface === "弾ける")?.entry, "jmdict:burst");
    }
  } finally {
    if (original) counts["ギターを"] = original;
    else delete counts["ギターを"];
  }
});

test("a span only one word claims offers no choice at all", async () => {
  await install([ term("jmdict:1522150", "本", "本", "ほん", "book") ]);

  const [ token ] = await parseOffline("本", [ "eng" ], HOST);

  assert.equal(token.entry, "jmdict:1522150");
  assert.ok(!("candidates" in token), "one word is not a question");
});

test("a grammatical word retains same-headword alternatives but excludes noun homophones", async () => {
  await install([
    term("jmdict:1000001", "ない", null, "ない", "not", true, "aux-adj"),
    term("jmdict:1000002", "ない", null, "ない", "nonexistent", false, "adj-i"),
    term("jmdict:1000003", "内", "内", "ない", "inside", false),
  ]);

  const [token] = await parseOffline("ない", ["eng"], HOST);

  assert.equal(token?.entry, "jmdict:1000001");
  assert.deepEqual(token.candidates?.map((candidate) => candidate.entry), ["jmdict:1000001", "jmdict:1000002"]);
});

// A picker offers other readings of the word in front of the reader, never a
// different cut of the sentence. Re-segmenting is the parser's job and it has
// already done it.
test("a longer word sharing a prefix is not offered as a choice", async () => {
  await install([
    term("jmdict:1000001", "日", "日", "ひ", "day"),
    term("jmdict:1000002", "日本", "日本", "にほん", "Japan"),
  ]);

  const [ token ] = await parseOffline("日本", [ "eng" ], HOST);

  assert.equal(token.surface, "日本", "the parser cut the longer word");
  assert.ok(!token.candidates?.some((candidate) => candidate.entry === "jmdict:1000001"),
    "日 covers a different span, so it is a different question");
});

// The reachability half, and the one that took a second list to fix. This was
// the extension's version of the bug the server had before candidates: a word
// the spelling merely CARRIES never entered the list at all, so there was
// nothing for the ladder to rank. `contextuallyConfident` gates the parser's
// candidate set, and a kanji word matched by its kana READING only clears that
// gate when the entry is `uk`. 君 is not.
//
// The gate is right for the PARSER: dropping it shatters 全く into 全 + く. So
// `contextualCandidates` answers with both sets out of one gather, and the cut
// still comes from the gated one. Only the list reads the other.
test("a word the spelling merely reads is reachable, behind the word it names", async () => {
  await install([
    term("jmdict:1226580", "きみ", null, "きみ", "millet"),
    term("jmdict:1247250", "君", "君", "きみ", "you"),
  ]);

  const [ token ] = await parseOffline("きみ", [ "eng" ], HOST);

  assert.equal(token.entry, "jmdict:1226580", "the filed word still answers, which is the cut the gate makes");
  assert.deepEqual(token.candidates?.map((candidate) => candidate.entry),
    [ "jmdict:1226580", "jmdict:1247250" ],
    "and 君 is there to be picked: rung 2, filed before carried, never a filter");
});

// The parity check E1 exists for: same inputs in, same order out. This is the
// exact list `POST /api/v1/words/identify` answers for `{lemma: "きみ"}` with no
// pos and no reading, recorded in docs/plans/word-resolution.md:
//
//   {lemma: "きみ"} -> きみ, 君, 黄身
//
// One ranking function with optional inputs, not two algorithms. Rung 1
// (DECISIVE_POS) needs a morphological analyser and stays out of reach offline,
// so the two engines agree on every rung the offline half can stand on.
test("the offline order is the order identify answers with the same inputs", async () => {
  await install([
    term("jmdict:1182060", "黄身", "黄身", "きみ", "egg yolk", false),
    term("jmdict:1247250", "君", "君", "きみ", "you"),
    term("jmdict:1226580", "きみ", null, "きみ", "millet"),
  ]);

  const [ token ] = await parseOffline("きみ", [ "eng" ], HOST);

  assert.deepEqual(token.candidates?.map((candidate) => candidate.headword),
    [ "きみ", "君", "黄身" ],
    "filed first, then common, then rank: the server's ladder minus the rung that needs a POS");
});

// Rung 4, reached only when nothing above separates the field. Both are carried
// kanji words read きみ, so rank breaks the tie and the commoner word wins.
test("where nothing else separates them, the commoner word leads", async () => {
  await install([
    term("jmdict:1182060", "黄身", "黄身", "きみ", "egg yolk", false),
    term("jmdict:1247250", "君", "君", "きみ", "you", true),
  ]);

  const [ token ] = await parseOffline("きみ", [ "eng" ], HOST);

  assert.equal(token.candidates?.[0].entry, "jmdict:1247250",
    "neither is filed under きみ and neither reading discriminates, so common decides");
});

// ── the pick, and what makes it worth offering ──────────────────────────────
// A picker that cannot show you what you picked is a picker nobody uses, and
// re-looking-up the spelling would hand back the word the reader just rejected.
// So the chosen word is fetched by its HANDLE: the terms store is keyed on the
// entry id, so choosing costs one primary-key read rather than a re-parse.
test("a picked word is fetched by its handle, not looked up again", async () => {
  await install([
    term("jmdict:1226580", "きみ", null, "きみ", "millet"),
    term("jmdict:1247250", "君", "君", "きみ", "you"),
  ]);

  const [ token ] = await parseOffline("きみ", [ "eng" ], HOST);
  assert.equal(token.entry, "jmdict:1226580", "the parser still answers the filed word");

  const picked = await lookupEntryOffline("jmdict:1247250", "きみ", [ "eng" ], HOST);

  assert.equal(picked?.entry, "jmdict:1247250");
  assert.equal(picked?.headword, "君");
  assert.deepEqual(picked?.senses.flatMap((sense) => sense.glosses.map((row) => row.text)), [ "you" ],
    "the definition comes back whole, so the popup renders a pick like any other word");
});

test("a handle the pack does not carry reports unavailable without substituting its spelling", async () => {
  await install([ term("jmdict:1522150", "本", "本", "ほん", "book") ]);

  await assert.rejects(lookupEntryOffline("jmdict:9999999", "本", [ "eng" ], HOST), /Not available in this dictionary/);
});
