import assert from "node:assert/strict";
import test from "node:test";
import type { ParsedToken } from "../src/common/types.js";

// What a mined card points into. The save sends our cut of the line plus which
// chip of it the learner clicked, so the server files the sentence the way the
// reader read it rather than re-cutting it with Sudachi.
//
// The cut has to be the one that was ON SCREEN, and that is not the same as
// re-parsing `dataset.sentence`: the page tokenizes a whole text node, so the
// parse that drew a line had the rest of the node to look ahead into. Reading
// one sentence back on its own can come out cut differently, and the mismatch
// used to drop `targetIndex` in silence: precisely on the lines that read two
// ways, which are the lines a learner mines.

const HOST = "https://reader.test/page";

function token(surface: string, start: number, extra: Partial<ParsedToken> = {}): ParsedToken {
  return {
    start, length: surface.length, surface, reading: null, lemma: surface,
    pos: "noun", content: true, state: "none", ...extra,
  } as ParsedToken;
}

async function page() {
  const { Window } = await import("happy-dom");
  const window = new Window({ url: HOST });
  Object.assign(globalThis, {
    window, document: window.document, HTMLElement: window.HTMLElement, Node: window.Node,
    chrome: globalThis.chrome ?? { runtime: { id: "test", sendMessage: async () => ({ ok: true }) } },
  });
  return { window, parser: await import("../src/content/parser.js"), word: await import("../src/content/word.js") };
}

test("a drawn line records the cut it was drawn with, and which chip is which", async () => {
  const { window, parser, word } = await page();
  const text = "本を読む。";
  const wrapper = parser.buildWrapper(text, [
    token("本", 0), token("を", 1, { content: false }), token("読む", 2), token("。", 4, { content: false }),
  ], false);
  window.document.body.append(wrapper as never);

  const words = [ ...(wrapper as unknown as HTMLElement).querySelectorAll(".sb-word") ] as HTMLElement[];
  assert.deepEqual(words.map((element) => element.dataset.surface), [ "本", "読む" ]);

  assert.deepEqual(word.shownCut(words[0]!), { surfaces: [ "本", "を", "読む", "。" ], index: 0 });
  assert.deepEqual(word.shownCut(words[1]!)?.index, 2, "the chip is found by POSITION, so a repeat cannot steal it");
});

// The case the position walk exists for: the same word twice in one line. By
// surface, both spans would claim the first occurrence and a card mined off the
// second would highlight the wrong one.
test("a line repeating a word points each occurrence at itself", async () => {
  const { window, parser, word } = await page();
  const text = "本と本。";
  const wrapper = parser.buildWrapper(text, [
    token("本", 0), token("と", 1, { content: false }), token("本", 2), token("。", 3, { content: false }),
  ], false);
  window.document.body.append(wrapper as never);

  const words = [ ...(wrapper as unknown as HTMLElement).querySelectorAll(".sb-word") ] as HTMLElement[];

  assert.equal(word.shownCut(words[0]!)?.index, 0);
  assert.equal(word.shownCut(words[1]!)?.index, 2);
});

// A text node holding two sentences is ONE parse, and each word records the cut
// of its own sentence: the save sends the line the reader mined, not the node.
test("each sentence in a node records its own cut", async () => {
  const { window, parser, word } = await page();
  const text = "本だ。犬だ。";
  const wrapper = parser.buildWrapper(text, [
    token("本", 0), token("だ", 1, { content: false }), token("。", 2, { content: false }),
    token("犬", 3), token("だ", 4, { content: false }), token("。", 5, { content: false }),
  ], false);
  window.document.body.append(wrapper as never);

  const words = [ ...(wrapper as unknown as HTMLElement).querySelectorAll(".sb-word") ] as HTMLElement[];

  assert.deepEqual(word.shownCut(words[0]!), { surfaces: [ "本", "だ", "。" ], index: 0 });
  assert.deepEqual(word.shownCut(words[1]!), { surfaces: [ "犬", "だ", "。" ], index: 0 });
  assert.equal(words[1]?.dataset.sentence, "犬だ。", "and the sentence it reports agrees with the cut it recorded");
});

// A token that straddles the sentence boundary leaves no cut OF THAT SENTENCE to
// report, so nothing is recorded and the save falls back to re-parsing. Silence
// here is the honest answer: inventing a slice would describe a line nobody read.
test("a token straddling the boundary records no cut at all", async () => {
  const { window, parser, word } = await page();
  const text = "本。犬";
  const wrapper = parser.buildWrapper(text, [ token("本。犬", 0) ], false);
  window.document.body.append(wrapper as never);

  const words = [ ...(wrapper as unknown as HTMLElement).querySelectorAll(".sb-word") ] as HTMLElement[];

  assert.equal(word.shownCut(words[0]!), undefined);
});
