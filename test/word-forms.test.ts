import "fake-indexeddb/auto";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { lookupOffline } from "../src/common/offline-dictionary.js";
import { installTestPack, packPayload } from "./support/pack.js";

// Which of a word's spellings the card is allowed to name, and the two things a
// sense carries besides its meaning: how the word is USED, and what it points at.
//
// JMdict files three kinds of alternate spelling and they are not the same
// thing: an ordinary one (空く for 開く), a rare one (rK, oK) that a reader will
// still meet in the wild, and a SEARCH-ONLY one (sK, sk) that exists so a query
// finds the word and that JMdict itself refuses to display. Showing the third
// would be showing a reader a spelling nobody writes.

const HOST = "https://shirabe.test";
const HEADER = JSON.stringify({ type: "header", schemaVersion: 7, languages: [ "eng", "spa" ], source: "Shirabe forms" });

const opener = JSON.stringify({
  type: "term", id: "jmdict:1202650", dictionary: "jmdict", headword: "開く",
  expressions: [
    { text: "開く", script: "kanji", common: true, tags: [] },
    { text: "空く", script: "kanji", common: true, tags: [] },
    { text: "明く", script: "kanji", common: false, tags: [ "rK" ] },
    { text: "披く", script: "kanji", common: false, tags: [ "sK" ] },
    { text: "ひらく", script: "kana", common: false, tags: [] },
  ],
  readings: [ { text: "ひらく", kind: "kana" } ],
  senses: [ {
    glosses: { eng: [ "to open" ], spa: [ "abrir" ] },
    partsOfSpeech: [ "v5k" ], fields: [], misc: [], dialects: [], restrictions: [],
    notes: { eng: [ "usu. in kana" ], spa: [ "normalmente en kana" ] },
    xrefs: [
      { kind: "related", text: "開ける", reading: "あける" },
      { kind: "antonym", text: "閉じる", reading: "とじる" },
      // Kinds the schema allows and a meaning does not link to. Dropped rather
      // than guessed at: the label on the row is a claim about what the link MEANS.
      { kind: "compound_of", text: "開" },
    ],
  } ],
});

const plain = JSON.stringify({
  type: "term", id: "jmdict:1467640", dictionary: "jmdict", headword: "猫",
  expressions: [ { text: "猫", script: "kanji", common: true, tags: [] } ],
  readings: [ { text: "ねこ", kind: "kana" } ],
  senses: [ { glosses: { eng: [ "cat" ] }, partsOfSpeech: [ "n" ], fields: [], misc: [], dialects: [], restrictions: [] } ],
});

test("a card names the spellings a reader can meet, and no others", async () => {
  const lines = [ HEADER, opener, plain ];
  await installTestPack(packPayload(lines), {
    contentRevision: createHash("sha256").update(lines.join("\n")).digest("hex").slice(0, 12),
    terms: 2,
  });

  const definition = await lookupOffline("開く", [ "eng" ], HOST);

  assert.deepEqual(definition?.forms?.map((form) => form.text), [ "空く", "明く" ]);
  assert.deepEqual(definition?.forms?.map((form) => form.rare), [ false, true ]);
  // 披く is `sK`: JMdict will not display it, so neither will we.
  // 開く is the headword and ひらく is the reading, both already on the card.
  assert.equal(definition?.forms?.some((form) => [ "披く", "開く", "ひらく" ].includes(form.text)), false);
});

// Absent, not empty: a client (and the renderer) tests for the key rather than
// for a row that is usually not there.
test("a word written one way carries no forms at all", async () => {
  assert.equal((await lookupOffline("猫", [ "eng" ], HOST))?.forms, undefined);
});

// A note is an aside about the word, so it comes in ONE language even when the
// meaning above it is said in two: the same aside twice, under a meaning already
// repeated, buries the meaning.
test("a usage note arrives in the reader's own language, once", async () => {
  const spanish = await lookupOffline("開く", [ "spa", "eng" ], HOST);
  assert.deepEqual(spanish?.senses[0]?.notes, [ "normalmente en kana" ]);

  const english = await lookupOffline("開く", [ "eng" ], HOST);
  assert.deepEqual(english?.senses[0]?.notes, [ "usu. in kana" ]);
});

test("a sense carries what it relates to and what it is the opposite of", async () => {
  const definition = await lookupOffline("開く", [ "eng" ], HOST);

  assert.deepEqual(definition?.senses[0]?.xrefs, [
    { kind: "related", text: "開ける", reading: "あける" },
    { kind: "antonym", text: "閉じる", reading: "とじる" },
  ], "compound_of is not a link a reader follows from a meaning, so it is dropped");
});

test("a sense with neither carries neither", async () => {
  const definition = await lookupOffline("猫", [ "eng" ], HOST);

  assert.equal(definition?.senses[0]?.notes, undefined);
  assert.equal(definition?.senses[0]?.xrefs, undefined);
});

test("a note-only sense remains visible without inventing a gloss", async () => {
  const lines = [HEADER, JSON.stringify({
    type: "term", id: "jmdict:note-only", dictionary: "jmdict", headword: "洗い出す",
    expressions: [{ text: "洗い出す", script: "kanji", common: true, tags: [] }],
    readings: [{ text: "あらいだす", kind: "kana" }],
    senses: [{ glosses: {}, partsOfSpeech: [], fields: [], misc: [], dialects: [], restrictions: [], notes: { jpn: [ "（他五）" ] } }],
  })];
  await installTestPack(packPayload(lines), {
    contentRevision: createHash("sha256").update(lines.join("\n")).digest("hex").slice(0, 12), terms: 1,
  });

  const definition = await lookupOffline("洗い出す", [ "eng" ], HOST);

  assert.deepEqual(definition?.senses[0]?.glosses, []);
  assert.deepEqual(definition?.senses[0]?.notes, [ "（他五）" ]);
});

test("a relation-only sense remains visible without inventing a gloss", async () => {
  const lines = [HEADER, JSON.stringify({
    type: "term", id: "jmdict:relation-only", dictionary: "jmdict", headword: "関連語",
    expressions: [{ text: "関連語", script: "kanji", common: true, tags: [] }],
    readings: [{ text: "かんれんご", kind: "kana" }],
    senses: [{ glosses: {}, partsOfSpeech: [], fields: [], misc: [], dialects: [], restrictions: [],
      xrefs: [{ kind: "related", text: "関係", reading: "かんけい" }] }],
  })];
  await installTestPack(packPayload(lines), {
    contentRevision: createHash("sha256").update(lines.join("\n")).digest("hex").slice(0, 12), terms: 1,
  });

  const definition = await lookupOffline("関連語", [ "eng" ], HOST);

  assert.deepEqual(definition?.senses[0]?.glosses, []);
  assert.deepEqual(definition?.senses[0]?.xrefs, [{ kind: "related", text: "関係", reading: "かんけい" }]);
});

test("an empty sense is excluded while a relation-only sense keeps its position", async () => {
  const lines = [HEADER, JSON.stringify({
    type: "term", id: "jmdict:empty-and-relation", dictionary: "jmdict", headword: "空関係",
    expressions: [{ text: "空関係", script: "kanji", common: true, tags: [] }],
    readings: [{ text: "からかんけい", kind: "kana" }],
    senses: [
      { glosses: {}, partsOfSpeech: [], fields: [], misc: [], dialects: [], restrictions: [] },
      { glosses: {}, partsOfSpeech: [], fields: [], misc: [], dialects: [], restrictions: [],
        xrefs: [{ kind: "antonym", text: "充実", reading: "じゅうじつ" }] },
    ],
  })];
  await installTestPack(packPayload(lines), {
    contentRevision: createHash("sha256").update(lines.join("\n")).digest("hex").slice(0, 12), terms: 1,
  });

  const definition = await lookupOffline("空関係", [ "eng" ], HOST);

  assert.deepEqual(definition?.senses.map((sense) => sense.position), [1]);
  assert.deepEqual(definition?.senses[0]?.xrefs, [{ kind: "antonym", text: "充実", reading: "じゅうじつ" }]);
});

test("source tags retain publisher metadata and the matching term pair", async () => {
  const sourceTag = { name: "arch", category: "register", notes: "publisher note", order: -1.5, score: -3 };
  const lines = [HEADER, JSON.stringify({
    type: "term", id: "jmdict:source-tags", dictionary: "jmdict", headword: "標識語",
    expressions: [{ text: "標識語", script: "kanji", common: false, tags: [] }],
    readings: [{ text: "ひょうしきご", kind: "kana" }],
    senses: [{ glosses: { eng: ["to eat"] }, partsOfSpeech: [], fields: [], misc: [], dialects: [], restrictions: [], sourceTags: [sourceTag] }],
    sourceHeadwords: [{ text: "標識語", reading: "ひょうしきご", tags: [sourceTag], rules: ["v1"], score: 7 }],
  })];
  await installTestPack(packPayload(lines), {
    contentRevision: createHash("sha256").update(lines.join("\n")).digest("hex").slice(0, 12), terms: 1,
  });

  const definition = await lookupOffline("標識語", ["eng"], HOST);
  assert.ok(definition, "the source-tag term is searchable");
  assert.deepEqual(definition?.senses[0]?.sourceTags, [sourceTag]);
  assert.deepEqual(definition?.sourceHeadwordsByEntry, { "jmdict:source-tags": [{ text: "標識語", reading: "ひょうしきご", tags: [sourceTag], rules: ["v1"], score: 7 }] });
});

test("a stacked offline definition keeps source headwords from every dictionary", async () => {
  const firstTag = { name: "first", category: "register", order: 1, score: 1 };
  const secondTag = { name: "second", category: "register", order: 2, score: 2 };
  const lines = [HEADER, JSON.stringify({
    type: "term", id: "jmdict:mixed", dictionary: "jmdict", headword: "混在",
    expressions: [{ text: "混在", script: "kanji", common: true, tags: [] }],
    readings: [{ text: "こんざい", kind: "kana" }],
    senses: [{ glosses: { eng: ["first meaning"] }, partsOfSpeech: [], fields: [], misc: [], dialects: [], restrictions: [] }],
    sourceHeadwords: [{ text: "混在", reading: "こんざい", tags: [firstTag], rules: [], score: 1 }],
  }), JSON.stringify({
    type: "term", id: "jmnedict:mixed", dictionary: "jmnedict", headword: "混在",
    expressions: [{ text: "混在", script: "kanji", common: true, tags: [] }],
    readings: [{ text: "こんざい", kind: "kana" }],
    senses: [{ glosses: { eng: ["second meaning"] }, partsOfSpeech: [], fields: [], misc: [], dialects: [], restrictions: [] }],
    sourceHeadwords: [{ text: "混在", reading: "こんざい", tags: [secondTag], rules: [], score: 2 }],
  })];
  await installTestPack(packPayload(lines), {
    contentRevision: createHash("sha256").update(lines.join("\n")).digest("hex").slice(0, 12), terms: 2,
  });

  const definition = await lookupOffline("混在", ["eng"], HOST);
  assert.deepEqual(definition?.sourceHeadwordsByEntry, {
    "jmdict:mixed": [{ text: "混在", reading: "こんざい", tags: [firstTag], rules: [], score: 1 }],
    "jmnedict:mixed": [{ text: "混在", reading: "こんざい", tags: [secondTag], rules: [], score: 2 }],
  });
});

test("offline gloss rows preserve same text across languages and repetitions", async () => {
  const lines = [HEADER, JSON.stringify({
    type: "term", id: "jmdict:duplicate-gloss", dictionary: "jmdict", headword: "重複",
    expressions: [{ text: "重複", script: "kanji", common: true, tags: [] }],
    readings: [{ text: "ちょうふく", kind: "kana" }],
    senses: [{ glosses: { eng: ["same", "same"], spa: ["same"] }, partsOfSpeech: [], fields: [], misc: [], dialects: [], restrictions: [] }],
  }), JSON.stringify({
    type: "term", id: "jmdict:fallback-gloss", dictionary: "jmdict", headword: "代替",
    expressions: [{ text: "代替", script: "kanji", common: true, tags: [] }],
    readings: [{ text: "だいたい", kind: "kana" }],
    senses: [{ glosses: { eng: ["same", "same"] }, partsOfSpeech: [], fields: [], misc: [], dialects: [], restrictions: [] }],
  })];
  await installTestPack(packPayload(lines), {
    contentRevision: createHash("sha256").update(lines.join("\n")).digest("hex").slice(0, 12), terms: 2,
  });

  const explicit = await lookupOffline("重複", ["eng", "spa"], HOST);
  assert.deepEqual(explicit?.senses[0]?.glosses, [
    { lang: "eng", tag: "EN", text: "same" },
    { lang: "eng", tag: "EN", text: "same" },
    { lang: "spa", tag: "ES", text: "same" },
  ]);

  const fallback = await lookupOffline("代替", ["spa", "eng"], HOST);
  assert.deepEqual(fallback?.senses[0]?.glosses, [
    { lang: "eng", tag: "EN", text: "same" },
    { lang: "eng", tag: "EN", text: "same" },
  ]);
});

test("publisher titles and usage-only content survive offline lookup", async () => {
  const lines = [HEADER, JSON.stringify({
    type: "term", id: "jmdict:usage", dictionary: "jmdict", headword: "鼻にかける",
    expressions: [{ text: "鼻にかける", script: "kanji", common: false, tags: [] }],
    readings: [{ text: "はなにかける", kind: "kana" }],
    senses: [{
      glosses: { jpn: ["自慢する"] },
      glossTitles: { jpn: ["意味"] },
      usages: { jpn: [{ text: "学歴を鼻にかける", title: "使用例" }, { text: "家柄の良さを鼻にかける" }] },
      partsOfSpeech: ["v1"], fields: [], misc: [], dialects: [], restrictions: [],
    }],
  })];
  await installTestPack(packPayload(lines), {
    contentRevision: createHash("sha256").update(lines.join("\n")).digest("hex").slice(0, 12), terms: 1,
  });

  const definition = await lookupOffline("鼻にかける", ["jpn"], HOST);
  assert.ok(definition);
  assert.deepEqual(definition?.senses[0]?.glosses, [{ lang: "jpn", tag: "JA", text: "自慢する", title: "意味" }]);
  assert.deepEqual((definition?.senses[0] as unknown as { usages?: unknown }).usages, [
    { lang: "jpn", tag: "JA", text: "学歴を鼻にかける", title: "使用例" },
    { lang: "jpn", tag: "JA", text: "家柄の良さを鼻にかける" },
  ]);
});

test("offline hierarchy keeps published labels, depth, and scoped grammar", async () => {
  const lines = [HEADER, JSON.stringify({
    type: "term", id: "jmdict:hierarchy", dictionary: "jmdict", headword: "階層",
    expressions: [{ text: "階層", script: "kanji", common: true, tags: [] }],
    readings: [{ text: "かいそう", kind: "kana" }],
    senses: [{
      label: "一㋐", depth: 2,
      glosses: { eng: ["nested meaning"] },
      partsOfSpeech: ["n", "v1"], fields: [], misc: [], dialects: [], restrictions: [],
      scopedTags: [
        { category: "part_of_speech", code: "n", scope: "entry" },
        { category: "part_of_speech", code: "v1", scope: "group" },
        { category: "part_of_speech", code: "n", scope: "sense" },
      ],
    }],
  })];
  await installTestPack(packPayload(lines), {
    contentRevision: createHash("sha256").update(lines.join("\n")).digest("hex").slice(0, 12), terms: 1,
  });

  const definition = await lookupOffline("階層", ["eng"], HOST);
  assert.deepEqual(definition?.entryTagsByEntry, {
    "jmdict:hierarchy": [{ label: "Noun", code: "n", category: "pos", scope: "entry" }],
  });
  assert.equal(definition?.senses[0]?.label, "一㋐");
  assert.equal(definition?.senses[0]?.depth, 2);
  assert.deepEqual(definition?.senses[0]?.groupTags, [{ label: "Ichidan verb", code: "v1", category: "pos", scope: "group" }]);
  assert.deepEqual(definition?.senses[0]?.partsOfSpeech, [{ label: "Noun", code: "n", category: "pos", scope: "sense" }]);
});

test("offline cross-reference labels preserve same targets as distinct rows", async () => {
  const lines = [HEADER, JSON.stringify({
    type: "term", id: "jmdict:xref-label", dictionary: "jmdict", headword: "機械",
    expressions: [{ text: "機械", script: "kanji", common: true, tags: [] }],
    readings: [{ text: "きかい", kind: "kana" }],
    senses: [{
      glosses: { eng: ["machine"] }, partsOfSpeech: ["n"], fields: [], misc: [], dialects: [], restrictions: [],
      xrefs: [
        { kind: "related", text: "器械" },
        { kind: "related", text: "器械", reading: "きかい", label: "①" },
      ],
    }],
  })];
  await installTestPack(packPayload(lines), {
    contentRevision: createHash("sha256").update(lines.join("\n")).digest("hex").slice(0, 12), terms: 1,
  });

  const definition = await lookupOffline("機械", ["eng"], HOST);
  assert.deepEqual(definition?.senses[0]?.xrefs, [
    { kind: "related", text: "器械" },
    { kind: "related", text: "器械", reading: "きかい", label: "①" },
  ]);
});
