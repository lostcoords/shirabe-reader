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

test("logical scanner crosses inline links and ignores native ruby readings", async () => {
  const window = installDom("<p id='line'>食<ruby>漢<rt>しょく</rt></ruby><a>べる</a></p>");
  const { logicalTextAt } = await import("../src/content/dom-text.js");
  const first = window.document.querySelector("p")?.firstChild as Text;
  const logical = logicalTextAt(first, 0);
  assert.equal(logical.context, "食漢べる");
  assert.equal(logical.text, "食漢べる");
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

test("page metrics distinguish occurrences and unique words and apply the i+1 cap", async () => {
  const window = installDom(`
    <p><span class="sb-word" data-lemma="猫" data-state="known"></span><span class="sb-word" data-lemma="猫" data-state="known"></span></p>
    <p id="candidate"><span class="sb-word" data-lemma="食べる" data-state="none" data-frequency="1200"></span><span class="sb-word" data-lemma="猫" data-state="known"></span></p>
  `);
  const { isIPlusOne, measurePageWords } = await import("../src/content/page-metrics.js");
  const words = [...window.document.querySelectorAll<HTMLElement>(".sb-word")];
  const metrics = measurePageWords(words);
  assert.equal(metrics.occurrenceCoverage, 75);
  assert.equal(metrics.uniqueCoverage, 50);
  const candidate = [...window.document.querySelectorAll<HTMLElement>("#candidate .sb-word")];
  assert.equal(isIPlusOne(candidate, { includesLearning: true, frequencyMax: 2000 }), true);
  assert.equal(isIPlusOne(candidate, { includesLearning: true, frequencyMax: 1000 }), false);
});

test("the release host matrix resolves to maintained parsing paths", async () => {
  installDom("");
  const { BUILTIN_RULES, resolveHostMode } = await import("../src/common/host-rules.js");
  const resolve = (url: string) => resolveHostMode(url, { autoHosts: [], disabledHosts: [], rules: BUILTIN_RULES });
  assert.equal(resolve("https://ja.wikipedia.org/wiki/日本語").rule?.parse, "#mw-content-text");
  assert.equal(resolve("https://www.youtube.com/watch?v=1").rule?.custom, "youtube");
  assert.equal(resolve("https://www.netflix.com/watch/1").rule?.custom, "netflix");
  assert.equal(resolve("https://reader.ttsu.app/b?id=1").rule?.custom, "ttsu");
  assert.equal(resolve("https://reader.mokuro.app/reader/1").rule?.custom, "mokuro");
  assert.equal(resolve("https://news.example.jp/story").mode, "manual");
});

test("Japanese Wikipedia fixture scopes logical text to article content", async () => {
  const window = installDom(`
    <nav>辞書ではないナビ</nav>
    <main id="mw-content-text"><p id="wiki-line">日本<ruby>語<rt>ご</rt></ruby>を<a href="/wiki/勉強">勉強する</a>。</p></main>
  `);
  const { BUILTIN_RULES, resolveHostMode } = await import("../src/common/host-rules.js");
  const rule = resolveHostMode("https://ja.wikipedia.org/wiki/日本語", { autoHosts: [], disabledHosts: [], rules: BUILTIN_RULES }).rule;
  const root = window.document.querySelector(rule?.parse ?? "body") as HTMLElement;
  const first = root.querySelector("p")?.firstChild as Text;
  const { logicalTextAt } = await import("../src/content/dom-text.js");
  assert.equal(logicalTextAt(first, 0).context, "日本語を勉強する。");
  assert.ok(!root.textContent?.includes("辞書ではないナビ"));
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
  const fakeParse = async (root: Node) => { seen.push(root.textContent ?? ""); return 1; };
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
  const fakeParse = async (root: Node) => { seen.push(root.textContent ?? ""); return 1; };
  assert.equal(await parseYouTubeSegments(window.document.getElementById("youtube") as Element, true, fakeParse), 1);
  assert.equal(await parseAsbplayerLines(window.document, true, fakeParse), 2);
  assert.deepEqual(seen, ["動画を見る", "アニメを見る", "ローカル動画を見る"]);
  assert.equal((window.document.querySelector(".ytp-caption-segment") as HTMLElement).dataset.integration, "youtube_captions");
  assert.equal((window.document.querySelector(".asbplayer-offscreen > div") as HTMLElement).dataset.integration, "asbplayer");
});
