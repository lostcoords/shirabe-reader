import assert from "node:assert/strict";
import test from "node:test";
import type { Definition } from "../src/common/types.js";
import { answers, asked, drawn, hover, page, settle, shadow } from "./support/popup-page.js";

// The example sentences on a word card, and the two things the pack's own cut
// buys them: the word being explained is MARKED inside the line, and every other
// word in it OPENS.
//
// Both answer the same failure. An example is exactly where the next unknown
// word turns up, and the line used to be one string: a reader could not see
// which word the card was about (食べました does not spell 食べる) and could not
// look anything up in it without leaving the card to select text by hand.
//
// The page is shared with the picker suite: see test/support/popup-page.ts.

// 私は毎日ご飯を食べました, cut the way the site cut it. 食べました carries the
// lemma, which is the whole reason the mark can find it.
const LINE = [
  { surface: "私", lemma: "私" },
  { surface: "は", lemma: "は" },
  { surface: "毎日", lemma: "毎日" },
  { surface: "ご飯", lemma: "ご飯" },
  { surface: "を", lemma: "を" },
  { surface: "食べました", lemma: "食べる" },
  { surface: "。" },
];

function eater(examples: Definition["examples"]): Definition {
  return {
    headword: "食べる", reading: "たべる", url: "https://shirabe.org/word/食べる", entry: "jmdict:1358280",
    senses: [ { position: 0, sourceEntry: "jmdict:1358280", dictionary: "JMdict",
      partsOfSpeech: [{ label: "Ichidan verb", code: "v1", category: "pos", scope: "sense" }],
      tags: [], glosses: [{ lang: "eng", tag: "EN", text: "to eat" }] } ],
    pitch: [], examples,
  } as unknown as Definition;
}

Object.assign(answers, {
  "lookup:食べる": eater([ { japanese: "私は毎日ご飯を食べました。", translation: "I ate rice every day.", tokens: LINE } ]),
  // A second lemma for the same word, so the popup re-renders rather than
  // reusing the open card, with a line that arrived without a cut.
  "lookup:食べる-plain": eater([ { japanese: "ご飯を食べました。", translation: "I ate rice." } ]),
  "lookup:私": eater([]),
});

const words = (): Promise<HTMLElement[]> => drawn(".sb-example-jp > span");

test("the word the card is about is marked inside its own example", async () => {
  await hover({ lemma: "食べる", surface: "食べる", pos: "verb" });

  const line = await words();
  assert.deepEqual(line.map((span) => span.textContent), [ "私", "は", "毎日", "ご飯", "を", "食べました", "。" ],
    "the line is cut into the words the site read it with, and rebuilds it exactly");
  // By LEMMA. 食べました and 食べる share no run of characters a surface
  // comparison could match on, which is why the pack ships the lemma at all.
  assert.deepEqual(line.filter((span) => span.classList.contains("sb-example-hit")).map((span) => span.textContent),
    [ "食べました" ], "the conjugated form is the word this card explains");
});

test("every other word in an example opens", async () => {
  const watashi = (await words()).find((span) => span.textContent === "私");

  assert.equal(watashi?.getAttribute("role"), "link", "a word in an example is a lookup");

  watashi?.click();
  await settle();

  assert.ok(asked.some((message) => message.type === "lookup" && message.query === "私"),
    "clicking a word in the example looks that word up, in the card already open");
});

// A sentence is ONE tab stop. Twenty words in a line would otherwise be twenty,
// and two examples put forty of them between the reader and the Save button.
test("a line is one tab stop, walked with the arrows", async () => {
  await hover({ lemma: "食べる", surface: "食べる", pos: "verb" });
  const line = await words();

  assert.deepEqual(line.slice(0, 3).map((span) => span.tabIndex), [ 0, -1, -1 ],
    "the first word is the way in; the rest are reachable from inside");

  const { window } = await page();
  const arrow = new (window as unknown as { KeyboardEvent: typeof KeyboardEvent }).KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true });
  line[0]?.dispatchEvent(arrow);

  assert.deepEqual(line.slice(0, 3).map((span) => span.tabIndex), [ -1, 0, -1 ],
    "the stop travels with the focus, so tabbing back returns where the reader left off");
});

// Punctuation is a token like any other in the cut, because the surfaces have to
// rebuild the line exactly. Looking one up would answer nothing, so it is drawn
// and left alone.
test("punctuation is part of the line but not a lookup", async () => {
  await hover({ lemma: "食べる", surface: "食べる", pos: "verb" });
  const stop = (await words()).find((span) => span.textContent === "。");

  assert.equal(stop?.className, "sb-example-gap");
  assert.equal(stop?.hasAttribute("role"), false, "nothing to open");
  assert.equal(stop?.tabIndex, -1);
});

// A pack built before the cut shipped still has to render its examples: the line
// is the string it always was, and nothing in it opens.
test("a line that arrived without a cut still reads", async () => {
  await hover({ lemma: "食べる-plain", surface: "食べる", pos: "verb" });

  const line = (await shadow()).querySelector(".sb-example-jp");
  assert.equal(line?.textContent, "ご飯を食べました。");
  assert.equal(line?.querySelectorAll("span").length, 0, "no cut, no words to open");
});
