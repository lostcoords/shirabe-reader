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
  // word, so neither fragment may carry it — stamping にほんご on both renders the
  // reading twice, once over 日本 and again over 語.
  const line = window.document.getElementById("line") as HTMLElement;
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
  const known = `<span class="sb-word" data-lemma="猫" data-state="known"></span>`;
  const unknown = `<span class="sb-word" data-lemma="犬" data-state="none" data-frequency="1200"></span>`;
  window.document.body.innerHTML = `<blockquote id="outer">${known}<p id="inner">${known}${unknown}</p></blockquote>`;

  const { showStatusBar, hideStatusBar } = await import("../src/content/status-bar.js");
  hideStatusBar(); // the module's host/index/timer are singletons — start clean
  try {
    showStatusBar(() => {});
    const marked = [...window.document.querySelectorAll(".sb-i-plus-one")].map((block) => block.id);
    // The blockquote's deep query sees the paragraph's words too; only the block
    // that actually owns the one unknown word may be cued.
    assert.deepEqual(marked, ["inner"], "a wrapping block must not double-cue its child's sentence");
  } finally {
    hideStatusBar();
  }
});
