import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("the local scanner loads on ordinary pages while required API hosts stay Shirabe-only", () => {
  const manifest = JSON.parse(readFileSync("manifest.base.json", "utf8")) as {
    host_permissions?: string[];
    optional_host_permissions?: string[];
    content_scripts?: Array<{ matches?: string[]; js?: string[]; css?: string[]; all_frames?: boolean }>;
  };

  // cdn.shirabe.org lets the background fetch pronunciation clips; o.shirabe.org
  // is the Faro telemetry collector. All first-party Shirabe hosts, fetched only
  // from the background (bypassing the page CSP that blocks cross-origin media).
  assert.deepEqual(manifest.host_permissions, ["https://shirabe.org/*", "https://cdn.shirabe.org/*", "https://o.shirabe.org/*"]);
  assert.deepEqual(manifest.optional_host_permissions, ["<all_urls>"]);
  assert.deepEqual(manifest.content_scripts, [{
    matches: ["<all_urls>"], js: ["content.js"], css: ["content.css"], all_frames: true, run_at: "document_idle",
  }]);
});

test("localhost access is added only to watch builds", () => {
  const builder = readFileSync("build.mjs", "utf8");
  assert.match(builder, /if \(watch\) base\.host_permissions\.push\("https:\/\/shirabe\.localhost\/\*"\)/);
});

test("Firefox watch builds isolate development storage from the release add-on", () => {
  const builder = readFileSync("build.mjs", "utf8");
  assert.match(builder, /id: watch \? "reader-dev@shirabe\.org" : "reader@shirabe\.org"/);
});

test("all extension-owned surfaces preserve focus, reduced-motion, and forced-color behavior", () => {
  const surfaces = [
    readFileSync("src/action/popup.css", "utf8"),
    readFileSync("src/content/content.css", "utf8"),
    readFileSync("src/content/popup.ts", "utf8"),
    readFileSync("src/options/options.css", "utf8"),
  ];
  for (const css of surfaces) {
    assert.match(css, /focus-visible/);
    assert.match(css, /prefers-reduced-motion/);
    assert.match(css, /forced-colors/);
  }
});

test("optional host access is only ever requested from an explicit user action", () => {
  const popup = readFileSync("src/action/popup.ts", "utf8");

  // Store review turns on this: <all_urls> is optional, and the only thing that
  // asks for it is the user clicking the per-site reader toggle. The separate
  // siteMode select is gone — the toggle is the one control that grants access.
  assert.match(popup, /readerToggle\.addEventListener\("click"/);
  assert.match(popup, /const siteAccess = await requestSiteAccess\(siteUrl\)/);
  assert.match(popup, /return ext\.permissions\.request\(\{ origins: \[origin\] \}\)/);

  // Denial is survivable: scanning still works in the open tab via activeTab.
  assert.match(popup, /Site access was not granted/);
});

test("the popup replaces decorative branding with a real per-site reader toggle", () => {
  const markup = readFileSync("src/action/popup.html", "utf8");
  const logic = readFileSync("src/action/popup.ts", "utf8");
  const content = readFileSync("src/content/content.ts", "utf8");

  assert.doesNotMatch(markup, /<header class="head">/);
  assert.doesNotMatch(markup, /Offline lookup/);
  assert.match(markup, /id="readerToggle"[^>]*aria-pressed="true"/);
  assert.match(logic, /await patch\(\{ disabledHosts \}\)/);
  assert.match(content, /if \(mode === "off"\) \{/);
  assert.match(content, /if \(mode === "off" \|\| !localDictionaryReady/);
  assert.match(content, /classList\.toggle\("sb-furigana-off", config\.furiganaMode === "off"\)/);
  assert.match(content, /if \(showFurigana\) ensureFurigana\(\)/);
  assert.match(content, /classList\.toggle\("sb-reader-off", mode === "off"\)/);
  assert.match(content, /setParsingPaused\(true\)/);
  assert.match(content, /hideStatusBar\(\)/);
  assert.doesNotMatch(content, /mode === "off"[\s\S]{0,300}revertParsedPage\(\)/);
});

test("the action popup navigates with a bottom bar and hands settings to its own page", () => {
  const popup = readFileSync("src/action/popup.html", "utf8");
  const css = readFileSync("src/action/popup.css", "utf8");
  const options = readFileSync("src/options/options.html", "utf8");
  const manifest = JSON.parse(readFileSync("manifest.base.json", "utf8"));

  // Firefox sizes the panel from the root's intrinsic width, so it stays fixed.
  assert.match(css, /html,\s*\nbody\s*\{[^}]*width:\s*400px;[^}]*min-width:\s*400px;/s);
  assert.doesNotMatch(css, /max-width:\s*100vw/);
  // Tokens are light-dark pairs (system dark mode); the light half keeps the
  // brand ocean / purple from the site palette.
  assert.match(css, /color-scheme:\s*light dark/);
  assert.match(css, /--primary:\s*light-dark\(#0369a1/);
  assert.match(css, /--brand-purple:\s*light-dark\(#7b61ff/);
  assert.match(css, /--radius-card:\s*18px/);
  assert.doesNotMatch(popup, /readArticle|readSelection|openPasteReader|Paste \/ PDF/);
  assert.match(popup, /<symbol id="icon-search"/);

  // Every tab in the bar must own a panel, and every panel must have a tab.
  const tabs = [...popup.matchAll(/role="tab"[^>]*aria-controls="panel-(\w+)"/g)].map((match) => match[1]);
  const panels = [...popup.matchAll(/id="panel-(\w+)"[^>]*role="tabpanel"/g)].map((match) => match[1]);
  assert.deepEqual(tabs, [ "lookup", "dictionary", "account" ]);
  assert.deepEqual(panels.slice().sort(), tabs.slice().sort());
  assert.match(popup, /id="panel-dictionary"[\s\S]*?<section id="dictionary"[\s\S]*?<\/section>\s*<\/section>\s*<!-- ── Account and profile/);
  assert.match(popup, /id="panel-account"[\s\S]*?<section id="account"/);
  assert.match(css, /\.tabbar\s*\{[^}]*position:\s*sticky;[^}]*bottom:\s*0;/s);

  // Settings leaves for its own page, so it is a link out rather than a tab.
  assert.match(popup, /id="openSettings"[^>]*type="button"/);
  assert.doesNotMatch(popup, /id="openSettings"[^>]*role="tab"/);
  assert.equal(manifest.options_ui.page, "options/options.html");
  assert.equal(manifest.options_ui.open_in_tab, true);

  // The preferences the popup dropped must exist on the options page instead.
  // Server / key / host lists are not user-facing here — connect flow and the
  // per-site reader toggle own those.
  for (const id of [ "prefs", "keybinds", "scanModifier" ]) {
    assert.match(options, new RegExp(`id="${id}"`), `options page is missing #${id}`);
    assert.doesNotMatch(popup, new RegExp(`id="${id}"`), `popup should no longer own #${id}`);
  }
  assert.doesNotMatch(options, /id="advanced"|id="apiBase"|id="apiKey"|href="#advanced"/);

  // Definition language is deliberately available both beside the dictionary
  // and on the full settings page; both controls write Config#languages.
  assert.match(popup, /id="dictionaryLanguages"/);
  assert.match(options, /id="languages"/);
  assert.match(readFileSync("src/action/popup.ts", "utf8"), /await patch\(\{ languages \}\)/);

  // Furigana and scan-modifier are shared preferences, available mid-read in
  // Lookup and on the full settings page without a second stored value.
  assert.match(popup, /id="lookupFuriganaMode"/);
  assert.match(popup, /id="lookupScanModifier"/);
  assert.match(options, /id="furiganaMode"/);
  assert.match(options, /id="scanModifier"/);
  assert.match(readFileSync("src/action/popup.ts", "utf8"), /patch\(\{ furiganaMode \}\)/);
  assert.match(readFileSync("src/action/popup.ts", "utf8"), /patch\(\{ scanModifier \}\)/);
  assert.doesNotMatch(popup, /syncProfile|Sync profile/);
});

test("the first-release bundle excludes the dedicated reader and PDF runtime", () => {
  const builder = readFileSync("build.mjs", "utf8");
  const manifest = readFileSync("manifest.base.json", "utf8");
  const packageJson = readFileSync("package.json", "utf8");
  const messages = readFileSync("src/common/messages.ts", "utf8");

  for (const source of [builder, manifest, packageJson, messages]) {
    assert.doesNotMatch(source, /pdfjs|pdf\.worker|reader\/reader|openReader/);
  }
});

test("extension settings mirror Shirabe's sidebar and card layout without purple accents", () => {
  const options = readFileSync("src/options/options.html", "utf8");
  const css = readFileSync("src/options/options.css", "utf8");
  const logic = readFileSync("src/options/options.ts", "utf8");

  assert.match(options, /class="settings-nav"/);
  assert.match(options, /class="settings-content"/);
  for (const id of ["reading", "keyboard"]) assert.match(options, new RegExp(`href="#${id}"`));
  assert.doesNotMatch(options, /href="#advanced"/);
  assert.match(css, /color-scheme:\s*light dark/);
  assert.match(css, /--surface-page:\s*light-dark\(#f8fafc/);
  assert.match(css, /--surface:\s*light-dark\(#ffffff/);
  assert.match(css, /--primary:\s*light-dark\(#0369a1/);
  assert.match(css, /grid-template-columns:\s*176px minmax\(0, 1fr\)/);
  // Settings stays interaction-blue; purple is identity-only on the action popup.
  assert.doesNotMatch(css, /purple|#7b61ff/i);
  assert.match(logic, /new IntersectionObserver/);
});

test("Firefox and Chrome use their supported asynchronous message contracts", () => {
  const browser = readFileSync("src/common/browser.ts", "utf8");
  const background = readFileSync("src/background/background.ts", "utf8");

  assert.match(browser, /usesPromiseMessageResponses = typeof browser !== "undefined"/);
  assert.match(background, /if \(usesPromiseMessageResponses\) return response;/);
  assert.match(background, /void response\.then\(sendResponse\);\s*\n\s*return true;/);
});

test("a watch build repairs the stale production API default in its persistent profile", () => {
  const config = readFileSync("src/common/config.ts", "utf8");
  assert.match(config, /__DEFAULT_API_BASE__ !== PRODUCTION_API_BASE && config\.apiBase === PRODUCTION_API_BASE/);
  assert.match(config, /config\.apiBase = __DEFAULT_API_BASE__/);
  assert.match(config, /await ext\.storage\.local\.set\(\{ \[KEY\]: config \}\)/);
});

test("concurrent watch builds replace manifests atomically", () => {
  const build = readFileSync("build.mjs", "utf8");
  assert.match(build, /const temporary = `\$\{destination\}\.\$\{process\.pid\}\.\$\{Date\.now\(\)\}\.tmp`/);
  assert.match(build, /await rename\(temporary, destination\)/);
  assert.match(build, /await acquireWatchLock\(\)/);
  assert.match(build, /dev watcher is already running/);
});

test("offline storage indexes lookup keys off the term record", () => {
  const dictionary = readFileSync("src/common/offline-dictionary.ts", "utf8");
  assert.match(dictionary, /const DB_NAME = "shirabe-offline-dictionary-v4"/);
  // A term's keys live on the record, indexed multiEntry: no join table, so one
  // put per record instead of one per key, and a probe returns the record.
  assert.match(dictionary, /ensureIndex\(terms, "lookupKeys", "keys", \{ multiEntry: true \}\)/);
  assert.doesNotMatch(dictionary, /"lookups"/, "the join table is gone; nothing may reference it");
});

test("dictionary failures render self-contained popup diagnostics", () => {
  const popup = readFileSync("src/action/popup.html", "utf8");
  const logic = readFileSync("src/action/popup.ts", "utf8");
  assert.match(popup, /id="dictionaryDiagnostics"/);
  assert.match(logic, /build: 0\.2\.0-contextual-search/);
  assert.match(logic, /manifest: HTTP \$\{response\.status\}/);
  assert.match(logic, /background: reachable/);
});

test("dictionary installation uses a persistent background port", () => {
  const browser = readFileSync("src/common/browser.ts", "utf8");
  const dictionaryPort = readFileSync("src/common/dictionary-port.ts", "utf8");
  const wordPopup = readFileSync("src/content/popup.ts", "utf8");
  const background = readFileSync("src/background/background.ts", "utf8");
  assert.match(browser, /connect\(connectInfo\?: \{ name\?: string \}\): RuntimePort/);
  assert.match(dictionaryPort, /ext\.runtime\.connect\(\{ name: "shirabe-dictionary" \}\)/);
  assert.match(wordPopup, /sendDictionary\(\{ type: "installDictionary" \}\)/);
  assert.match(wordPopup, /response\.dictionary\.progress/);
  assert.match(background, /ext\.runtime\.onConnect\.addListener/);
  assert.match(background, /port\.name !== "shirabe-dictionary"/);
});

test("background failures include exception names, codes, stacks, and request types", () => {
  const background = readFileSync("src/background/background.ts", "utf8");
  assert.match(background, /request: \$\{requestType\}/);
  assert.match(background, /exception: \$\{candidate\.name/);
  assert.match(background, /stack:\\n\$\{candidate\.stack\}/);
  assert.match(background, /console\.error\("\[Shirabe background\] request failed"/);
});

test("anonymous dictionary use is the default and OAuth is an explicit account action", () => {
  const popup = readFileSync("src/action/popup.html", "utf8");
  const popupLogic = readFileSync("src/action/popup.ts", "utf8");
  const api = readFileSync("src/common/api.ts", "utf8");
  const background = readFileSync("src/background/background.ts", "utf8");

  assert.doesNotMatch(popup, /Optional Pro features/);
  assert.doesNotMatch(popup, /Search, parsing, and the offline dictionary need no account/);
  assert.match(popup, /Not connected/);
  assert.match(popup, /Connect account/);
  assert.doesNotMatch(api, /const OAUTH_SCOPES = \[[^\]]*READ_DICTIONARY/);
  assert.match(api, /const OAUTH_SCOPES = \["READ_ACCOUNT", "READ_PREFERENCES", "WRITE_PREFERENCES", "READ_SRS", "WRITE_SRS"\]/);
  assert.match(api, /"\/v1\/preferences"/);
  assert.match(popupLogic, /send\(\{ type: "updateLanguages", languages \}\)/);
  assert.match(popupLogic, /\$<HTMLButtonElement>\("connect"\)\.addEventListener\("click"/);
  assert.match(background, /launchWebAuthFlow\(\{ url, interactive: true \}\)/);
  assert.doesNotMatch(background, /launchWebAuthFlow\([^)]*redirect_uri/);
});

test("opening the action activates raw-text scanning without parsing the page", () => {
  const popup = readFileSync("src/action/popup.ts", "utf8");
  const content = readFileSync("src/content/content.ts", "utf8");

  assert.match(popup, /void activateScannerOnActiveTab\(\)/);
  assert.match(popup, /command: "activateScanner"/);
  assert.match(popup, /insertCSS\(\{ target: \{ tabId: tab\.id, allFrames: true \}/);
  assert.match(popup, /executeScript\(\{ target: \{ tabId: tab\.id, allFrames: true \}/);
  assert.match(content, /lastPointer = event/);
  assert.match(content, /else if \(lastPointer\) scanPointer\(lastPointer, true\)/);
});

test("pronunciation audio only plays processed R2 clips and never browser speech", () => {
  const popup = readFileSync("src/content/popup.ts", "utf8");
  const audio = readFileSync("src/common/audio.ts", "utf8");
  const background = readFileSync("src/background/background.ts", "utf8");
  const webAudio = readFileSync("../app/javascript/controllers/audio_controller.js", "utf8");

  // The R2 allowlist is the fetch security boundary, shared by popup + background.
  assert.match(audio, /hostname === "cdn\.shirabe\.org"/);
  assert.match(audio, /pathname\.startsWith\("\/audio\/"\)/);
  // The background — not the content script — fetches the clip (bypassing page
  // CSP) and only after re-validating the URL, then returns a playable data: URL.
  assert.match(background, /case "audioClip"/);
  assert.match(background, /if \(!isR2AudioUrl\(url\)\)/);
  assert.match(background, /data:\$\{mediaType\};base64,/);
  // The popup plays that data: URL and never points <audio> straight at the CDN.
  assert.match(popup, /send\(\{ type: "audioClip", url \}\)/);
  assert.doesNotMatch(popup, /new Audio\(url\)/);
  assert.doesNotMatch(popup, /speechSynthesis|SpeechSynthesisUtterance/);
  assert.doesNotMatch(webAudio, /speechSynthesis|SpeechSynthesisUtterance/);
});

test("reader grading is due-only and locks after the first click", () => {
  const popup = readFileSync("src/content/popup.ts", "utf8");
  assert.match(popup, /if \(word\.dataset\.state === "due"\)/);
  assert.match(popup, /wrap\.dataset\.running === "true"/);
  assert.match(popup, /control\.disabled = true/);
});

test("offline parsing does not wait for profile-state network hydration", () => {
  const background = readFileSync("src/background/background.ts", "utf8");
  const parser = readFileSync("src/content/parser.ts", "utf8");
  assert.match(background, /return lists;/);
  assert.doesNotMatch(background, /hydrateCachedStates|hydrateStates/);
  assert.match(background, /const LOCAL_PARSE_CONCURRENCY = 4/);
  assert.match(background, /await Promise\.all\(Array\.from/);
  assert.match(background, /const fresh = await api\.states\(lemmas\)/);
  assert.match(background, /pendingRemoteStateLemmas/);
  assert.match(background, /drainRemoteStateRefresh/);
  assert.doesNotMatch(background, /MIN_GAP_MS|function enqueue/);
  assert.match(background, /const STATE_CACHE_MAX_AGE_MS = 5 \* 60 \* 1000/);
  assert.match(background, /lemma in cached\.states/);
  assert.match(background, /cached\.checkedAt\[lemma\]/);
  assert.match(background, /const ACCOUNT_CACHE_MAX_AGE_MS = 5 \* 60 \* 1000/);
  assert.match(background, /Date\.parse\(config\.accountCheckedAt\)/);
  assert.match(background, /let stateCacheWrite: Promise<void> = Promise\.resolve\(\)/);
  assert.match(background, /const STATE_CACHE_MAX_LEMMAS = 20_000/);
  assert.match(background, /memoryStateSnapshot/);
  assert.match(background, /const DECK_CACHE_KEY = "profileDeckSnapshot"/);
  assert.match(background, /async function cachedDecks/);
  assert.match(background, /ext\.storage\.local\.remove\(\[STATE_CACHE_KEY, DECK_CACHE_KEY\]\)/);
  assert.match(parser, /export async function refreshRenderedStates/);
  assert.match(parser, /pendingStateLemmas/);
  assert.match(parser, /requestAnimationFrame\(\(\) => void refreshQueuedStates\(\)\)/);
  assert.match(parser, /send\(\{ type: "states", lemmas \}\)/);
  assert.match(parser, /applyStateEverywhere\(lemma, state\)/);
  assert.match(parser, /const DISCOVERY_SLICE_NODES = 300/);
  assert.match(parser, /scheduleIdle\(work\)/);
  assert.match(parser, /texts: blocks\.map\(\(item\) => item\.text\)/);
  assert.match(parser, /recordPerformance\("parse-render"/);
  const dictionary = readFileSync("src/common/offline-dictionary.ts", "utf8");
  assert.match(dictionary, /activeGenerationCache/);
  assert.match(dictionary, /lookupProbeCache = new BoundedCache/);
});

test("missing offline storage self-heals and the word popup has a stable scrollable frame", () => {
  const background = readFileSync("src/background/background.ts", "utf8");
  const dictionary = readFileSync("src/common/offline-dictionary.ts", "utf8");
  const popup = readFileSync("src/content/popup.ts", "utf8");
  assert.match(dictionary, /if \(!active\) \{\s*await installDictionary\(apiBase\)/);
  assert.match(background, /DictionaryNotInstalledError/);
  assert.match(background, /dictionaryInstalling: true/);
  assert.match(popup, /Preparing the offline dictionary/);
  assert.match(popup, /width: min\(360px, calc\(100vw - 24px\)\)/);
  assert.match(popup, /max-height: min\(60vh, 460px\)/);
  assert.doesNotMatch(popup, /\n  height: min\(460px/);
  assert.match(popup, /overflow-y: auto/);

  // Side-choice for vertical (tategaki) text lives in placement.ts now, not in
  // popup.ts: prefer the left column, fall back to whichever side has room.
  const placement = readFileSync("src/content/placement.ts", "utf8");
  assert.match(placement, /const roomRight = view\.width - avoid\.right - margin \* 2/);
  assert.match(placement, /roomLeft >= size\.width \|\| roomLeft >= roomRight/);
});
