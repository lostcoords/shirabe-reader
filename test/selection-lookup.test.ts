import assert from "node:assert/strict";
import test from "node:test";

// Yomitan has two lookup surfaces: shift-hover from the character under the
// cursor, and a context-menu lookup of whatever is selected. Shirabe has both,
// and the second one is the escape hatch when our own cut is wrong: the spans
// stop mattering, you highlight the word you actually mean.
//
// It was broken on precisely the pages that need it. `Selection#toString()`
// reads every text node the range spans, `<rt>` included, so a page with
// furigana on handed the dictionary 帰かえった.

async function selectionOver(html: string, select: (document: Document) => Range): Promise<string> {
  const { Window } = await import("happy-dom");
  const window = new Window({ url: "https://reader.test/page" });
  window.document.body.innerHTML = html;
  Object.assign(globalThis, { window, document: window.document, NodeFilter: window.NodeFilter });

  const { rangeText } = await import("../src/content/dom-text.js");
  return rangeText(select(window.document as unknown as Document) as unknown as Range);
}

const wholeSpan = (document: Document): Range => {
  const range = document.createRange();
  range.selectNodeContents(document.querySelector(".sb-word")!);
  return range;
};

test("a selection over a furigana'd word reads the word, not the reading", async () => {
  const text = await selectionOver(
    '<span class="sb-word">帰<ruby>っ<rt>かえ</rt></ruby>た</span>',
    wholeSpan,
  );

  assert.equal(text, "帰った");
});

test("ruby fallback parentheses come out too", async () => {
  const text = await selectionOver(
    '<span class="sb-word"><ruby>本<rp>(</rp><rt>ほん</rt><rp>)</rp></ruby></span>',
    wholeSpan,
  );

  assert.equal(text, "本", "rp is what a browser without ruby support shows; it is not the word either");
});

// The ordinary case still has to work: a plain span, and a selection that starts
// and ends inside text nodes rather than wrapping a whole element.
test("a plain selection is unchanged, clipped ends included", async () => {
  assert.equal(await selectionOver('<span class="sb-word">読む</span>', wholeSpan), "読む");

  const clipped = await selectionOver('<p>これは本です</p>', (document) => {
    const range = document.createRange();
    const node = document.querySelector("p")!.firstChild!;
    range.setStart(node, 3);
    range.setEnd(node, 5);
    return range;
  });
  assert.equal(clipped, "本で");
});
