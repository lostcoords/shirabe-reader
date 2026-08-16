import assert from "node:assert/strict";
import test from "node:test";
import type { Definition } from "../src/common/types.js";
import { answers, asked, drawn, hover, settle, shadow } from "./support/popup-page.js";

// How a meaning READS on the card: the labels as chips coloured by what kind of
// claim they make, and one row per language behind a two-letter tag.
//
// What this replaced: a word glossed in two languages rendered its whole sense
// list twice, once per language, with a "Español · JMdict" heading over each
// half. Eight senses became sixteen rows, and the labels were a grey run of
// prose in which "Ichidan verb" and "Usually kana" read as the same kind of
// statement about the word.
//
// The page is shared with the other popup suites: see test/support/popup-page.ts.

function definition(senses: Definition["senses"]): Definition {
  return {
    headword: "綺麗", reading: "きれい", url: "https://shirabe.org/word/綺麗", entry: "jmdict:1591900",
    pitch: [], examples: [], senses,
  } as unknown as Definition;
}

Object.assign(answers, {
  "lookup:開く-notes": definition([ {
    position: 0,
    partsOfSpeech: [ { label: "Godan verb", code: "v5k", category: "pos" } ],
    tags: [],
    glosses: [ { lang: "eng", tag: "EN", text: "to open" } ],
    notes: [ "usu. in kana" ],
    xrefs: [
      { kind: "related", text: "開ける", reading: "あける" },
      { kind: "antonym", text: "閉じる", reading: "とじる" },
    ],
  } ]),
  "lookup:綺麗": definition([ {
    position: 0,
    partsOfSpeech: [ { label: "Na-adjective", code: "adj-na", category: "pos" } ],
    tags: [ { label: "Usually kana", code: "uk", category: "misc" }, { label: "Computing", code: "comp", category: "field" } ],
    glosses: [
      { lang: "spa", tag: "ES", text: "bonito; hermoso" },
      { lang: "eng", tag: "EN", text: "pretty; beautiful" },
    ],
  } ]),
  "lookup:本": definition([ {
    position: 0,
    partsOfSpeech: [ { label: "Noun", code: "n", category: "pos" } ],
    tags: [],
    glosses: [ { lang: "eng", tag: "EN", text: "book" } ],
  } ]),
});

test("a word glossed in two languages is one sense with a row each", async () => {
  await hover({ lemma: "綺麗", surface: "綺麗", pos: "adj" });

  const senses = await drawn(".sb-senses > li");
  assert.equal(senses.length, 1, "one meaning, said twice, is still one meaning");

  const rows = await drawn(".sb-gloss-row");
  assert.deepEqual(rows.map((row) => row.textContent), [ "ESbonito; hermoso", "ENpretty; beautiful" ],
    "the reader's own language leads, exactly as their stack orders it");
  assert.deepEqual(rows.map((row) => row.lang), [ "es", "en" ],
    "each row declares the language it is actually in, so a screen reader reads it right");
});

// The tag is a disambiguator, and there is nothing to disambiguate when a word
// is glossed in one language: printing EN on every line of every card is noise
// a reader has to learn to skip.
test("a word glossed in one language carries no language tag at all", async () => {
  await hover({ lemma: "本", surface: "本", pos: "noun" });

  assert.equal((await drawn(".sb-gloss-row")).length, 1);
  assert.deepEqual((await drawn(".sb-gloss-lang")).map((tag) => tag.textContent), []);
});

// The aside about how a word is USED, on the sense it qualifies and never
// carried down to the next: "usu. in kana" on sense 3 and not on sense 4 is a
// real difference between those two senses.
test("a sense's usage note sits under the meaning it qualifies", async () => {
  await hover({ lemma: "開く-notes", surface: "開いた", pos: "verb" });

  assert.deepEqual((await drawn(".sb-sense-note")).map((note) => note.textContent), [ "usu. in kana" ]);
});

// Grouped by what the link MEANS, because "related to" and "the opposite of" are
// different information and a mixed row would say neither. The opposite leads:
// it is the sharper fact, and there are far fewer of them.
test("a sense names what it points at, and each target opens", async () => {
  const rows = await drawn(".sb-xref-row");
  assert.deepEqual(rows.map((row) => row.textContent), [ "Opposite閉じる", "See also開ける" ]);

  const [ opposite ] = await drawn(".sb-xref");
  assert.equal(opposite?.title, "閉じる (とじる)", "the reading, which is half of knowing the word");
  opposite?.click();
  await settle();

  assert.ok(asked.some((message) => message.type === "lookup" && message.query === "閉じる"),
    "a cross reference a reader cannot follow is a word they have to go and type somewhere");
});

test("a sense with neither draws neither row", async () => {
  await hover({ lemma: "綺麗", surface: "綺麗", pos: "adj" });

  assert.equal((await shadow()).querySelector(".sb-sense-note"), null);
  assert.equal((await shadow()).querySelector(".sb-xrefs"), null);
});

// A card is 460px tall and a sense now draws chips, a row per language, a note
// and its cross references. Four of those fill it, and `senses.slice(0, 8)` used
// to drop the ninth onward while saying nothing, which reads as "this word has
// eight meanings".
test("a long list of meanings leads with four and counts the rest", async () => {
  const many = Array.from({ length: 7 }, (_, index) => ({
    position: index, partsOfSpeech: [], tags: [],
    glosses: [ { lang: "eng", tag: "EN", text: `meaning ${index}` } ],
  }));
  Object.assign(answers, { "lookup:多義": definition(many as unknown as Definition["senses"]) });
  await hover({ lemma: "多義", surface: "多義", pos: "noun" });

  assert.equal((await drawn(".sb-senses > li")).length, 4);
  const more = (await drawn(".sb-more-senses"))[0];
  assert.equal(more?.textContent, "+3 more meanings", "a card that truncates has to admit it");

  more?.click();

  assert.equal((await drawn(".sb-senses > li")).length, 7);
  assert.equal((await drawn(".sb-more-senses")).length, 0, "nothing left to reveal");
});

test("a label is a chip, coloured by the kind of claim it makes", async () => {
  await hover({ lemma: "綺麗", surface: "綺麗", pos: "adj" });

  const chips = await drawn(".sb-sense-chip");
  assert.deepEqual(chips.map((pill) => pill.textContent), [ "Na-adjective", "Usually kana", "Computing" ],
    "what the word IS first, then how it is USED");
  assert.deepEqual(chips.map((pill) => pill.className.split(" ")[1]),
    [ "sb-sense-chip-pos", "sb-sense-chip-misc", "sb-sense-chip-field" ]);
});

// The Legend, in the card. "Na-adjective" is a term a beginner has to look up
// somewhere, and the somewhere used to be a different website.
test("a chip the Legend explains opens the entry inside the card", async () => {
  await hover({ lemma: "綺麗", surface: "綺麗", pos: "adj" });

  const [ naAdjective ] = await drawn(".sb-sense-chip-open");
  assert.equal(naAdjective?.getAttribute("aria-expanded"), "false", "closed until asked");
  naAdjective?.click();

  const panel = (await drawn(".sb-legend"))[0];
  assert.equal(panel?.hidden, false);
  assert.match(panel?.textContent ?? "", /Na-adjective/);
  assert.match(panel?.textContent ?? "", /な形容詞/, "the term's Japanese name, as the book prints it");
  assert.match(panel?.textContent ?? "", /takes な to attach to a noun/, "the website's own words, offline");
  assert.equal(naAdjective?.getAttribute("aria-expanded"), "true");
});

// One explanation at a time, in one place: a card that grew a stack of panels
// would push the meanings it exists to show off the bottom.
test("a second chip replaces the entry, and the same chip closes it", async () => {
  const [ naAdjective, usuallyKana ] = await drawn(".sb-sense-chip-open");

  usuallyKana?.click();
  const panel = (await drawn(".sb-legend"))[0];
  assert.match(panel?.textContent ?? "", /kana/i);
  assert.equal(naAdjective?.getAttribute("aria-expanded"), "false", "the first chip closed when the second opened");

  usuallyKana?.click();
  assert.equal((await drawn(".sb-legend"))[0]?.hidden, true, "tapping the open chip again puts it away");
});

// The book explains what a learner can tell apart, and JMdict splits far finer
// than that. A chip it has nothing to say about is not a button that disappoints.
test("a code the Legend does not cover stays a plain chip", async () => {
  const plain = (await drawn(".sb-sense-chip")).filter((pill) => !pill.classList.contains("sb-sense-chip-open"));

  assert.deepEqual(plain.map((pill) => pill.textContent), [ "Computing" ]);
  assert.deepEqual(plain.map((pill) => pill.tagName), [ "SPAN" ], "not a button");
});
