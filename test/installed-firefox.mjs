import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createReadStream, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { cmd } from "web-ext";
import { build } from "esbuild";
import { pathToFileURL } from "node:url";

const sourceDir = resolve("dist/verify/firefox");
const artifactsDir = mkdtempSync(join(tmpdir(), "shirabe-firefox-install-"));
const profileDir = process.env.FIREFOX_TEST_PROFILE;
const reuseProfile = process.env.FIREFOX_REUSE_PROFILE === "1";
if (reuseProfile) assert.ok(profileDir, "FIREFOX_REUSE_PROFILE requires FIREFOX_TEST_PROFILE");
const packDir = process.argv[2] && resolve(process.argv[2]);
const pack = packDir && JSON.parse(readFileSync(join(packDir, "manifest.json"), "utf8"));
let web;
if (packDir && (!reuseProfile || process.env.FIREFOX_PARITY_WEB_OUTPUT)) {
  const output = process.env.FIREFOX_PARITY_WEB_OUTPUT ?? join(artifactsDir, "web.json");
  if (!reuseProfile) execFileSync("bin/rails", ["runner", "script/export_search_parity.rb"], {
    cwd: "..", stdio: "inherit",
    env: { ...process.env, PARITY_PACK_DIR: packDir, PARITY_WEB_OUTPUT: output,
      PARITY_DICTIONARIES: pack.dictionaries.filter(({ slug }) => ["jmdict", "jmnedict"].includes(slug)).map(({ slug }) => slug).join(",") },
  });
  web = JSON.parse(readFileSync(output, "utf8"));
  assert.equal(web.pack.sha256, pack.sha256);
}
let server;
let origin;
let servePack = false;
if (packDir) {
  server = createServer((request, response) => {
    response.setHeader("Access-Control-Allow-Origin", "*");
    if (request.url.endsWith("/current")) {
      if (!servePack) {
        response.writeHead(503).end();
        return;
      }
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ ...pack, downloadUrl: `${origin}/dictionary.gz` }));
    } else if (request.url === "/article") {
      response.setHeader("Content-Type", "text/html; charset=utf-8");
      response.end('<!doctype html><html lang="ja"><meta charset="utf-8"><title>Lookup check</title><body><p>ギターが弾けた。</p></body></html>');
    } else if (request.url === "/dictionary.gz") {
      response.setHeader("Content-Type", "application/gzip");
      createReadStream(join(packDir, pack.artifact)).pipe(response);
    } else {
      response.writeHead(404).end();
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
}
let runner;
try {
  execFileSync(process.execPath, ["build.mjs", "firefox", "--outdir=dist/verify/firefox", ...(origin ? [`--api=${origin}`] : [])], { stdio: "inherit" });
  const manifest = JSON.parse(readFileSync(join(sourceDir, "manifest.json"), "utf8"));
  if (packDir) {
    manifest.host_permissions.push("http://127.0.0.1/*", "http://localhost/*");
    writeFileSync(join(sourceDir, "manifest.json"), JSON.stringify(manifest));
  }
  runner = await cmd.run({
    sourceDir, artifactsDir, target: ["firefox-desktop"],
    firefox: process.env.FIREFOX_BINARY ?? (process.platform === "darwin" ? "/Applications/Firefox.app/Contents/MacOS/firefox" : "firefox"),
    ...(profileDir ? { firefoxProfile: profileDir, profileCreateIfMissing: true, keepProfileChanges: true } : {}),
    args: ["-headless"], noReload: true, noInput: true, startUrl: ["about:blank"],
  });
  const firefox = runner.extensionRunners[0].remoteFirefox;
  const originalRequest = firefox.client.request.bind(firefox.client);
  firefox.client.request = async (packet) => {
    let timer;
    try {
      return await Promise.race([
        originalRequest(packet),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(`Firefox request timed out: ${typeof packet === "string" ? packet : packet.type}`)), 15000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
  const addon = await firefox.getInstalledAddon(manifest.browser_specific_settings.gecko.id);
  assert.equal(addon.id, manifest.browser_specific_settings.gecko.id);
  assert.equal(addon.name, manifest.name);
  const watcher = await firefox.client.request({ to: addon.actor, type: "getWatcher" });
  const client = firefox.client;
  const handleMessage = client._handleMessage.bind(client);
  client._handleMessage = (packet) => {
    if (["target-available-form", "target-destroyed-form", "evaluationResult", "resources-available-array"].includes(packet.type)) {
      client.emit("firefox-event", packet);
    } else handleMessage(packet);
  };
  const nextEvent = (type, accepts = () => true) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      client.off("firefox-event", receive);
      reject(new Error(`Firefox did not emit ${type}`));
    }, 15000);
    function receive(packet) {
      if (packet.type !== type || !accepts(packet)) return;
      clearTimeout(timer);
      client.off("firefox-event", receive);
      resolve(packet);
    }
    client.on("firefox-event", receive);
  });
  const available = nextEvent("target-available-form", (packet) => packet.target.url.startsWith("moz-extension://"));
  await client.request({ to: watcher.actor, type: "watchTargets", targetType: "frame" });
  const { target } = await available;
  const evaluate = async (frame, text) => {
    const completed = nextEvent("evaluationResult", (packet) => packet.from === frame.consoleActor);
    await client.request({ to: frame.consoleActor, type: "evaluateJSAsync", text });
    const result = await completed;
    assert.ok(!result.hasException, result.exceptionMessage);
    return result.result;
  };
  assert.equal(await evaluate(target, "browser.runtime.getManifest().version"), manifest.version);
  const optionsAvailable = nextEvent("target-available-form", (packet) => packet.target.url.endsWith("/options/options.html"));
  await evaluate(target, 'browser.tabs.create({url: browser.runtime.getURL("options/options.html")}); true');
  const { target: options } = await optionsAvailable;
  const resolveInPage = async (expression) => {
    await evaluate(options, `globalThis.__parityStatus = undefined; (${expression}).then(value => globalThis.__parityStatus = JSON.stringify({value}), error => globalThis.__parityStatus = JSON.stringify({error: String(error)})); true`);
    const deadline = Date.now() + (packDir ? 90000 : 15000);
    while (Date.now() < deadline) {
      const length = await evaluate(options, 'typeof globalThis.__parityStatus === "string" ? globalThis.__parityStatus.length : 0');
      if (typeof length === "number" && length > 0) {
        let serialized = "";
        for (let offset = 0; offset < length; offset += 8000) {
          const chunk = await evaluate(options, `globalThis.__parityStatus.slice(${offset}, ${offset + 8000})`);
          assert.equal(typeof chunk, "string");
          serialized += chunk;
        }
        const result = JSON.parse(serialized);
        assert.equal(result.error, undefined, result.error);
        return result.value;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error("Firefox evaluation timed out");
  };
  if (packDir) console.log(JSON.stringify({ articlePermission: await resolveInPage(
    'browser.permissions.contains({origins: ["http://localhost/*"]})') }));
  const technicalDataPermission = await resolveInPage('browser.permissions.contains({data_collection: ["technicalAndInteraction"]})');
  assert.equal(typeof technicalDataPermission, "boolean");
  console.log(JSON.stringify({ technicalDataPermission }));
  const message = (request) => resolveInPage(`browser.runtime.sendMessage(${JSON.stringify(request)})`);
  assert.equal(await resolveInPage('Promise.resolve("あ".repeat(20000))'), "あ".repeat(20000));
  const status = await message({ type: "dictionaryStatus" });
  assert.equal(status?.ok, true);
  assert.equal(status.type, "dictionaryStatus");
  assert.equal(status.dictionary.installed, reuseProfile);
  console.log(JSON.stringify({ messageHandler: true }));
  if (reuseProfile) {
    const started = performance.now();
    const parsed = await message({ type: "parseBatch", texts: ["上手く。", "食べました。"] });
    console.log(JSON.stringify({ restartColdParseMs: Math.round(performance.now() - started),
      revision: status.dictionary.revision }));
    assert.equal(parsed.ok, true, JSON.stringify(parsed));
    assert.equal(parsed.tokens[0][0].entry, "jmdict:1310490");
    assert.equal(parsed.tokens[1][0].entry, "jmdict:1358280");
    const text = "静かで美しい。";
    const sentence = await message({ type: "parseBatch", texts: [text] });
    assert.equal(sentence.ok, true, JSON.stringify(sentence));
    const token = sentence.tokens[0].find((item) => item.surface === "で");
    assert.equal(token?.lemma, "だ");
    const lookup = await message({ type: "lookupSpan", text, startOffset: token.start, endOffset: token.start + token.length,
      lemma: token.lemma, kind: token.kind, reading: token.reading, pos: token.pos,
      inflection: token.inflection, entry: token.entry });
    assert.equal(lookup.ok, true, JSON.stringify(lookup));
    assert.deepEqual(lookup.groups, [["jmdict:2089020"]]);
  } else if (packDir) {
    await resolveInPage(`browser.storage.local.set({config: {apiBase: ${JSON.stringify(origin)}, errorReports: false, scanModifier: "none", popupHideAutomatically: false}})`);
    assert.equal((await message({ type: "status" })).status.apiBase, origin);
    console.log(JSON.stringify({ apiBase: origin }));
    servePack = true;
    const installationStarted = performance.now();
    const installation = await message({ type: "installDictionary" });
    assert.equal(installation.ok, true, JSON.stringify(installation));
    const deadline = Date.now() + 180000;
    let installed = false;
    let stage;
    while (Date.now() < deadline) {
      const state = (await message({ type: "dictionaryStatus" })).dictionary;
      assert.equal(state.error, null, state.error);
      installed = state.installed;
      if (state.stage !== stage) {
        stage = state.stage;
        console.log(JSON.stringify({ stage, progress: state.progress }));
      }
      if (installed) break;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    assert.equal(installed, true, "Firefox dictionary installation timed out");
    console.log(JSON.stringify({ installationMs: Math.round(performance.now() - installationStarted), bytes: pack.bytes, terms: pack.counts.terms }));
    const dictionary = (await message({ type: "dictionaryStatus" })).dictionary;
    assert.equal(dictionary.revision, pack.contentRevision);
    assert.equal(dictionary.terms, pack.counts.terms);
    if (process.env.PROFILE_FIRST_PARSE_DELAY_MS) await new Promise((resolve) =>
      setTimeout(resolve, Number(process.env.PROFILE_FIRST_PARSE_DELAY_MS)));
    if (process.env.PROFILE_FIRST_PARSE) await evaluate(target, `
      globalThis.__readerIdbReads = [];
      const original = IDBIndex.prototype.getAll;
      IDBIndex.prototype.getAll = function (...args) {
        const started = performance.now();
        const request = original.apply(this, args);
        request.addEventListener("success", () => globalThis.__readerIdbReads.push({
          index: this.name, key: String(args[0]?.lower ?? args[0] ?? "").slice(-24),
          ms: Math.round(performance.now() - started), count: request.result?.length ?? 0,
        }));
        return request;
      };
      true
    `);
    const coldParseStarted = performance.now();
    const parsed = await message({ type: "parseBatch", texts: ["上手く。", "食べました。"] });
    console.log(JSON.stringify({ coldParseMs: Math.round(performance.now() - coldParseStarted) }));
    if (process.env.PROFILE_FIRST_PARSE) console.log(JSON.stringify({ idbFirstParse: JSON.parse(await evaluate(target,
      'JSON.stringify({count: globalThis.__readerIdbReads.length, slowest: [...globalThis.__readerIdbReads].sort((a, b) => b.ms - a.ms).slice(0, 20), totalMs: globalThis.__readerIdbReads.reduce((sum, row) => sum + row.ms, 0)})')) }));
    assert.equal(parsed.ok, true, JSON.stringify(parsed));
    assert.equal(parsed.tokens[0][0].entry, "jmdict:1310490");
    assert.equal(parsed.tokens[0][0].lemma, "上手い");
    assert.equal(parsed.tokens[1][0].entry, "jmdict:1358280");
    assert.equal(parsed.tokens[1][0].reading, "たべました");
    const warmParseStarted = performance.now();
    const warm = await message({ type: "parseBatch", texts: ["上手く。", "食べました。"] });
    console.log(JSON.stringify({ warmParseMs: Math.round(performance.now() - warmParseStarted) }));
    assert.equal(warm.ok, true, JSON.stringify(warm));
    const coldLookupStarted = performance.now();
    const firstLookup = await message({ type: "lookupEntry", entry: "jmdict:1419370", surface: "弾けた" });
    console.log(JSON.stringify({ coldLookupMs: Math.round(performance.now() - coldLookupStarted) }));
    assert.equal(firstLookup.ok, true, JSON.stringify(firstLookup));
    assert.equal(firstLookup.definition?.entry, "jmdict:1419370");
    const articleParse = await message({ type: "parseBatch", texts: ["ギターが弾けた。"] });
    assert.equal(articleParse.ok, true, JSON.stringify(articleParse));
    const articleToken = articleParse.tokens[0].find((token) => token.surface === "弾けた");
    assert.equal(articleToken?.entry, "jmdict:1419370");
    const spanRequest = { type: "lookupSpan", text: "ギターが弾けた。", startOffset: 4, endOffset: 7,
      lemma: articleToken.lemma, kind: articleToken.kind, reading: articleToken.reading, pos: articleToken.pos,
      inflection: articleToken.inflection, entry: articleToken.entry };
    const spanLookupStarted = performance.now();
    const spanLookup = await message(spanRequest);
    console.log(JSON.stringify({ spanLookupMs: Math.round(performance.now() - spanLookupStarted), alternativeCount: spanLookup.alternatives?.length }));
    assert.equal(spanLookup.ok, true, JSON.stringify(spanLookup));
    assert.equal(spanLookup.definition?.entry, "jmdict:1419370");
    const warmSpanStarted = performance.now();
    const warmSpan = await message(spanRequest);
    console.log(JSON.stringify({ warmSpanMs: Math.round(performance.now() - warmSpanStarted) }));
    assert.equal(warmSpan.ok, true, JSON.stringify(warmSpan));
    const articleUrl = `${origin.replace("127.0.0.1", "localhost")}/article`;
    const article = await resolveInPage(`browser.tabs.create({url: ${JSON.stringify(articleUrl)}})`);
    const navigationDeadline = Date.now() + 15000;
    let articleLoaded = false;
    while (Date.now() < navigationDeadline) {
      const tab = await resolveInPage(`browser.tabs.get(${article.id})`);
      if (tab.url === articleUrl && tab.status === "complete") { articleLoaded = true; break; }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(articleLoaded, true, "Firefox article navigation timed out");
    const inArticle = (body) => resolveInPage(`browser.scripting.executeScript({target: {tabId: ${article.id}}, func: () => {${body}}}).then(results => results[0].result)`);
    const waitForArticle = async (body, timeoutMs = packDir ? 90000 : 15000) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const result = await inArticle(body);
        if (result) return result;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      const state = await inArticle('const host = document.querySelector(".sb-host"); const root = host?.shadowRoot; return {visibility: document.visibilityState, html: document.body.innerHTML.slice(0, 1500), marked: document.documentElement.hasAttribute("data-sb-marked"), popupClass: root?.querySelector(".sb-popup")?.className, content: root?.querySelector(".sb-popup-content")?.textContent?.slice(0, 500)};');
      throw new Error(`Firefox article check timed out: ${body}; ${JSON.stringify(state)}`);
    };
    await waitForArticle('return document.documentElement.hasAttribute("data-sb-marked");');
    const annotated = await waitForArticle('const word = document.querySelector(".sb-word[data-surface=\'弾けた\']"); return word && {surface: word.dataset.surface, lemma: word.dataset.lemma, entry: word.dataset.entry};');
    assert.deepEqual(annotated, { surface: "弾けた", lemma: "弾く", entry: "jmdict:1419370" });
    const hover = await inArticle('const word = document.querySelector(".sb-word[data-surface=\'弾けた\']"); let observed = false; document.addEventListener("mouseover", () => { observed = true; }, {once: true}); const dispatched = word.dispatchEvent(new MouseEvent("mouseover", {bubbles: true, composed: true, altKey: true, ctrlKey: true, shiftKey: true, metaKey: true})); return new Promise(resolve => setTimeout(() => { const root = document.querySelector(".sb-host")?.shadowRoot; resolve({dispatched, observed, readerOff: document.documentElement.classList.contains("sb-reader-off"), open: word.classList.contains("sb-word-open"), popup: root?.querySelector(".sb-popup")?.className, gloss: root?.querySelector(".sb-gloss-row:not([hidden])")?.textContent, content: root?.querySelector(".sb-popup-content")?.textContent?.slice(0, 300)}); }, 500));');
    console.log(JSON.stringify({ hover }));
    assert.equal(hover.dispatched, true);
    assert.equal(hover.readerOff, false);
    assert.match(hover.popup, /sb-visible/);
    const rendered = await waitForArticle('const root = document.querySelector(".sb-host")?.shadowRoot; const gloss = root?.querySelector(".sb-gloss-row:not([hidden])"); return gloss && {gloss: gloss.textContent, visible: root?.querySelector(".sb-popup")?.classList.contains("sb-visible")};', 5000);
    assert.match(rendered.gloss, /play/i);
    console.log(JSON.stringify({ renderedArticle: annotated, renderedPopup: { entry: annotated.entry, ...rendered } }));
    const queries = web.rows;
    for (const row of queries) {
      assert.deepEqual(row.languages, ["en"], "Firefox lookup check currently uses the English gloss stack");
      const result = await message({ type: "lookup", query: row.query });
      if (row.offlineError) {
        assert.equal(result.code, "OFFLINE_LOOKUP_UNAVAILABLE", row.query);
      } else {
        assert.equal(result.ok, true, JSON.stringify({ query: row.query, result }));
        assert.ok(row.leaders.includes(row.web[0]?.headword), JSON.stringify({ query: row.query, web: row.web[0] }));
        assert.equal(result.definition?.entry, row.web[0]?.entry, row.query);
        if (row.leader_entries) assert.ok(row.leader_entries.includes(result.definition.entry), row.query);
      }
    }
    console.log(JSON.stringify({ sharedLookupCases: queries.length, passed: true }));
    console.log(JSON.stringify({ realDictionary: true, parsed: parsed.tokens }));
  }
  if (web) {
    const checker = join(artifactsDir, "intent.mjs");
    await build({ entryPoints: ["test/support/search-intent.ts"], bundle: true, platform: "node", format: "esm", outfile: checker, logLevel: "silent" });
    const { inflectionsAgree, intentErrors, readingsAgree, studyIdentityErrors } = await import(pathToFileURL(checker).href);
    let parityFailures = 0;
    let spanGroupFailures = 0;
    let parserEntryDifferences = 0;
    let intentFailures = 0;
    let sharedIntentFindings = 0;
    let readingDifferences = 0;
    const knownReadingDifferences = new Set(["明日勉強します。", "「明日休みます」と先生にいった。", "明日天気になる"]);
    const knownParserEntryDifferences = new Set([
      "今夜 理事長様が有力者を集めて パーティーをするとかで",
      "このままでは借金で首が回らなくなりそうだ。",
      "ギターがかなり上手く弾ける男を知っている。",
      "ギターがかなり上手く弾けた。",
      "家にいった。",
      "魔法は3つの要素で構成されている",
    ]);
    for (const row of web.contexts) {
      const response = await message({ type: "parseBatch", texts: [row.text] });
      assert.equal(response.ok, true, JSON.stringify({ text: row.text, response }));
      const tokens = response.tokens[0].map((token) => ({ ...token, entry: token.entry ?? null, candidates: [] }));
      const popupErrors = [];
      const groupDifferences = [];
      const cardDifferences = [];
      for (const [index, token] of tokens.entries()) {
        const expected = row.expect.find((item) => item.surface === token.surface);
        if (!token.entry) continue;
        const lookup = await message({ type: "lookupSpan", text: row.text,
          startOffset: token.start, endOffset: token.start + token.length,
          lemma: token.lemma, kind: token.kind, reading: token.reading, pos: token.pos,
          inflection: token.inflection, entry: token.entry });
        assert.equal(lookup.ok, true, JSON.stringify(lookup));
        token.candidates = lookup.groups.flat();
        if (JSON.stringify(lookup.groups) !== JSON.stringify(row.web[index]?.groups ?? [])) {
          spanGroupFailures += 1;
          groupDifferences.push({ surface: token.surface, local: lookup.groups, web: row.web[index]?.groups });
        }
        const definition = lookup.definition;
        if (definition?.entry !== row.web[index]?.entry) {
          cardDifferences.push({ surface: token.surface, local: definition?.entry, web: row.web[index]?.entry });
        }
        popupErrors.push(...studyIdentityErrors(definition?.baseForm ?? definition?.inflectionBase ?? definition?.headword,
          definition?.baseReading ?? definition?.reading, web.study_identities[definition?.entry]).map((error) => `${token.surface}: ${error}`));
        token.inflection = definition?.inflection ?? [];
        token.inflectionBase = definition?.inflectionBase ?? (definition?.inflection?.length ? definition.headword : undefined);
        if (definition?.inflection?.length && expected?.lemma !== undefined && (definition.inflectionBase ?? definition.headword) !== expected.lemma) popupErrors.push(`${token.surface}: unexpected popup base`);
      }
      const identity = (token) => [token.start, token.length, token.lemma];
      const readings = readingsAgree(tokens, row.web);
      const inflections = inflectionsAgree(tokens, row.web);
      const parity = JSON.stringify(tokens.map(identity)) === JSON.stringify(row.web.map(identity)) && inflections;
      const entryDifferences = tokens.flatMap((token, index) => token.entry === row.web[index]?.entry
        ? [] : [{ surface: token.surface, local: token.entry, web: row.web[index]?.entry }]);
      if (entryDifferences.length) {
        parserEntryDifferences += 1;
        if (!knownParserEntryDifferences.has(row.text)) parityFailures += 1;
      }
      if (!readings) {
        readingDifferences += 1;
        if (!knownReadingDifferences.has(row.text)) parityFailures += 1;
      }
      const errors = intentErrors(tokens, row.expect).concat(popupErrors);
      const webErrors = intentErrors(row.web, row.expect);
      if (row.text === "映画を見れなかった。") {
        console.log(JSON.stringify({ movieParserInflection: response.tokens[0][2]?.inflection,
          movieResolvedInflection: tokens[2]?.inflection, movieWebInflection: row.web[2]?.inflection,
          movieResolvedBase: tokens[2]?.inflectionBase, movieWebBase: row.web[2]?.inflectionBase }));
      }
      if (!parity || groupDifferences.length || cardDifferences.length) parityFailures += 1;
      if (webErrors.length) sharedIntentFindings += 1;
      if (JSON.stringify(errors) !== JSON.stringify(webErrors)) intentFailures += 1;
      if (!parity || groupDifferences.length || cardDifferences.length || entryDifferences.length ||
          JSON.stringify(errors) !== JSON.stringify(webErrors) || !readings) {
        console.log(JSON.stringify({ text: row.text, parity, readings, inflections, groupDifferences, cardDifferences, entryDifferences,
          firefoxIntent: errors, webIntent: webErrors,
          firefox: tokens.map((token) => identity(token)), web: row.web.map((token) => identity(token)) }));
      }
    }
    console.log(JSON.stringify({ contextualCases: web.contexts.length, parityFailures, spanGroupFailures, parserEntryDifferences,
      intentFailures, sharedIntentFindings, readingDifferences }));
    if (parityFailures || intentFailures) process.exitCode = 1;
  }
  console.log(JSON.stringify({ installed: true, browser: "firefox", id: addon.id, name: addon.name, messageHandler: true }));
} finally {
  await runner?.exit();
  server?.closeAllConnections();
  server?.close();
}
