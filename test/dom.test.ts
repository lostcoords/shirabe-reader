import assert from "node:assert/strict";
import test from "node:test";
import { Window } from "happy-dom";

function installDom(html: string): Window {
  const window = new Window({ url: "https://reader.test/page" });
  window.document.body.innerHTML = html;
  Object.assign(globalThis, {
    window, document: window.document, Node: window.Node, NodeFilter: window.NodeFilter,
    HTMLElement: window.HTMLElement, Text: window.Text, MutationObserver: window.MutationObserver,
    chrome: {
      runtime: { sendMessage: async () => ({ ok: true }), onMessage: { addListener() {} }, getURL: (path: string) => path },
      storage: { local: { get: async () => ({}), set: async () => {}, remove: async () => {} }, onChanged: { addListener() {} } },
    },
  });
  return window;
}

test("a caption that grows word by word keeps the moment it first appeared", async () => {
  // Auto-generated captions roll a line in one word at a time, and every added
  // word is another parse. Re-stamping each time walks the line's start forward
  // until it points at the end of it — and the audio mined from that cue then
  // replays whatever came next instead of the sentence on screen.
  const window = installDom("<div id='cue'></div>");
  const { stampCueStart } = await import("../src/content/cues.js");
  const cue = window.document.getElementById("cue") as unknown as HTMLElement;

  cue.textContent = "これは";
  stampCueStart(cue, "1000");
  cue.textContent = "これは新しい";
  stampCueStart(cue, "1600");
  cue.textContent = "これは新しい車です";
  stampCueStart(cue, "2300");
  assert.equal(cue.dataset.mediaTimestamp, "1000", "a growing line keeps its first stamp");

  // Different text is a different cue, and takes the moment it arrived.
  cue.textContent = "全然違う話";
  stampCueStart(cue, "4000");
  assert.equal(cue.dataset.mediaTimestamp, "4000", "a replaced line is a new cue");
});

test("a caption rebuilt mid-line keeps the moment the line began", async () => {
  // YouTube replaces its caption nodes while a line is still being spoken: the
  // words are the same, the element is new, and it carries none of our stamps.
  // Stamping "now" put the line's start two thirds of the way through the
  // sentence, so the clip opened at 高齢者 instead of 転んだ.
  const window = installDom("<div id='first'></div><div id='second'></div>");
  const { stampCueStart, noteCue, forgetOpenCue } = await import("../src/content/cues.js");
  const first = window.document.getElementById("first") as unknown as HTMLElement;
  const second = window.document.getElementById("second") as unknown as HTMLElement;
  const video = { currentTime: 0, addEventListener() {}, removeEventListener() {} } as unknown as HTMLVideoElement;

  forgetOpenCue();
  first.textContent = "転んだときだけ柔らかくなる床材が";
  stampCueStart(first, "10000");
  noteCue(first, video);

  // Same line, rebuilt node, three seconds later.
  second.textContent = "転んだときだけ柔らかくなる床材が高齢者を骨折から守る";
  stampCueStart(second, "13000");
  assert.equal(second.dataset.mediaTimestamp, "10000", "the line began at 10s, whatever node holds it now");

  // A line that really is new still takes the moment it arrived.
  const third = window.document.createElement("div");
  third.textContent = "まったく別の話です";
  noteCue(second, video);
  stampCueStart(third as unknown as HTMLElement, "20000");
  assert.equal(third.dataset.mediaTimestamp, "20000");
  forgetOpenCue();
});

test("the clip covers exactly the sentence the card will carry", async () => {
  // The card's sentence was chosen when the word was wrapped. Matching the audio
  // to that text is the whole rule — no reasoning about punctuation, particles
  // or pauses, and no way for the two to disagree.
  installDom("<div></div>");
  const { spanCovering } = await import("../src/content/cues.js");
  const track = [
    { startMs: 0, endMs: 2_000, text: "前の話です。", exact: true },
    { startMs: 2_200, endMs: 4_000, text: "昨日 友達と", exact: true },
    { startMs: 4_100, endMs: 6_000, text: "新しい店に行ったよ。", exact: true },
    { startMs: 6_500, endMs: 8_000, text: "それから", exact: true },
  ];

  // Split across two lines: reach back for the half that is missing, no further.
  const split = spanCovering(track, track[2], "昨日友達と新しい店に行ったよ。");
  assert.equal(split.startMs, 2_200);
  assert.equal(split.endMs, 6_000);
  assert.equal(split.roomBeforeMs, 200, "silence available before the span");

  // Whole sentence on one line: that line, and nothing either side of it — the
  // case a rule about missing 。 used to get wrong.
  const alone = spanCovering(track, track[2], "新しい店に行ったよ。");
  assert.equal(alone.startMs, 4_100);
  assert.equal(alone.endMs, 6_000);

  // Whitespace differs between caption and card; it means nothing in Japanese.
  assert.equal(spanCovering(track, track[1], "昨日友達と").startMs, 2_200);

  // A sentence that runs *forwards* from the mined line is only found after
  // reaching backwards past lines it never included — so the span has to shrink
  // again, or the clip carries a line the card doesn't.
  const forward = spanCovering(track, track[1], "昨日友達と新しい店に行ったよ。");
  assert.equal(forward.startMs, 2_200, "no earlier line comes along for the ride");
  assert.equal(forward.endMs, 6_000);

  // A sentence the cues no longer hold (the caption moved on) keeps the line the
  // word was on rather than reaching for something that isn't there.
  const stale = spanCovering(track, track[2], "まったく別の文です。");
  assert.equal(stale.startMs, track[2].startMs);
  assert.equal(stale.endMs, track[2].endMs);
});

test("a cue's text ignores the furigana we drew over it", async () => {
  // textContent splices every reading into the line, which breaks matching the
  // caption against a player's cue list.
  const window = installDom("<div id='cue'><ruby>新<rt>あたら</rt></ruby>しい車です</div>");
  const { cueText } = await import("../src/content/cues.js");
  const cue = window.document.getElementById("cue") as unknown as HTMLElement;
  assert.equal(cueText(cue), "新しい車です");
});

test("a surface with real cue times overrides what watching the overlay guessed", async () => {
  const window = installDom("<div id='cue'>新しい車です</div>");
  const { stampCueStart, cueFor, setCueSource } = await import("../src/content/cues.js");
  const cue = window.document.getElementById("cue") as unknown as HTMLElement;
  const video = { currentTime: 15.9 } as HTMLVideoElement;

  // Observation: stamped late (the caption is drawn after the words) and ended
  // wherever the playhead happens to be.
  stampCueStart(cue, "12900");
  const observed = cueFor(cue, video);
  assert.equal(observed?.exact, false);
  assert.equal(observed?.startMs, 12900);

  // The player's own track knows the line actually runs 12.480 → 15.100.
  setCueSource({
    refine: () => ({ startMs: 12480, endMs: 15100, text: "新しい車です", exact: true }),
    stop: () => undefined,
  });
  const refined = cueFor(cue, video);
  assert.equal(refined?.startMs, 12480, "the exact start replaces the observed one");
  assert.equal(refined?.endMs, 15100);
  assert.equal(refined?.exact, true);

  // A source that can't place a line leaves the observation in charge, so a
  // broken track never costs more than the precision it was adding.
  setCueSource({ refine: () => null, stop: () => undefined });
  assert.equal(cueFor(cue, video)?.startMs, 12900, "an unanswerable refinement falls back");
  setCueSource(null);
});

test("logical scanner crosses inline links and ignores native ruby readings", async () => {
  const window = installDom("<p id='line'>食<ruby>漢<rt>しょく</rt></ruby><a>べる</a></p>");
  const { logicalTextAt } = await import("../src/content/dom-text.js");
  const first = window.document.querySelector("p")?.firstChild as Text;
  const logical = logicalTextAt(first, 0);
  assert.equal(logical.context, "食漢べる");
  assert.equal(logical.text, "食漢べる");
});

test("logical scanner inserts a boundary between block-level siblings", async () => {
  // The caret text is a direct child of the wrapping <div>, whose other child is
  // a block <p>; a naive join glues them into 「日本語。猫」 — a word (and sentence)
  // that never existed.
  const window = installDom(`<div id="wrap">日本語。<p id="b">猫</p></div>`);
  const { logicalTextAt } = await import("../src/content/dom-text.js");
  const first = window.document.querySelector("#wrap")?.firstChild as Text;
  const logical = logicalTextAt(first, 0);
  assert.equal(logical.context, "日本語。\n猫", "block siblings are separated by a newline, not glued");

  // Inline descendants inside one block stay contiguous (the existing contract).
  const inline = installDom(`<p id="line">日本<a>語</a>を<em>読む</em></p>`);
  const mod = await import("../src/content/dom-text.js");
  const head = inline.document.querySelector("#line")?.firstChild as Text;
  assert.equal(mod.logicalTextAt(head, 0).context, "日本語を読む", "inline links/emphasis do not add boundaries");
});

test("a caret in a later block is offset past the newlines inserted before it", async () => {
  // contextOffset is what the newline-boundary code actually computes: the caret's
  // index into the joined context, not into its own text node. Get it wrong and
  // the lookup window reads from the wrong character of the wrong block.
  const window = installDom(`<div id="wrap"><p id="first">日本語。</p>猫が鳴く</div>`);
  const { logicalTextAt } = await import("../src/content/dom-text.js");
  const second = window.document.getElementById("wrap")?.lastChild as Text;
  const logical = logicalTextAt(second, 1);

  assert.equal(logical.context, "日本語。\n猫が鳴く");
  // 4 chars of the first block + the inserted newline + 1 into the second.
  assert.equal(logical.contextOffset, 6, "the node offset is shifted by everything joined before it");
  assert.equal(logical.text, "が鳴く", "the read-forward window starts at contextOffset");

  // A caret in the FIRST node needs no shift, so the two offsets agree.
  const first = window.document.getElementById("first")?.firstChild as Text;
  assert.equal(logicalTextAt(first, 2).contextOffset, 2);
});

test("scan highlight range snaps to the matched length across inline nodes", async () => {
  // 食べ<a>られた</a>: a 3-code-unit match from the caret must cover 食べ plus ら
  // (one char into the next inline node), so the highlight lands on the term.
  const window = installDom(`<p id="line">食べ<a>られた</a></p>`);
  const { rangeFromCaret } = await import("../src/content/dom-text.js");
  const head = window.document.querySelector("#line")?.firstChild as Text;
  const range = rangeFromCaret(head, 0, 3);
  assert.equal(range.toString(), "食べら", "range spans exactly 3 code units across the inline boundary");

  // A length longer than the available run clamps to the end of the run.
  assert.equal(rangeFromCaret(head, 0, 99).toString(), "食べられた", "over-long match clamps to the run");
});

test("mapped parsing preserves inline elements while one word spans them", async () => {
  const window = installDom("<p id='line'>食べ<a>まし</a><em>た</em>。</p>");
  const { mappedWrapper } = await import("../src/content/parser.js");
  const line = window.document.getElementById("line") as HTMLElement;
  const nodes = [line.childNodes[0], line.querySelector("a")?.firstChild, line.querySelector("em")?.firstChild].filter(Boolean) as Text[];
  const context = "食べました";
  const token = { start: 0, length: context.length, surface: context, reading: "たべました", lemma: "食べる", pos: "verb", content: true, state: "none" as const };
  let start = 0;
  for (const node of nodes) {
    const text = node.data;
    node.parentNode?.replaceChild(mappedWrapper(text, start, context, [token], false), node);
    start += text.length;
  }
  assert.ok(line.querySelector("a"), "link is preserved");
  assert.ok(line.querySelector("em"), "emphasis is preserved");
  assert.equal(line.querySelectorAll(".sb-word[data-lemma='食べる']").length, 3);
  assert.equal(line.textContent, "食べました。");
});

test("a block that scrolls back mid-flight still parses once its batch settles", async () => {
  // The lazy path cancels a batch whose blocks all scroll off. If a block scrolls
  // BACK before that batch resolves, the intersection fires while the block is
  // still pending — enterBlock ignores it — and IntersectionObserver will not fire
  // again for a block that is already intersecting. Without a re-queue when the
  // batch settles, that paragraph stays permanently unparsed.
  const window = installDom("<div id='page'><p id='a'>日本語</p></div>");
  // happy-dom has no layout, so the viewport pre-pass finds nothing; discovery
  // still reaches the block by walking text nodes.
  (window.document as unknown as { elementsFromPoint: () => unknown[] }).elementsFromPoint = () => [];

  // Drive intersection by hand so the test controls the scroll race.
  let notify: ((entries: Array<{ target: unknown; isIntersecting: boolean }>) => void) | null = null;
  class FakeIO {
    constructor(callback: (entries: Array<{ target: unknown; isIntersecting: boolean }>) => void) { notify = callback; }
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  const frames: Array<() => void> = [];
  // Hand every stubbed global back afterwards: a leaked requestAnimationFrame
  // would swallow parser.ts's deferred work (enterBlock, queueStateRefresh) for
  // every test that runs after this one in the same bundled process.
  const scheduling = ["IntersectionObserver", "requestAnimationFrame", "cancelAnimationFrame", "requestIdleCallback"];
  const globals = globalThis as unknown as Record<string, unknown>;
  const originalScheduling = Object.fromEntries(scheduling.map((name) => [name, globals[name]]));
  Object.assign(globalThis, {
    IntersectionObserver: FakeIO,
    requestAnimationFrame: (callback: () => void) => { frames.push(callback); return frames.length; },
    cancelAnimationFrame: () => {},
    requestIdleCallback: undefined,
  });
  // Block discovery runs through setTimeout (no requestIdleCallback here), so the
  // flush has to yield a real macrotask, not just a microtask.
  const tick = (): Promise<void> => new Promise((resolve) => { setTimeout(resolve, 0); });
  const flushFrames = async (): Promise<void> => {
    for (let round = 0; round < 10; round += 1) {
      await tick();
      while (frames.length) { const run = frames.shift(); run?.(); await tick(); }
    }
  };

  const { ext } = await import("../src/common/browser.js");
  const original = ext.runtime.sendMessage;
  let release: (() => void) | null = null;
  let held = false;
  ext.runtime.sendMessage = async (message: { type: string; texts?: string[] }) => {
    if (message.type !== "parseBatch") return { ok: true, states: {} };
    // Hold only the FIRST batch open, so the test can scroll away and back while
    // it is in flight. The re-queued batch must be free to complete.
    if (!held) {
      held = true;
      await new Promise<void>((resolve) => { release = resolve; });
    }
    return { ok: true, tokens: (message.texts ?? []).map(() => []) };
  };

  try {
    const { observeLazy, setParsingPaused } = await import("../src/content/parser.js");
    setParsingPaused(false);
    const block = window.document.getElementById("a") as HTMLElement;
    observeLazy(window.document.getElementById("page") as Node, false);

    notify?.([{ target: block, isIntersecting: true }]);   // scrolls in → batch dispatched
    await flushFrames();
    notify?.([{ target: block, isIntersecting: false }]);  // scrolls off → batch cancelled
    notify?.([{ target: block, isIntersecting: true }]);   // scrolls BACK, still in flight
    await flushFrames();

    assert.ok(release, "the batch was dispatched and is in flight");
    release?.();                                            // batch finally resolves
    await flushFrames();

    assert.ok(
      block.dataset.sbBlock === "1" || !!block.querySelector("[data-sb-parsed]"),
      "the visible block is re-queued and parsed once its cancelled batch settles",
    );
  } finally {
    ext.runtime.sendMessage = original;
    Object.assign(globalThis, originalScheduling);
  }
});

test("mined sentence context spans quoted speech instead of breaking inside it", async () => {
  installDom("");
  const { mappedWrapper } = await import("../src/content/parser.js");
  const sentenceFor = (text: string, target: string): string | undefined => {
    const start = text.indexOf(target);
    const token = { start, length: target.length, surface: target, reading: "", lemma: target, pos: "verb", content: true, state: "none" as const };
    const wrapper = mappedWrapper(text, 0, text, [token], false);
    return wrapper.querySelector<HTMLElement>(".sb-word")?.dataset.sentence;
  };

  // A terminator inside 「」 must not end the sentence — this used to mine the
  // fragment 」と彼は言った。 (stray quote, quoted speech lost) onto the card.
  assert.equal(sentenceFor("「行くぞ。」と彼は言った。", "言った"), "「行くぞ。」と彼は言った。");
  // A word inside the quotation mines the quoted utterance, without either quote.
  assert.equal(sentenceFor("「行くぞ。」と彼は言った。", "行く"), "行くぞ。");
  // Parentheses suspend terminators the same way; plain sentences are unchanged.
  assert.equal(sentenceFor("彼は（本当に）来た。次の話。", "来た"), "彼は（本当に）来た。");
  assert.equal(sentenceFor("最初。「なに？」と聞いた。最後。", "聞いた"), "「なに？」と聞いた。");
  assert.equal(sentenceFor("これは一。これは二。", "二"), "これは二。");
  assert.equal(sentenceFor("普通の文です。", "文"), "普通の文です。");
});

test("streaming captions don't fold furigana readings back into the source", async () => {
  const window = installDom("<div id='seg'>いつだったか考え</div>");
  const { parseCaptionElement, setParsingPaused } = await import("../src/content/parser.js");
  setParsingPaused(false); // a prior test may have left the shared module paused

  // Override the captured extension API, not globalThis.chrome: `ext` in
  // browser.js is bound once at first import, so an earlier test's chrome is
  // what send() actually reaches. Tokenize 考え as a kanji word (reading かんがえ);
  // if the reading ever leaks back into the source it tokenizes as a bare kana
  // word we can detect.
  const { ext } = await import("../src/common/browser.js");
  const original = ext.runtime.sendMessage;
  ext.runtime.sendMessage = async (m: { type: string; texts?: string[] }) => {
    if (m.type !== "parseBatch") return { ok: true, states: {} };
    const text = m.texts?.[0] ?? "";
    const tokens = [];
    for (let i = 0; i < text.length; ) {
      if (text.startsWith("考え", i)) {
        tokens.push({ start: i, length: 2, surface: "考え", reading: "かんがえ", lemma: "考える", pos: "verb", content: true, state: "none" });
        i += 2;
      } else if (text.startsWith("かんがえ", i)) {
        tokens.push({ start: i, length: 4, surface: "かんがえ", reading: "かんがえ", lemma: "かんがえ", pos: "noun", content: true, state: "none" });
        i += 4;
      } else i += 1;
    }
    return { ok: true, tokens: [tokens] };
  };

  try {
    const seg = window.document.getElementById("seg") as HTMLElement;
    const source = () => [...seg.querySelectorAll("rt")].reduce((s, rt) => s.replace(rt.textContent ?? "", ""), seg.textContent ?? "");

    await parseCaptionElement(seg, true);
    assert.equal(source(), "いつだったか考え", "first cue: reading sits in rt, not the source");
    const stableWord = seg.querySelector(".sb-word[data-lemma='考える']");
    assert.ok(stableWord, "the kanji word rendered with furigana");

    // YouTube grows the same segment by appending — this is where it used to compound.
    seg.append("た");
    await parseCaptionElement(seg, true);
    seg.append("も");
    await parseCaptionElement(seg, true);

    assert.equal(source(), "いつだったか考えたも", "reading never re-enters the source across streamed growth");
    assert.equal(seg.querySelectorAll(".sb-word[data-lemma='かんがえ']").length, 0, "no phantom kana word from a leaked reading");
    // The unchanged leading word keeps its exact DOM node across streamed updates,
    // so its furigana never re-renders (the twitch) — only the growing tail does.
    assert.equal(seg.querySelector(".sb-word[data-lemma='考える']"), stableWord, "stable word is reconciled, not rebuilt");
  } finally {
    ext.runtime.sendMessage = original;
  }
});

test("furigana renders only over kanji-bearing surfaces, never kana-only words", async () => {
  installDom("");
  const { renderToken } = await import("../src/content/word.js");
  const token = (surface: string, reading: string) => ({
    start: 0, length: surface.length, surface, reading, lemma: surface, pos: "noun", content: true, state: "none" as const,
  });

  const kanji = renderToken(token("日本語", "にほんご"), true) as HTMLElement;
  assert.ok(kanji.querySelector("ruby"), "kanji word keeps furigana");
  assert.equal(kanji.querySelector("rt")?.textContent, "にほんご");

  // Furigana sits over the kanji run only; okurigana stays plain text, not under
  // a ruby — otherwise the reading floats over kana that already reads itself.
  const okurigana = renderToken(token("食べる", "たべる"), true) as HTMLElement;
  assert.equal(okurigana.querySelectorAll("ruby").length, 1, "one ruby, over 食 only");
  assert.equal(okurigana.querySelector("ruby")?.firstChild?.textContent, "食");
  assert.equal(okurigana.querySelector("rt")?.textContent, "た", "reading covers only the kanji");
  assert.equal(okurigana.textContent, "食たべる", "べる renders as plain okurigana beside the ruby");

  // An inflected surface (授けて) carries the dictionary reading (さずける). Furigana
  // must sit over 授 as さず — the surface okurigana けて renders plain — not smear
  // the whole dictionary reading (with its own okurigana る) over the word.
  const inflected = renderToken({ ...token("授けて", "さずける"), lemma: "授ける" }, true) as HTMLElement;
  assert.equal(inflected.querySelector("rt")?.textContent, "さず", "furigana is the kanji-stem reading, not さずける");
  assert.equal(inflected.textContent, "授さずけて", "surface okurigana けて stays plain beside the ruby");

  // 来る is irregular — its kanji reading changes by conjugation (来て=きて, not くて),
  // so an inflected form can't be aligned from the dictionary reading くる. Rather
  // than show a wrong reading, skip furigana and leave the kanji plain.
  const kuru = renderToken({ ...token("来て", "くる"), lemma: "来る" }, true) as HTMLElement;
  assert.equal(kuru.querySelector("ruby"), null, "inflected 来て gets no (wrong) furigana");
  assert.equal(kuru.textContent, "来て");
  // The dictionary form itself still reads correctly.
  const kuruDict = renderToken({ ...token("来る", "くる"), lemma: "来る" }, true) as HTMLElement;
  assert.equal(kuruDict.querySelector("rt")?.textContent, "く", "来る dictionary form keeps 来[く]る");

  // Kana-only surfaces already read as their own reading — ruby is noise.
  for (const surface of ["この", "では", "アクセント"]) {
    const word = renderToken(token(surface, surface === "この" ? "この" : "よみ"), true) as HTMLElement;
    assert.equal(word.querySelector("ruby"), null, `${surface} has no furigana`);
    assert.equal(word.textContent, surface);
    assert.equal(word.dataset.reading, surface === "この" ? "この" : "よみ", "reading stays available for the popup");
  }

  // 々 counts as kanji so 人々 keeps its gloss.
  assert.ok((renderToken(token("人々", "ひとびと"), true) as HTMLElement).querySelector("ruby"), "々 word keeps furigana");
});

test("furigana distributes a reading over kanji runs only, not okurigana", async () => {
  installDom("");
  const { furiganaSegments } = await import("../src/content/word.js");

  // Trailing okurigana stays plain; only 食 gets furigana.
  assert.deepEqual(furiganaSegments("食べる", "たべる"), [{ text: "食", ruby: "た" }, { text: "べる" }]);
  // Leading kana passes through.
  assert.deepEqual(furiganaSegments("お茶", "おちゃ"), [{ text: "お" }, { text: "茶", ruby: "ちゃ" }]);
  // Interleaved kanji/kana: 取り扱い.
  assert.deepEqual(furiganaSegments("取り扱い", "とりあつかい"), [
    { text: "取", ruby: "と" }, { text: "り" }, { text: "扱", ruby: "あつか" }, { text: "い" },
  ]);
  // All-kanji stays a single ruby.
  assert.deepEqual(furiganaSegments("日本語", "にほんご"), [{ text: "日本語", ruby: "にほんご" }]);
  // Katakana in the surface is matched (folded) but rendered as-is.
  assert.deepEqual(furiganaSegments("消しゴム", "けしゴム"), [{ text: "消", ruby: "け" }, { text: "しゴム" }]);
  // Jukujikun / unalignable readings fall back to one whole-word ruby.
  assert.deepEqual(furiganaSegments("大人", "おとな"), [{ text: "大人", ruby: "おとな" }]);
  // An inflected surface carries the dictionary reading (考える→考え keeps かんがえる):
  // furigana still sits over the kanji only, and the unused okurigana tail (る)
  // is dropped rather than smeared over the whole word.
  assert.deepEqual(furiganaSegments("考え", "かんがえる"), [{ text: "考", ruby: "かんが" }, { text: "え" }]);
  assert.deepEqual(furiganaSegments("食べ", "たべる"), [{ text: "食", ruby: "た" }, { text: "べ" }]);
});

test("page metrics distinguish occurrences and unique words and apply the i+1 cap", async () => {
  const window = installDom(`
    <p><span class="sb-word" data-lemma="猫" data-state="retired"></span><span class="sb-word" data-lemma="猫" data-state="retired"></span></p>
    <p id="candidate"><span class="sb-word" data-lemma="食べる" data-state="none" data-frequency="1200"></span><span class="sb-word" data-lemma="猫" data-state="retired"></span></p>
  `);
  const { isIPlusOne, measurePageWords, PageMetricIndex } = await import("../src/content/page-metrics.js");
  const words = [...window.document.querySelectorAll<HTMLElement>(".sb-word")];
  const metrics = measurePageWords(words);
  assert.equal(metrics.occurrenceCoverage, 75);
  assert.equal(metrics.uniqueCoverage, 50);
  const candidate = [...window.document.querySelectorAll<HTMLElement>("#candidate .sb-word")];
  assert.equal(isIPlusOne(candidate, { includesLearning: true, frequencyMax: 2000 }), true);
  assert.equal(isIPlusOne(candidate, { includesLearning: true, frequencyMax: 1000 }), false);

  const index = new PageMetricIndex();
  for (const word of words) index.update(word);
  assert.deepEqual(index.metrics(), metrics);
  candidate[0].dataset.state = "retired";
  index.update(candidate[0]);
  assert.equal(index.metrics().occurrenceCoverage, 100);
  index.remove(words[0]);
  assert.equal(index.metrics().total, 3);
  assert.equal(index.metrics().unique, 2);
});

test("a new word needs something to be read against before the block counts as i+1", async () => {
  const window = installDom(`
    <p id="bare"><span class="sb-word" data-lemma="紫陽花" data-state="none"></span><span class="sb-word" data-lemma="です" data-pos="cop" data-state="retired"></span><span class="sb-word" data-lemma="ね" data-pos="prt" data-state="retired"></span></p>
    <p id="context"><span class="sb-word" data-lemma="紫陽花" data-state="none"></span><span class="sb-word" data-lemma="咲く" data-pos="v5k" data-state="retired"></span></p>
  `);
  const { isIPlusOne } = await import("../src/content/page-metrics.js");
  const options = { includesLearning: true, frequencyMax: 20_000 };
  const words = (id: string) => [...window.document.querySelectorAll<HTMLElement>(`#${id} .sb-word`)];

  // 「紫陽花ですね」 is one unknown word and pure grammar around it — nothing the
  // reader can lean on. A verb beside it makes the same word worth studying.
  assert.equal(isIPlusOne(words("bare"), options), false);
  assert.equal(isIPlusOne(words("context"), options), true);
});

test("the status bar counts every i+1 block on the page, not just the changed ones", async () => {
  const window = installDom(`
    <li id="one-unknown"><span class="sb-word" data-lemma="猫" data-state="retired"></span><span class="sb-word" data-lemma="食べる" data-state="none" data-frequency="1200"></span></li>
    <li id="all-known"><span class="sb-word" data-lemma="猫" data-state="retired"></span></li>
    <li id="two-unknown"><span class="sb-word" data-lemma="犬" data-state="none"></span><span class="sb-word" data-lemma="鳥" data-state="none"></span></li>
  `);
  // Patch the resolved `ext`, not globalThis.chrome: the module binds once, to
  // whichever stub was installed the first time any test imported it.
  const sent: { type: string; metrics?: { iPlusOne: number } }[] = [];
  const { ext } = await import("../src/common/browser.js");
  const original = ext.runtime.sendMessage;
  ext.runtime.sendMessage = async (message: unknown) => {
    sent.push(message as { type: string });
    return { ok: true };
  };

  const { startMetrics, stopMetrics } = await import("../src/content/metrics-reporter.js");
  // The module keeps the metric index and its debounce timer as singletons, but
  // `installDom` swaps the document out from under them. Reset first so this test
  // doesn't inherit an index built against a dead document, and tear down in
  // `finally` so a failed assertion here can't leak into the rest of the suite.
  stopMetrics();
  sent.length = 0;

  try {
    startMetrics();

    const marked = [...window.document.querySelectorAll(".sb-i-plus-one")].map((block) => block.id);
    assert.deepEqual(marked, ["one-unknown"], "only the block with exactly one unknown word is cued");
    // The cue also points at the word itself, so a marked block says which one.
    const targets = [...window.document.querySelectorAll<HTMLElement>(".sb-i-plus-one-word")].map((word) => word.dataset.lemma);
    assert.deepEqual(targets, ["食べる"], "the block's unknown word is cued, the known one is not");
    assert.equal(sent.findLast((message) => message.type === "pageMetrics")?.metrics?.iPlusOne, 1);

    stopMetrics();
    assert.equal(window.document.querySelectorAll(".sb-i-plus-one").length, 0, "stopping the report clears the cue");
  } finally {
    stopMetrics();
    ext.runtime.sendMessage = original;
  }
});

test("the client reporter forwards our own errors and drops the host page's", async () => {
  // A content script shares the page's window, so a naive handler would ship the
  // host page's JavaScript errors to our collector — noise at best, a privacy
  // leak at worst. The extension-origin gate is the whole defence.
  const window = installDom("");
  const extBase = "moz-extension://shirabe-test/";
  const { ext } = await import("../src/common/browser.js");
  const originalGetURL = ext.runtime.getURL;
  const originalSend = ext.runtime.sendMessage;
  const reported: string[] = [];
  ext.runtime.getURL = (path: string) => `${extBase}${path}`;
  ext.runtime.sendMessage = async (message: { type: string; report?: { signals: Array<{ value: string }> } }) => {
    if (message.type === "telemetry") reported.push(...message.report?.signals.map((signal) => signal.value) ?? []);
    return { ok: true };
  };

  try {
    const { installClientReporter } = await import("../src/common/client-reporter.js");
    installClientReporter("content");

    const raise = (message: string, origin: string): void => {
      const error = new Error(message);
      error.stack = `Error: ${message}\n    at handler (${origin}app.js:12:5)`;
      window.dispatchEvent(new window.ErrorEvent("error", { error, message, filename: `${origin}app.js` }));
    };

    raise("host page analytics blew up", "https://reader.test/");
    raise("our content script blew up", extBase);
    await new Promise((resolve) => { setTimeout(resolve, 0); });

    assert.deepEqual(reported, ["our content script blew up"], "only the extension-origin error is forwarded");
  } finally {
    ext.runtime.getURL = originalGetURL;
    ext.runtime.sendMessage = originalSend;
  }
});

test("the release host matrix resolves to maintained parsing paths", async () => {
  installDom("");
  const { BUILTIN_RULES, resolveHostMode } = await import("../src/common/host-rules.js");
  const resolve = (url: string) => resolveHostMode(url, { disabledHosts: [], rules: BUILTIN_RULES });
  assert.equal(resolve("https://ja.wikipedia.org/wiki/日本語").rule?.parse, "#mw-content-text");
  assert.equal(resolve("https://www.youtube.com/watch?v=1").rule?.custom, "youtube");
  assert.equal(resolve("https://www.netflix.com/watch/1").rule?.custom, "netflix");
  assert.equal(resolve("https://reader.ttsu.app/b?id=1").rule?.custom, "ttsu");
  assert.equal(resolve("https://reader.mokuro.app/reader/1").rule?.custom, "mokuro");
  assert.equal(resolve("https://jisho.org/search/日本語").rule?.filter, ".furigana, .japanese_word__furigana_wrapper");
  assert.equal(resolve("https://news.example.jp/story").mode, "auto");
  // Shirabe's own site is never parsed — it is the dictionary, not a reading surface.
  assert.equal(resolve("https://shirabe.org/en/word/日本語").mode, "off");
  assert.equal(resolve("https://www.shirabe.org/").mode, "off");
  assert.equal(resolve("https://shirabe.localhost/en/word/日本語").mode, "off");
});

test("Japanese Wikipedia fixture scopes logical text to article content", async () => {
  const window = installDom(`
    <nav>辞書ではないナビ</nav>
    <main id="mw-content-text"><p id="wiki-line">日本<ruby>語<rt>ご</rt></ruby>を<a href="/wiki/勉強">勉強する</a>。</p></main>
  `);
  const { BUILTIN_RULES, resolveHostMode } = await import("../src/common/host-rules.js");
  const rule = resolveHostMode("https://ja.wikipedia.org/wiki/日本語", { disabledHosts: [], rules: BUILTIN_RULES }).rule;
  const root = window.document.querySelector(rule?.parse ?? "body") as HTMLElement;
  const first = root.querySelector("p")?.firstChild as Text;
  const { logicalTextAt } = await import("../src/content/dom-text.js");
  assert.equal(logicalTextAt(first, 0).context, "日本語を勉強する。");
  assert.ok(!root.textContent?.includes("辞書ではないナビ"));
});

test("a reading the page already supplies is never parsed as text", async () => {
  // jisho.org's zen bar (the real markup, classes and all): furigana is a row of
  // positioned spans, and the kana it merely needs for spacing are hidden with
  // `color: white` rather than dropped. Parsed as text, きのう became a word of
  // its own beside 昨日 and every invisible spacer came back in our own ink.
  const window = installDom(`
    <section id="zen_bar">
      <li class="japanese_word">
        <span class="japanese_word__furigana_wrapper"><span class="japanese_word__furigana" data-text="昨日">きのう</span></span>
        <span class="japanese_word__text_wrapper"><a><span class="japanese_word__text_with_furigana">昨日</span></a></span>
      </li>
      <li class="japanese_word">
        <span class="japanese_word__furigana_wrapper"><span class="japanese_word__furigana japanese_word__furigana-invisible">すき</span><span class="japanese_word__furigana" data-text="焼">や</span><span class="japanese_word__furigana japanese_word__furigana-invisible">き</span></span>
        <span class="japanese_word__text_wrapper"><a><span class="japanese_word__text_without_furigana">すき</span><span class="japanese_word__text_with_furigana">焼</span><span class="japanese_word__text_without_furigana">き</span></a></span>
      </li>
    </section>
    <div class="concept_light-representation"><span class="furigana"><span class="kanji">た</span></span><span class="text">食べました</span></div>
    <p id="native">これは<ruby>漢字<rt><span>かんじ</span></rt></ruby>です</p>
  `);
  const { BUILTIN_RULES, resolveHostMode } = await import("../src/common/host-rules.js");
  const rule = resolveHostMode("https://jisho.org/search/昨日すき焼きを食べました", { disabledHosts: [], rules: BUILTIN_RULES }).rule;

  const { ext } = await import("../src/common/browser.js");
  const original = ext.runtime.sendMessage;
  const seen: string[] = [];
  ext.runtime.sendMessage = async (message: { type: string; texts?: string[] }) => {
    if (message.type !== "parseBatch") return { ok: true, states: {} };
    seen.push(...(message.texts ?? []).map((text) => text.trim()));
    return { ok: true, tokens: (message.texts ?? []).map(() => []) };
  };

  try {
    const { parse, setParsingPaused } = await import("../src/content/parser.js");
    setParsingPaused(false);
    await parse(window.document.body, false, { filter: rule?.filter });
  } finally {
    ext.runtime.sendMessage = original;
  }

  // Only the words themselves reach the parser. Native ruby is skipped whole —
  // base and annotation — and the <rt> reading stays out even when it is wrapped
  // in markup of its own, which a parent-tag test used to let through.
  assert.deepEqual(seen.filter(Boolean), ["昨日", "すき", "焼", "き", "食べました", "これは", "です"]);
});

test("Netflix, Ttsu, and Mokuro fixtures expose text and integration context", async () => {
  const window = installDom(`
    <video></video>
    <div class="player-timedtext-text-container">猫を見た</div>
    <div class="asbplayer-offscreen"><div>Netflixでアニメを見る</div></div>
    <div class="book-content-container">横書き小説を読む</div>
    <div class="book-content-container" style="writing-mode:vertical-rl">縦書き小説を読む</div>
    <div class="textBox"><span class="ocr-line">横書き漫画を読む</span></div>
    <div class="textBox" style="writing-mode:vertical-rl"><span class="ocr-line">縦書き漫画を読む</span></div>
  `);
  Object.defineProperty(window.document.querySelector("video"), "currentTime", { value: 12.345, configurable: true });
  const { parseDynamicTargets } = await import("../src/content/parsers/dynamic-reader.js");
  const { parseAsbplayerLines } = await import("../src/content/parsers/asbplayer.js");
  const seen: string[] = [];
  const fakeParse = async (root: HTMLElement) => { seen.push(root.textContent ?? ""); return 1; };
  assert.equal(await parseDynamicTargets(window.document, "netflix", true, fakeParse), 1);
  assert.equal(await parseAsbplayerLines(window.document, true, fakeParse), 1);
  assert.equal(await parseDynamicTargets(window.document, "ttsu", true, fakeParse), 2);
  assert.equal(await parseDynamicTargets(window.document, "mokuro", true, fakeParse), 2);
  assert.deepEqual(seen, ["猫を見た", "Netflixでアニメを見る", "横書き小説を読む", "縦書き小説を読む", "横書き漫画を読む", "縦書き漫画を読む"]);
  assert.equal((window.document.querySelector(".player-timedtext-text-container") as HTMLElement).dataset.mediaTimestamp, "12345");
  assert.equal((window.document.querySelector(".textBox") as HTMLElement).dataset.integration, "mokuro_ocr");
});

test("YouTube and asbplayer fixtures expose current subtitle text", async () => {
  const window = installDom(`
    <video></video>
    <div id="youtube"><span class="ytp-caption-segment">動画を見る</span></div>
    <div class="asbplayer-offscreen"><div>アニメを見る</div></div>
    <div class="asbplayer-subtitles">ローカル動画を見る</div>
  `);
  Object.defineProperty(window.document.querySelector("video"), "currentTime", { value: 3.5, configurable: true });
  const { parseYouTubeSegments } = await import("../src/content/parsers/youtube.js");
  const { parseAsbplayerLines } = await import("../src/content/parsers/asbplayer.js");
  const seen: string[] = [];
  const fakeParse = async (root: HTMLElement) => { seen.push(root.textContent ?? ""); return 1; };
  assert.equal(await parseYouTubeSegments(window.document.getElementById("youtube") as Element, true, fakeParse), 1);
  assert.equal(await parseAsbplayerLines(window.document, true, fakeParse), 2);
  assert.deepEqual(seen, ["動画を見る", "アニメを見る", "ローカル動画を見る"]);
  assert.equal((window.document.querySelector(".ytp-caption-segment") as HTMLElement).dataset.integration, "youtube_captions");
  assert.equal((window.document.querySelector(".asbplayer-offscreen > div") as HTMLElement).dataset.integration, "asbplayer");
});

test("YouTube re-parses caption lines that still have bare Japanese after a partial wrap", async () => {
  // Progressive auto-captions grow in place: first "動画" wraps, then "を見る"
  // appears as a sibling. Skipping any segment that already has .sb-word left
  // the rest of the line unparseable.
  const window = installDom(`
    <div id="youtube">
      <span class="ytp-caption-segment"><span class="sb-word sb-none">動画</span>を見る</span>
    </div>
  `);
  const { parseYouTubeSegments } = await import("../src/content/parsers/youtube.js");
  const seen: string[] = [];
  const fakeParse = async (root: HTMLElement) => { seen.push(root.textContent ?? ""); return 1; };
  assert.equal(await parseYouTubeSegments(window.document.getElementById("youtube") as Element, true, fakeParse), 1);
  assert.deepEqual(seen, ["動画を見る"]);
});

test("YouTube parses the styled segment, not the parent visual line", async () => {
  // Matching both wiped .ytp-caption-segment (where YT puts background/color)
  // and left white text with no pill.
  const window = installDom(`
    <div id="youtube" class="ytp-caption-window-container">
      <span class="captions-text">
        <span class="caption-visual-line">
          <span class="ytp-caption-segment" style="background:rgba(8,8,8,0.75);color:#fff">大阪万博</span>
        </span>
      </span>
    </div>
  `);
  const { parseYouTubeSegments, captionTargets } = await import("../src/content/parsers/youtube.js");
  const root = window.document.getElementById("youtube") as Element;
  const targets = captionTargets(root);
  assert.equal(targets.length, 1);
  assert.equal(targets[0].className, "ytp-caption-segment");
  const seen: string[] = [];
  const fakeParse = async (el: HTMLElement) => {
    seen.push(el.className);
    return 1;
  };
  await parseYouTubeSegments(root, true, fakeParse);
  assert.deepEqual(seen, ["ytp-caption-segment"]);
  assert.ok(window.document.querySelector(".ytp-caption-segment"), "styled segment stays in the tree");
});

test("Manage opens the card itself, or the browser when a word has one per meaning", async () => {
  const window = installDom("<p><span class='sb-word' id='w' data-lemma='今日'>今日</span></p>");
  const { applyStudyDetails, studyUrlForWord } = await import("../src/content/actions.js");
  const word = window.document.getElementById("w") as unknown as HTMLElement;
  const decks = [ { id: 1, name: "Saved words" } ];

  applyStudyDetails(word, { state: "new", decks, cardId: 15, cardCount: 1 });
  assert.match(await studyUrlForWord(word), /\/study\/cards\?card_id=15$/, "one card: open it, with its mined context");

  // A second meaning saved. `cardId` still names one of the two, so deep-linking
  // it would leave the other unreachable from the reader.
  applyStudyDetails(word, { state: "new", decks, cardId: 16, cardCount: 2 });
  const url = await studyUrlForWord(word);
  assert.match(url, /\/study\/cards\?q=/, "several cards: the browser, filtered by the word");
  assert.match(url, new RegExp(encodeURIComponent("今日")));
  assert.doesNotMatch(url, /card_id/, "a stale deep link must not survive the second save");
});

test("a meaning that already has a card is marked saved, not offered again", async () => {
  const window = installDom("<p><span class='sb-word' id='w' data-lemma='今日'>今日</span></p>");
  const { applyStudyDetails } = await import("../src/content/actions.js");
  const word = window.document.getElementById("w") as unknown as HTMLElement;

  applyStudyDetails(word, {
    state: "new", decks: [ { id: 1, name: "Saved words" } ], cardId: 15, cardCount: 1,
    savedSensePositions: [ 0 ],
  });
  assert.equal(word.dataset.savedSenses, "0");

  // A whole-word card covers every meaning at once.
  applyStudyDetails(word, { state: "new", decks: [], savedWholeWord: true });
  assert.equal(word.dataset.savedSenses, "all");

  // Nothing covered must clear it — a stale list would grey out a meaning that
  // is still saveable.
  applyStudyDetails(word, { state: "none", decks: [] });
  assert.equal(word.dataset.savedSenses, undefined);
});
