import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { gzipSync } from "node:zlib";
import { createRequire } from "node:module";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const { chromium } = createRequire(resolve("../package.json"))("playwright");
const extension = resolve("dist/verify/chrome");
execFileSync(process.execPath, ["build.mjs", "chrome", "--outdir=dist/verify/chrome"], { stdio: "inherit" });
const profile = mkdtempSync(join(tmpdir(), "shirabe-installed-parity-"));
const term = {
  type: "term", id: "jmdict:banana", dictionary: "jmdict", headword: "バナナ",
  expressions: [{ text: "バナナ", script: "kana", common: true, tags: [] }],
  readings: [{ text: "バナナ", kind: "kana" }],
  senses: [{ glosses: { eng: ["banana"] }, partsOfSpeech: ["n"], fields: [], misc: [], dialects: [], restrictions: [] }],
};
const alternative = {
  ...term, id: "jmnedict:name", dictionary: "jmnedict", headword: "花捺",
  expressions: [{ text: "花捺", script: "kanji", common: false, tags: [] }],
  readings: [{ text: "ばなな", kind: "kana" }],
  senses: [{ glosses: { eng: ["Banana (name)"] }, partsOfSpeech: [], fields: [], misc: [], dialects: [], restrictions: [] }],
};
const contextTerms = [
  ["1578850", "行く", "いく", "v5k-s", 172], ["1587040", "言う", "いう", "v5u", 145],
  ["1546640", "要る", "いる", "v5r", 38], ["school", "学校", "がっこう", "n", 100],
  ["teacher", "先生", "せんせい", "n", 100], ["ni", "に", "に", "prt", 1], ["to", "と", "と", "prt", 1],
  ["skilled", "上手い", "うまい", "adj-i", 3224],
].map(([id, headword, reading, pos, rank]) => ({
  ...term, id: `jmdict:${id}`, headword,
  expressions: [{ text: headword, script: "kanji", common: true, tags: [] },
    { text: reading, script: "kana", common: true, tags: [] }],
  readings: [{ text: reading, kind: "kana" }],
  senses: [{ ...term.senses[0], partsOfSpeech: [pos] }],
  frequencies: [{ source: "jiten-global", text: reading, reading, rank }],
}));
const adverb = {
  ...term, id: "jmdict:well", headword: "上手く",
  expressions: [{ text: "上手く", script: "kanji", common: false, tags: [] }],
  readings: [{ text: "うまく", kind: "kana" }],
  senses: [{ ...term.senses[0], glosses: { eng: ["well"] }, partsOfSpeech: ["adv"], misc: ["uk"] }],
  frequencies: [{ source: "jiten-global", text: "上手く", reading: "うまく", rank: 285081 }],
};
const payload = gzipSync([
  { type: "header", schemaVersion: 6, languages: ["eng", "spa"], source: "Installed parity" }, term, alternative, adverb, ...contextTerms,
].map((row) => JSON.stringify(row)).join("\n") + "\n");
let origin;
const manifest = {
  schemaVersion: 6, buildRecipeVersion: 13, minimumExtensionVersion: "0.2.4", contentRevision: "installed-parity",
  builtAt: new Date().toISOString(), artifact: "dictionary.ndjson.gz", compression: "gzip", mediaType: "application/x-ndjson",
  bytes: payload.byteLength, sha256: createHash("sha256").update(payload).digest("hex"),
  counts: { terms: 3 + contextTerms.length, kanji: 0, sentences: 0 }, languages: ["eng", "spa"],
  dictionaries: ["jmdict", "jmnedict"].map((slug) => ({ slug, version: "installed-parity" })), modifications: [], sources: [],
  audio: { baseUrl: "https://cdn.shirabe.org/audio", path: "words", extension: "m4a", separator: "\x1f",
    engineVersion: 1, salt: "test-salt", defaultVoice: "male", voices: { male: 1628969216, female: 345585728 } },
};
const server = createServer((request, response) => {
  response.setHeader("Access-Control-Allow-Origin", "*");
  if (request.url.endsWith("/current")) {
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ ...manifest, downloadUrl: `${origin}/dictionary.gz` }));
  } else if (request.url === "/dictionary.gz") {
    response.setHeader("Content-Type", "application/gzip");
    response.end(payload);
  } else {
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    response.end(`<!doctype html><title>Installed parity</title><p>${request.url === "/adverb" ? "上手く。" : "ﾊﾞﾅﾅ。"}</p>`);
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
origin = `http://127.0.0.1:${server.address().port}`;
let context;
try {
  context = await chromium.launchPersistentContext(profile, {
    channel: "chromium", headless: true,
    args: [
      `--disable-extensions-except=${extension}`, `--load-extension=${extension}`,
      "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost",
    ],
  });
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent("serviceworker", { timeout: 15000 });
  const id = new URL(worker.url()).host;
  const page = await context.newPage();
  await page.goto(`chrome-extension://${id}/options/options.html`);
  const response = await page.evaluate(() => chrome.runtime.sendMessage({ type: "dictionaryStatus" }));
  assert.equal(response.ok, true);
  assert.equal(response.type, "dictionaryStatus");
  await page.evaluate(async (apiBase) => {
    const { config = {} } = await chrome.storage.local.get("config");
    await chrome.storage.local.set({ config: { ...config, apiBase, errorReports: false, scanModifier: "none" } });
  }, origin);
  const installed = await page.evaluate(() => chrome.runtime.sendMessage({ type: "installDictionary" }));
  assert.equal(installed.ok, true, JSON.stringify(installed));
  await page.waitForFunction(async () => {
    const result = await chrome.runtime.sendMessage({ type: "dictionaryStatus" });
    return result.ok && result.dictionary.installed;
  }, undefined, { timeout: 15000 });
  const parsed = await page.evaluate(() => chrome.runtime.sendMessage({ type: "parseBatch", texts: ["ﾊﾞﾅﾅ。"] }));
  assert.equal(parsed.ok, true, JSON.stringify(parsed));
  assert.equal(parsed.tokens[0][0].entry, "jmdict:banana");
  assert.equal(parsed.tokens[0][0].surface, "ﾊﾞﾅﾅ");
  assert.equal(parsed.tokens[0][1].start, 4);
  const contextual = await page.evaluate(() => chrome.runtime.sendMessage({ type: "parseBatch",
    texts: ["学校にいった。", "先生にいった。", "「行く」と学校にいった。"] }));
  assert.equal(contextual.ok, true, JSON.stringify(contextual));
  for (const [index, expected] of [[0, "1578850"], [1, "1587040"], [2, "1587040"]]) {
    const verb = contextual.tokens[index].find((token) => token.surface === "いった");
    assert.equal(verb?.entry, `jmdict:${expected}`);
    assert.equal(verb?.lemma, expected === "1578850" ? "いく" : "いう");
    assert.ok(verb.candidates.some((candidate) => candidate.entry === "jmdict:1546640"));
  }
  const lookup = await page.evaluate(() => chrome.runtime.sendMessage({ type: "lookup", query: "banana" }));
  assert.equal(lookup.definition.entry, "jmdict:banana");
  const adverbial = await page.evaluate(() => chrome.runtime.sendMessage({ type: "parseBatch", texts: ["上手く。"] }));
  assert.equal(adverbial.ok, true, JSON.stringify(adverbial));
  const selected = adverbial.tokens[0][0];
  assert.equal(selected.entry, "jmdict:well");
  assert.equal(selected.lemma, "上手い");
  assert.equal(selected.reading, "うまく");
  assert.deepEqual(selected.candidates.map((candidate) => candidate.entry), ["jmdict:well", "jmdict:skilled"]);
  const [article, tab] = await Promise.all([
    context.waitForEvent("page"),
    page.evaluate((url) => chrome.tabs.create({ url }), `${origin.replace("127.0.0.1", "localhost")}/article`),
  ]);
  await article.waitForLoadState();
  article.on("console", (message) => console.log(`Content: ${message.text()}`));
  await article.waitForFunction(() => document.documentElement.hasAttribute("data-sb-marked"));
  await page.evaluate((tabId) => chrome.tabs.sendMessage(tabId, { command: "parsePage" }), tab.id);
  try {
    await article.locator(".sb-word[data-entry='jmdict:banana']").waitFor({ timeout: 15000 });
  } catch (error) {
    console.error(await article.content());
    throw error;
  }
  const annotated = await article.locator(".sb-word").evaluate((word) => ({
    surface: word.dataset.surface, lemma: word.dataset.lemma, entry: word.dataset.entry,
  }));
  assert.deepEqual(annotated, { surface: "ﾊﾞﾅﾅ", lemma: "バナナ", entry: "jmdict:banana" });
  assert.equal(await article.locator("p").evaluate((element) => {
    const clone = element.cloneNode(true);
    clone.querySelectorAll("rt, rp").forEach((ruby) => ruby.remove());
    return clone.textContent;
  }), "ﾊﾞﾅﾅ。");
  const word = article.locator(".sb-word");
  await word.hover();
  const choice = article.locator(".sb-host button.sb-candidate[data-entry='jmnedict:name']");
  await choice.waitFor({ timeout: 15000 });
  const candidates = await article.locator(".sb-host button.sb-candidate").evaluateAll((buttons) => buttons.map((button) => button.dataset.entry));
  await choice.click();
  await article.waitForFunction(() => document.querySelector(".sb-word")?.dataset.entry === "jmnedict:name");
  assert.equal(await word.getAttribute("data-lemma"), "花捺");
  await article.keyboard.press("Escape");
  await choice.waitFor({ state: "hidden" });
  await article.mouse.move(0, 0);
  await word.hover();
  await choice.waitFor();
  assert.equal(await choice.getAttribute("aria-checked"), "true");
  assert.equal(await word.getAttribute("data-entry"), "jmnedict:name");
  assert.equal(await word.getAttribute("data-lemma"), "花捺");
  assert.deepEqual(await article.locator(".sb-host button.sb-candidate").evaluateAll((buttons) => buttons.map((button) => button.dataset.entry)), candidates);
  const pickedWord = await word.evaluate((element) => ({
    lemma: element.dataset.lemma, surface: element.dataset.surface, reading: element.dataset.reading, entry: element.dataset.entry,
  }));
  await article.goto(`${origin.replace("127.0.0.1", "localhost")}/adverb`);
  await article.waitForFunction(() => document.documentElement.hasAttribute("data-sb-marked"));
  await page.evaluate((tabId) => chrome.tabs.sendMessage(tabId, { command: "parsePage" }), tab.id);
  const adverbWord = article.locator(".sb-word[data-entry='jmdict:well']");
  await adverbWord.waitFor({ timeout: 15000 });
  assert.equal(await adverbWord.getAttribute("data-lemma"), "上手い");
  assert.equal(await adverbWord.getAttribute("data-surface"), "上手く");
  await adverbWord.hover();
  const adverbChoice = article.locator(".sb-host button.sb-candidate[data-entry='jmdict:well']");
  await adverbChoice.waitFor({ timeout: 15000 });
  assert.equal(await adverbChoice.getAttribute("aria-checked"), "true");
  assert.equal(await article.locator(".sb-host .sb-gloss-row").innerText(), "well");
  if (process.env.PARITY_SAVE_API) {
    const saveApi = new URL(process.env.PARITY_SAVE_API);
    assert.equal(saveApi.protocol, "http:");
    assert.equal(saveApi.hostname, "127.0.0.1", "The save check must use an isolated local Rails server");
    assert.ok(process.env.PARITY_SAVE_TOKEN, "A local Rails API token is required for the save check");
    assert.ok(process.env.PARITY_SAVE_REFRESH_TOKEN, "A local Rails OAuth refresh token is required for the save check");
    await page.evaluate(async ({ apiBase, accessToken, refreshToken }) => {
      const { config = {} } = await chrome.storage.local.get("config");
      await chrome.storage.local.set({ config: { ...config, apiBase, accessToken, refreshToken,
        accessTokenExpiresAt: new Date(Date.now() + 3600000).toISOString() } });
    }, { apiBase: process.env.PARITY_SAVE_API, accessToken: process.env.PARITY_SAVE_TOKEN, refreshToken: process.env.PARITY_SAVE_REFRESH_TOKEN });
    await page.waitForFunction(async (apiBase) => (await chrome.runtime.sendMessage({ type: "status" })).status.apiBase === apiBase,
      process.env.PARITY_SAVE_API);
    const saved = await page.evaluate((word) => chrome.runtime.sendMessage({ type: "save", ...word }), pickedWord);
    assert.equal(saved.ok, true, JSON.stringify(saved));
    assert.equal(saved.result.created, true);
    console.log(JSON.stringify({ savedPickedEntry: pickedWord.entry }));
  }
  console.log(JSON.stringify({ extension: id, profile, installed: true, parsed: parsed.tokens, lookup: lookup.definition.entry, annotated,
    adverb: { entry: selected.entry, lemma: selected.lemma, reading: selected.reading, popup: true },
    reopened: { entry: "jmnedict:name", lemma: "花捺", candidates } }));
} finally {
  await context?.close();
  server.close();
}
