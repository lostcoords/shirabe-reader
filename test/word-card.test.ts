import assert from "node:assert/strict";
import test from "node:test";
import type { Definition } from "../src/common/types.js";
import { answers, asked, drawn, hover, settle, shadow } from "./support/popup-page.js";

// The rest of the card: the word's other spellings, and its kanji.
//
// Both answer a question the card used to leave hanging. A reader who tapped 空く
// was shown a card headed 開く with nothing connecting the two, and a reader who
// wanted to know what a character was had to leave the page to find out.
//
// The page is shared with the other popup suites: see test/support/popup-page.ts.

function card(over: Partial<Definition>): Definition {
  return {
    headword: "開く", reading: "ひらく", url: "https://shirabe.org/word/開く", entry: "jmdict:1202650",
    pitch: [], examples: [],
    senses: [ { position: 0, partsOfSpeech: [], tags: [], glosses: [ { lang: "eng", tag: "EN", text: "to open" } ] } ],
    ...over,
  } as unknown as Definition;
}

Object.assign(answers, {
  "lookup:開く": card({
    forms: [ { text: "空く", common: true, rare: false }, { text: "明く", common: false, rare: true } ],
  }),
  "lookup:一つ": card({ headword: "一つ", reading: "ひとつ" }),
  "lookup:猫": card({ headword: "猫", reading: "ねこ" }),
  // The card a kanji chip opens: KANJIDIC, not JMdict.
  "lookup:開": card({
    headword: "開", reading: "カイ",
    kanji: { on: [ "カイ" ], kun: [ "ひら.く", "あ.く", "あ.ける" ], strokes: 12, grade: 3 },
  }),
  "lookup:生": card({
    headword: "生", reading: "セイ",
    kanji: { on: [ "セイ", "ショウ" ], kun: [ "い.きる", "う.まれる", "は.える", "なま", "き", "お.う", "は.やす" ], strokes: 5 },
  }),
});

test("a word names its other spellings, and says which are rare", async () => {
  await hover({ lemma: "開く", surface: "開いた", pos: "verb" });

  const forms = await drawn(".sb-form");
  assert.deepEqual(forms.map((form) => form.textContent), [ "空く", "明く" ],
    "the headword is not repeated here: it is already at the top of the card");
  assert.deepEqual(forms.map((form) => form.classList.contains("sb-form-rare")), [ false, true ],
    "a rare spelling is shown, dimmed: it is exactly the one a reader cannot place");
  assert.equal(forms[1]?.lang, "ja");
});

// Absence means "written one way", which is most words. A row labelled "Also
// written" with nothing after it would be a question the card asks itself.
test("a word written one way has no forms row", async () => {
  await hover({ lemma: "一つ", surface: "一つ", pos: "noun" });

  assert.equal((await shadow()).querySelector(".sb-forms"), null);
});

// The pack has carried KANJIDIC all along and the popup could already draw a
// kanji card: nothing ever asked it for one. The strip linked out to the website
// instead, so the offline half of the feature was unreachable.
test("tapping a kanji opens it in the card, not in a tab", async () => {
  await hover({ lemma: "開く", surface: "開いた", pos: "verb" });

  const [ chip ] = await drawn(".sb-kanji-button");
  assert.equal(chip?.tagName, "BUTTON", "a lookup, not a link off the page");
  assert.equal(chip?.textContent, "開");

  chip?.click();
  await settle();

  assert.ok(asked.some((message) => message.type === "lookup" && message.query === "開" && message.kind === "kanji"),
    "asked the kanji corpus, which is a different question from the word 開");
});

test("a kanji card keeps on and kun apart", async () => {
  await hover({ lemma: "開", surface: "開", pos: "noun" });

  const rows = await drawn(".sb-kanji-row");
  assert.deepEqual(rows.map((row) => row.textContent), [ "Onカイ", "Kunひら.くあ.くあ.ける" ],
    "which family a reading belongs to decides how it behaves in a compound");
  assert.equal((await drawn(".sb-kanji-meta"))[0]?.textContent, "12 strokes · Grade 3");
  assert.equal((await shadow()).querySelector(".sb-kanji-strip"), null,
    "a card that IS a character offers no chip for that character: it would reopen itself");
});

// 生 has eleven kun readings, and a card is not a reference page. The full list
// is one tap away on the kanji's own page.
test("a kanji with many readings shows a readable row and counts the rest", async () => {
  await hover({ lemma: "生", surface: "生", pos: "noun" });

  const kun = (await drawn(".sb-kanji-row"))[1];
  assert.equal(kun?.querySelectorAll(".sb-kanji-reading").length, 6);
  assert.equal(kun?.querySelector(".sb-kanji-more")?.textContent, "+1");
  assert.equal((await drawn(".sb-kanji-meta"))[0]?.textContent, "5 strokes",
    "a kanji outside the grade lists says nothing about a grade rather than saying zero");
});
