import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createReadStream, mkdtempSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { cmd } from "web-ext";
import { build } from "esbuild";
import { pathToFileURL } from "node:url";

const sourceDir = resolve("dist/verify/firefox");
const artifactsDir = mkdtempSync(join(tmpdir(), "shirabe-firefox-install-"));
const packDir = process.argv[2] && resolve(process.argv[2]);
const pack = packDir && JSON.parse(readFileSync(join(packDir, "manifest.json"), "utf8"));
let web;
if (packDir) {
  const output = join(artifactsDir, "web.json");
  execFileSync("bin/rails", ["runner", "script/export_search_parity.rb"], {
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
  runner = await cmd.run({
    sourceDir, artifactsDir, target: ["firefox-desktop"],
    firefox: process.env.FIREFOX_BINARY ?? (process.platform === "darwin" ? "/Applications/Firefox.app/Contents/MacOS/firefox" : "firefox"),
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
    const deadline = Date.now() + 15000;
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
  const message = (request) => resolveInPage(`browser.runtime.sendMessage(${JSON.stringify(request)})`);
  assert.equal(await resolveInPage('Promise.resolve("あ".repeat(20000))'), "あ".repeat(20000));
  const status = await message({ type: "dictionaryStatus" });
  assert.equal(status?.ok, true);
  assert.equal(status.type, "dictionaryStatus");
  assert.equal(status.dictionary.installed, false);
  console.log(JSON.stringify({ messageHandler: true }));
  if (packDir) {
    await resolveInPage(`browser.storage.local.set({config: {apiBase: ${JSON.stringify(origin)}, errorReports: false, scanModifier: "none"}})`);
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
    const parsed = await message({ type: "parseBatch", texts: ["上手く。", "食べました。"] });
    assert.equal(parsed.ok, true, JSON.stringify(parsed));
    assert.equal(parsed.tokens[0][0].entry, "jmdict:1310490");
    assert.equal(parsed.tokens[0][0].lemma, "上手い");
    assert.equal(parsed.tokens[1][0].entry, "jmdict:1358280");
    assert.equal(parsed.tokens[1][0].reading, "たべました");
    const article = await resolveInPage(`browser.tabs.create({url: ${JSON.stringify(origin.replace("127.0.0.1", "localhost") + "/article")}})`);
    const inArticle = (body) => resolveInPage(`browser.scripting.executeScript({target: {tabId: ${article.id}}, func: () => {${body}}}).then(results => results[0].result)`);
    const waitForArticle = async (body) => {
      const deadline = Date.now() + 15000;
      while (Date.now() < deadline) {
        const result = await inArticle(body);
        if (result) return result;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      throw new Error(`Firefox article check timed out: ${body}`);
    };
    await waitForArticle('return document.documentElement.hasAttribute("data-sb-marked");');
    await resolveInPage(`browser.tabs.sendMessage(${article.id}, {command: "parsePage"})`);
    const annotated = await waitForArticle('const word = document.querySelector(".sb-word[data-surface=\'弾けた\']"); return word && {surface: word.dataset.surface, lemma: word.dataset.lemma, entry: word.dataset.entry};');
    assert.deepEqual(annotated, { surface: "弾けた", lemma: "弾く", entry: "jmdict:1419370" });
    await inArticle('document.querySelector(".sb-word[data-surface=\'弾けた\']").dispatchEvent(new MouseEvent("mouseover", {bubbles: true}));');
    const rendered = await waitForArticle('const root = document.querySelector(".sb-host")?.shadowRoot; const selected = root?.querySelector(".sb-candidate[aria-checked=\'true\']"); const gloss = root?.querySelector(".sb-gloss-row"); return selected && gloss && {entry: selected.dataset.entry, gloss: gloss.innerText};');
    assert.equal(rendered.entry, "jmdict:1419370");
    assert.match(rendered.gloss, /play/i);
    console.log(JSON.stringify({ renderedArticle: annotated, renderedPopup: rendered }));
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
    const checker = join(artifactsDir, "intent.mjs");
    await build({ entryPoints: ["test/support/search-intent.ts"], bundle: true, platform: "node", format: "esm", outfile: checker, logLevel: "silent" });
    const { inflectionsAgree, intentErrors, readingsAgree, studyIdentityErrors } = await import(pathToFileURL(checker).href);
    let parityFailures = 0;
    let intentFailures = 0;
    for (const row of web.contexts) {
      const response = await message({ type: "parseBatch", texts: [row.text] });
      assert.equal(response.ok, true, JSON.stringify({ text: row.text, response }));
      const tokens = response.tokens[0].map((token) => ({ ...token, entry: token.entry ?? null,
        candidates: token.candidates?.map((candidate) => candidate.entry) ?? (token.entry ? [token.entry] : []) }));
      const popupErrors = [];
      for (const token of tokens) {
        const expected = row.expect.find((item) => item.surface === token.surface);
        if (!token.entry) continue;
        const lookup = await message({ type: "lookupEntry", entry: token.entry, surface: token.surface });
        assert.equal(lookup.ok, true, JSON.stringify(lookup));
        const definition = lookup.definition;
        popupErrors.push(...studyIdentityErrors(definition?.baseForm ?? definition?.inflectionBase ?? definition?.headword,
          definition?.baseReading ?? definition?.reading, web.study_identities[token.entry]).map((error) => `${token.surface}: ${error}`));
        token.inflection = definition?.inflection ?? [];
        token.inflectionBase = definition?.inflectionBase ?? (definition?.inflection?.length ? definition.headword : undefined);
        if (definition?.inflection?.length && expected?.lemma !== undefined && (definition.inflectionBase ?? definition.headword) !== expected.lemma) popupErrors.push(`${token.surface}: unexpected popup base`);
      }
      const identity = (token) => [token.start, token.length, token.lemma, token.entry, token.candidates];
      const readings = readingsAgree(tokens, row.web);
      const inflections = inflectionsAgree(tokens, row.web);
      const parity = JSON.stringify(tokens.map(identity)) === JSON.stringify(row.web.map(identity)) && readings && inflections;
      const errors = intentErrors(tokens, row.expect).concat(popupErrors);
      const webErrors = intentErrors(row.web, row.expect);
      if (!parity) parityFailures += 1;
      if (errors.length || webErrors.length) intentFailures += 1;
      console.log(JSON.stringify({ text: row.text, parity, readings, inflections, firefoxIntent: errors, webIntent: webErrors, firefox: tokens }));
    }
    console.log(JSON.stringify({ contextualCases: web.contexts.length, parityFailures, intentFailures }));
    if (parityFailures || intentFailures) process.exitCode = 1;
  }
  console.log(JSON.stringify({ installed: true, browser: "firefox", id: addon.id, name: addon.name, messageHandler: true }));
} finally {
  await runner?.exit();
  server?.closeAllConnections();
  server?.close();
}
