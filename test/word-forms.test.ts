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
const HEADER = JSON.stringify({ type: "header", schemaVersion: 6, languages: [ "eng", "spa" ], source: "Shirabe forms" });

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
