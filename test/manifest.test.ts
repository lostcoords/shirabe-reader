import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("the local scanner loads on ordinary pages while required API hosts stay Shirabe-only", () => {
  const manifest = JSON.parse(readFileSync("manifest.base.json", "utf8")) as {
    host_permissions?: string[];
    optional_host_permissions?: string[];
    content_scripts?: Array<{ matches?: string[]; js?: string[]; css?: string[]; all_frames?: boolean }>;
  };

  assert.deepEqual(manifest.host_permissions, ["https://shirabe.org/*"]);
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
    readFileSync("src/reader/reader.css", "utf8"),
  ];
  for (const css of surfaces) {
    assert.match(css, /focus-visible/);
    assert.match(css, /prefers-reduced-motion/);
    assert.match(css, /forced-colors/);
  }
});

test("built-in auto sites expose an explicit optional-access control", () => {
  const popup = readFileSync("src/action/popup.html", "utf8");
  assert.match(popup, /<label for="siteMode">/);
  assert.match(popup, /id="enableSiteAccess"[^>]*>Enable automatic access<\/button>/);
});

test("the action popup navigates with a bottom bar and hands settings to its own page", () => {
  const popup = readFileSync("src/action/popup.html", "utf8");
  const css = readFileSync("src/action/popup.css", "utf8");
  const options = readFileSync("src/options/options.html", "utf8");
  const manifest = JSON.parse(readFileSync("manifest.base.json", "utf8"));

  // Firefox sizes the panel from the root's intrinsic width, so it stays fixed.
  assert.match(css, /html,\s*\nbody\s*\{[^}]*width:\s*400px;[^}]*min-width:\s*400px;/s);
  assert.doesNotMatch(css, /max-width:\s*100vw/);
  assert.match(css, /--primary:\s*#0369a1/);
  assert.match(css, /--brand-purple:\s*#7b61ff/);
  assert.match(css, /--radius-card:\s*18px/);
  assert.match(popup, /class="reader-buttons"/);
  assert.match(popup, /<symbol id="icon-search"/);

  // Every tab in the bar must own a panel, and every panel must have a tab.
  const tabs = [...popup.matchAll(/role="tab"[^>]*aria-controls="panel-(\w+)"/g)].map((match) => match[1]);
  const panels = [...popup.matchAll(/id="panel-(\w+)"[^>]*role="tabpanel"/g)].map((match) => match[1]);
  assert.deepEqual(tabs, [ "search", "page", "dictionary" ]);
  assert.deepEqual(panels.slice().sort(), tabs.slice().sort());
  assert.match(css, /\.tabbar\s*\{[^}]*position:\s*sticky;[^}]*bottom:\s*0;/s);

  // Settings leaves for its own page, so it is a link out rather than a tab.
  assert.match(popup, /id="openSettings"[^>]*type="button"/);
  assert.doesNotMatch(popup, /id="openSettings"[^>]*role="tab"/);
  assert.equal(manifest.options_ui.page, "options/options.html");
  assert.equal(manifest.options_ui.open_in_tab, true);

  // The preferences the popup dropped must exist on the options page instead.
  for (const id of [ "prefs", "keybinds", "advanced", "scanModifier", "languages", "furiganaMode", "apiBase", "apiKey" ]) {
    assert.match(options, new RegExp(`id="${id}"`), `options page is missing #${id}`);
    assert.doesNotMatch(popup, new RegExp(`id="${id}"`), `popup should no longer own #${id}`);
  }
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

test("offline storage indexes lookup keys off the term record", () => {
  const dictionary = readFileSync("src/common/offline-dictionary.ts", "utf8");
  assert.match(dictionary, /const DB_NAME = "shirabe-offline-dictionary-v3"/);
  // A term's keys live on the record, indexed multiEntry: no join table, so one
  // put per record instead of one per key, and a probe returns the record.
  assert.match(dictionary, /ensureIndex\(terms, "lookupKeys", "keys", \{ multiEntry: true \}\)/);
  assert.doesNotMatch(dictionary, /"lookups"/, "the join table is gone; nothing may reference it");
});

test("dictionary failures render self-contained popup diagnostics", () => {
  const popup = readFileSync("src/action/popup.html", "utf8");
  const logic = readFileSync("src/action/popup.ts", "utf8");
  assert.match(popup, /id="dictionaryDiagnostics"/);
  assert.match(logic, /build: 0\.1\.0-dev-storage-isolation/);
  assert.match(logic, /manifest: HTTP \$\{response\.status\}/);
  assert.match(logic, /background: reachable/);
});

test("dictionary installation uses a persistent background port", () => {
  const browser = readFileSync("src/common/browser.ts", "utf8");
  const popup = readFileSync("src/action/popup.ts", "utf8");
  const background = readFileSync("src/background/background.ts", "utf8");
  assert.match(browser, /connect\(connectInfo\?: \{ name\?: string \}\): RuntimePort/);
  assert.match(popup, /ext\.runtime\.connect\(\{ name: "shirabe-dictionary" \}\)/);
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

test("anonymous dictionary use is the default and OAuth is an explicit Pro action", () => {
  const popup = readFileSync("src/action/popup.html", "utf8");
  const popupLogic = readFileSync("src/action/popup.ts", "utf8");
  const api = readFileSync("src/common/api.ts", "utf8");
  const background = readFileSync("src/background/background.ts", "utf8");

  assert.match(popup, /Optional Pro features/);
  assert.match(popup, /Search, parsing, and the offline dictionary need no account/);
  assert.match(popup, /Connect Pro account/);
  assert.doesNotMatch(api, /const OAUTH_SCOPES = \[[^\]]*READ_DICTIONARY/);
  assert.match(api, /const OAUTH_SCOPES = \["READ_ACCOUNT", "READ_SRS", "WRITE_SRS"\]/);
  assert.match(popupLogic, /\$<HTMLButtonElement>\("connect"\)\.addEventListener\("click"/);
  assert.match(background, /launchWebAuthFlow\(\{ url, interactive: true, redirect_uri: redirectUri \}\)/);
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
