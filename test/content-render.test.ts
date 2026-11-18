import assert from "node:assert/strict";
import test from "node:test";

// Rendering behaviour that needs a real DOM: what the parser puts on the page,
// and what the status bar cues on top of it.

test("a token split across inline markup does not stamp its reading on each fragment", async () => {
  const { Window } = await import("happy-dom");
  const window = new Window({ url: "https://reader.test/page" });
  Object.assign(globalThis, { window, document: window.document, Node: window.Node, HTMLElement: window.HTMLElement });
  window.document.body.innerHTML = "<p id='line'><b>日本</b>語</p>";
  const { mappedWrapper } = await import("../src/content/parser.js");

  // 日本語 is one token spanning two text nodes. The reading belongs to the whole
  // word, so neither fragment may carry it: stamping にほんご on both renders the
  // reading twice, once over 日本 and again over 語.
  const line = window.document.getElementById("line") as unknown as HTMLElement;
  const nodes = [line.querySelector("b")?.firstChild, line.childNodes[1]] as Text[];
  const context = "日本語";
  const token = { start: 0, length: 3, surface: context, reading: "にほんご", lemma: "日本語", pos: "noun", content: true, state: "none" as const };
  let start = 0;
  for (const node of nodes) {
    const text = node.data;
    node.parentNode?.replaceChild(mappedWrapper(text, start, context, [token], true), node);
    start += text.length;
  }

  assert.equal(line.querySelectorAll("rt").length, 0, "a clipped fragment must not render furigana");
  assert.equal(line.textContent, "日本語", "the text itself is unchanged");
  assert.equal(line.querySelectorAll(".sb-word[data-lemma='日本語']").length, 2, "both fragments still look up the whole word");
  // …but page metrics must see one word, not two occurrences.
  assert.equal(line.querySelectorAll(".sb-word:not([data-continuation])").length, 1, "only the head fragment counts");
  assert.equal(line.querySelector("b .sb-word")?.hasAttribute("data-continuation"), false, "the head is the first fragment");
});

test("nested blocks cue i+1 once, and a mixed block still counts its own words", async () => {
  const { Window } = await import("happy-dom");
  const window = new Window({ url: "https://reader.test/page" });
  Object.assign(globalThis, {
    window, document: window.document, Node: window.Node, HTMLElement: window.HTMLElement,
    MutationObserver: window.MutationObserver,
  });
  const known = `<span class="sb-word" data-lemma="猫" data-state="retired"></span>`;
  const unknown = `<span class="sb-word" data-lemma="犬" data-state="none" data-frequency="1200"></span>`;
  window.document.body.innerHTML = `<blockquote id="outer">${known}<p id="inner">${known}${unknown}</p></blockquote>`;

  const { startMetrics, stopMetrics } = await import("../src/content/metrics-reporter.js");
  stopMetrics(); // the module's index/timer are singletons: start clean
  try {
    startMetrics();
    const marked = [...window.document.querySelectorAll(".sb-i-plus-one")].map((block) => block.id);
    // The blockquote's deep query sees the paragraph's words too; only the block
    // that actually owns the one unknown word may be cued.
    assert.deepEqual(marked, ["inner"], "a wrapping block must not double-cue its child's sentence");
  } finally {
    stopMetrics();
  }
});

test("a rendered word carries its part of speech, so the page can colour by it", async () => {
  const { Window } = await import("happy-dom");
  const window = new Window({ url: "https://reader.test/page" });
  Object.assign(globalThis, { window, document: window.document, Node: window.Node, HTMLElement: window.HTMLElement });
  const { renderToken } = await import("../src/content/word.js");

  // Part-of-speech colouring is pure CSS keyed on this attribute (content.css),
  // so a token that renders without it silently loses its hue on the page.
  const word = renderToken(
    { start: 0, length: 1, surface: "猫", reading: "ねこ", lemma: "猫", pos: "n", content: true, state: "none" },
    false,
  ) as HTMLElement;
  assert.equal(word.dataset.pos, "n");

  // An unlabelled token must not claim a group: no attribute at all, so the
  // `[data-pos]` rules skip it and the page's own ink shows through.
  const unlabelled = renderToken(
    { start: 0, length: 1, surface: "猫", reading: null, lemma: "猫", pos: "", content: true, state: "none" },
    false,
  ) as HTMLElement;
  assert.equal(unlabelled.dataset.pos, undefined);
});

// A save has to travel under the word's IDENTITY, not under the form this engine
// reduced it to. The two tokenizers disagree about lemmas by design, so a save
// keyed on one can land on a different word than the same save from the website
// and leave the learner with two cards for one word. The parser now knows the
// entry, so the token carries it and `entryFor` never has to go back to the
// dictionary with a lemma in its hand.
test("a rendered token carries the dictionary entry it resolved to", async () => {
  const { Window } = await import("happy-dom");
  const window = new Window({ url: "https://reader.test/page" });
  Object.assign(globalThis, { window, document: window.document, Node: window.Node, HTMLElement: window.HTMLElement });
  const { renderToken } = await import("../src/content/word.js");

  const word = renderToken(
    { start: 0, length: 2, surface: "なら", reading: null, lemma: "なら", entry: "jmdict:1009470",
      pos: "aux", content: true, state: "none" },
    false,
  ) as HTMLElement;
  assert.equal(word.dataset.entry, "jmdict:1009470");

  // Absent where the parser resolved no entry (a numeral, an unknown run), so a
  // save falls back to the lemma rather than shipping a handle to nothing.
  const coined = renderToken(
    { start: 0, length: 5, surface: "ズオンガー", reading: null, lemma: "ズオンガー", pos: "", content: true, state: "none" },
    false,
  ) as HTMLElement;
  assert.equal(coined.dataset.entry, undefined);
});
