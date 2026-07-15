import { ext } from "../common/browser.js";
import { DEFAULTS, loadConfig, saveConfig, type Config } from "../common/config.js";
import { loadHostRules, matchUrl, normalizePattern, resolveHostMode, siteScopeFor, type HostRule } from "../common/host-rules.js";
import { send, type Request, type Response } from "../common/messages.js";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

type DictionaryRequest = Extract<Request, { type: "dictionaryStatus" | "installDictionary" | "removeDictionary" | "cancelDictionaryInstall" }>;
type DictionaryReply = Extract<Response, { type: DictionaryRequest["type"] }> | { ok: false; error: string };
type DictionaryReplyFor<R extends DictionaryRequest> = Extract<Response, { type: R["type"] }> | { ok: false; error: string };
const dictionaryPort = ext.runtime.connect({ name: "shirabe-dictionary" });
const dictionaryReplies = new Map<number, { resolve: (response: DictionaryReply) => void; timer: number }>();
let dictionaryMessageId = 0;

dictionaryPort.onMessage.addListener((message: { id?: unknown; response?: DictionaryReply }) => {
  if (!Number.isInteger(message.id) || !message.response) return;
  const id = message.id as number;
  const pending = dictionaryReplies.get(id);
  if (!pending) return;
  window.clearTimeout(pending.timer);
  dictionaryReplies.delete(id);
  pending.resolve(message.response);
});

dictionaryPort.onDisconnect.addListener(() => {
  for (const { resolve, timer } of dictionaryReplies.values()) {
    window.clearTimeout(timer);
    resolve({ ok: false, error: "Firefox disconnected the dictionary background port." });
  }
  dictionaryReplies.clear();
});

function sendDictionary<R extends DictionaryRequest>(request: R): Promise<DictionaryReplyFor<R>> {
  const id = ++dictionaryMessageId;
  return new Promise((resolve) => {
    const timer = window.setTimeout(() => {
      dictionaryReplies.delete(id);
      resolve({ ok: false, error: `Dictionary background timed out while handling ${request.type}.` });
    }, request.type === "installDictionary" ? 10 * 60 * 1000 : 15_000);
    dictionaryReplies.set(id, { resolve: resolve as (response: DictionaryReply) => void, timer });
    dictionaryPort.postMessage({ id, request });
  });
}

let config: Config;
let rules: HostRule[] = [];
let siteUrl = ""; // the active tab's URL, for per-site controls

Promise.all([loadConfig(), loadHostRules(), activeTabUrl()]).then(([c, r, url]) => {
  config = c;
  rules = r;
  siteUrl = url;
  $<HTMLAnchorElement>("privacyLink").href = c.apiBase.replace(/\/$/, "") + "/privacy";
  $<HTMLAnchorElement>("licensesLink").href = ext.runtime.getURL("licenses.html");
  void renderHostControls();
  void renderPageState();
  // Opening the action is the user's activation gesture. Use its activeTab
  // grant to install the lightweight scanner on this page immediately; parsing
  // remains a separate opt-in action and is not required for hover lookup.
  void activateScannerOnActiveTab();
});

// ── Bottom navigation ────────────────────────────────────────────────────────
// Three panels behave as a tablist; Settings leaves for the options page, so it
// sits outside the tablist rather than pretending to be a fourth tab.
const tabs = [...document.querySelectorAll<HTMLButtonElement>(".tab[role='tab']")];

function selectTab(panel: string, { focus = false } = {}): void {
  for (const tab of tabs) {
    const selected = tab.dataset.panel === panel;
    tab.setAttribute("aria-selected", String(selected));
    tab.tabIndex = selected ? 0 : -1;
    $(`panel-${tab.dataset.panel}`).hidden = !selected;
    if (selected && focus) tab.focus();
  }
}

for (const tab of tabs) {
  tab.addEventListener("click", () => selectTab(tab.dataset.panel as string));
  tab.addEventListener("keydown", (event) => {
    const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    if (!step) return;
    event.preventDefault();
    const next = tabs[(tabs.indexOf(tab) + step + tabs.length) % tabs.length];
    selectTab(next.dataset.panel as string, { focus: true });
  });
}

$<HTMLButtonElement>("openSettings").addEventListener("click", async () => {
  if (ext.runtime.openOptionsPage) await ext.runtime.openOptionsPage();
  else await ext.tabs.create({ url: ext.runtime.getURL("options/options.html") });
  window.close();
});

async function activeTabUrl(): Promise<string> {
  const [tab] = await ext.tabs.query({ active: true, currentWindow: true });
  return tab?.url ?? "";
}

async function activateScannerOnActiveTab(): Promise<void> {
  if (!/^https?:/.test(siteUrl)) return;
  const [tab] = await ext.tabs.query({ active: true, currentWindow: true });
  if (tab?.id == null) return;
  try {
    // A harmless command doubles as a presence probe, avoiding duplicate
    // listeners when this popup is opened more than once on the same page.
    await ext.tabs.sendMessage(tab.id, { command: "activateScanner" });
  } catch {
    await ext.scripting.insertCSS({ target: { tabId: tab.id, allFrames: true }, files: ["content.css"] });
    await ext.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, files: ["content.js"] });
  }
}

async function patch(change: Partial<Config>): Promise<void> {
  config = { ...config, ...change };
  await saveConfig(config);
}

// ── Per-site parsing mode ────────────────────────────────────────────────────
// The select reflects the current page's effective mode; changing it edits the
// user's auto/off host lists for this domain. (A built-in auto site can't be
// forced back to Manual — only turned Off — which is fine for our reader sites.)
const siteRow = $<HTMLElement>("siteRow");
const siteMode = $<HTMLSelectElement>("siteMode");
const enableSiteAccess = $<HTMLButtonElement>("enableSiteAccess");

async function renderHostControls(): Promise<void> {
  const scope = siteScopeFor(siteUrl);
  if (!scope || !/^https?:/.test(siteUrl)) {
    siteRow.hidden = true;
    return;
  }
  siteRow.hidden = false;
  $<HTMLElement>("siteHost").textContent = new URL(siteUrl).hostname;
  const resolution = resolveHostMode(siteUrl, {
    autoHosts: config.autoParseHosts,
    disabledHosts: config.disabledHosts,
    rules,
  });
  siteMode.value = resolution.mode;
  enableSiteAccess.hidden = resolution.mode !== "auto" || await hasSiteAccess(siteUrl);
}

siteMode.addEventListener("change", async () => {
  // Drop any user pattern that currently applies to this page, then add the
  // scope to the chosen list (Manual = in neither list).
  const scope = siteScopeFor(siteUrl);
  const autoHosts = config.autoParseHosts.filter((p) => !matchUrl(normalizePattern(p), siteUrl));
  const disabledHosts = config.disabledHosts.filter((p) => !matchUrl(normalizePattern(p), siteUrl));
  if (siteMode.value === "auto" && !(await requestSiteAccess(siteUrl))) {
    status("Site access was not granted");
    siteMode.value = "manual";
    return;
  }
  if (siteMode.value === "auto") autoHosts.push(scope);
  else if (siteMode.value === "off") disabledHosts.push(scope);
  await patch({ autoParseHosts: autoHosts, disabledHosts });
  if (siteMode.value === "auto") await sendToActiveTab({ command: "parsePage" });
  await renderHostControls();
});

enableSiteAccess.addEventListener("click", async () => {
  if (!(await requestSiteAccess(siteUrl))) {
    status("Site access was not granted");
    return;
  }
  const scope = siteScopeFor(siteUrl);
  const autoHosts = config.autoParseHosts.filter((pattern) => !matchUrl(normalizePattern(pattern), siteUrl));
  autoHosts.push(scope);
  const disabledHosts = config.disabledHosts.filter((pattern) => !matchUrl(normalizePattern(pattern), siteUrl));
  await patch({ autoParseHosts: autoHosts, disabledHosts });
  await sendToActiveTab({ command: "parsePage" });
  await renderHostControls();
});

async function hasSiteAccess(url: string): Promise<boolean> {
  if (!/^https?:/.test(url)) return false;
  return ext.permissions.contains({ origins: [`${new URL(url).origin}/*`] });
}

async function requestSiteAccess(url: string): Promise<boolean> {
  if (!/^https?:/.test(url)) return false;
  const origin = `${new URL(url).origin}/*`;
  if (await ext.permissions.contains({ origins: [origin] })) return true;
  return ext.permissions.request({ origins: [origin] });
}

async function sendToActiveTab(message: unknown): Promise<void> {
  const [tab] = await ext.tabs.query({ active: true, currentWindow: true });
  if (tab?.id == null) return;
  try {
    await ext.tabs.sendMessage(tab.id, message);
  } catch {
    await ext.scripting.insertCSS({ target: { tabId: tab.id }, files: ["content.css"] });
    await ext.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] });
    await ext.tabs.sendMessage(tab.id, message);
  }
}

// ── Connection card ──────────────────────────────────────────────────────────
const card = $<HTMLElement>("account");
const pane = (state: string) => card.querySelector<HTMLElement>(`[data-state="${state}"]`) as HTMLElement;

const STATES = ["connected", "connecting", "unentitled", "disconnected"] as const;
type Pane = (typeof STATES)[number];

function showPane(state: Pane): void {
  card.hidden = false;
  for (const s of STATES) pane(s).hidden = s !== state;
}

async function refresh(): Promise<void> {
  const res = await send({ type: "status" });
  if (!res.ok) return;
  const { connected, account, entitled, connecting, apiBase } = res.status;
  const named = account ? ` as ${account}` : "";
  if (connected && entitled) {
    showPane("connected");
    $<HTMLElement>("accountName").textContent = named;
    void refreshDecks();
  } else if (connected) {
    showPane("unentitled");
    $<HTMLElement>("unentitledName").textContent = named;
    $<HTMLAnchorElement>("upgradeLink").href = apiBase.replace(/\/$/, "") + "/pricing";
  } else if (connecting) {
    showPane("connecting");
  } else {
    showPane("disconnected");
  }
}

async function refreshDecks(): Promise<void> {
  const select = $<HTMLSelectElement>("preferredDeck");
  const res = await send({ type: "decks" });
  if (!res.ok) {
    $<HTMLElement>("deckRow").hidden = true;
    return;
  }
  $<HTMLElement>("deckRow").hidden = false;
  select.replaceChildren(new Option("Default deck", ""));
  for (const deck of res.decks) select.add(new Option(deck.name, String(deck.id)));
  select.value = config.preferredDeckId == null ? "" : String(config.preferredDeckId);
  if (select.value === "" && config.preferredDeckId != null) await patch({ preferredDeckId: null });
}

$<HTMLSelectElement>("preferredDeck").addEventListener("change", (event) => {
  const value = (event.currentTarget as HTMLSelectElement).value;
  void patch({ preferredDeckId: value ? Number(value) : null });
});

$<HTMLButtonElement>("connect").addEventListener("click", async () => {
  showPane("connecting");
  const res = await send({ type: "connect" });
  if (!res.ok) {
    status(res.error);
    showPane("disconnected");
    return;
  }
  refresh();
});

// Both the connected and unentitled panes carry a Disconnect button.
for (const button of document.querySelectorAll<HTMLButtonElement>(".disconnect")) {
  button.addEventListener("click", async () => {
    await send({ type: "disconnect" });
    refresh();
  });
}

refresh();

// ── Offline dictionary ───────────────────────────────────────────────────────
const dictionaryCard = $<HTMLElement>("dictionary");
const dictionaryPane = (state: string) => dictionaryCard.querySelector<HTMLElement>(`[data-dictionary-state="${state}"]`) as HTMLElement;
const DICTIONARY_STATES = ["missing", "installing", "installed", "error"] as const;
let dictionaryPoll: number | undefined;

function showDictionaryPane(state: (typeof DICTIONARY_STATES)[number]): void {
  for (const name of DICTIONARY_STATES) dictionaryPane(name).hidden = name !== state;
}

async function refreshDictionary(): Promise<void> {
  const res = await sendDictionary({ type: "dictionaryStatus" });
  if (!res.ok) {
    showDictionaryPane("error");
    $<HTMLElement>("dictionaryError").textContent = res.error;
    await diagnoseDictionary(res.error);
    return;
  }
  const dict = res.dictionary;
  if (dict.installing) {
    showDictionaryPane("installing");
    $<HTMLProgressElement>("dictionaryProgress").value = dict.progress;
    $<HTMLElement>("dictionaryProgressLabel").textContent = dict.stage
      ? `${dict.stage}${dict.progress > 0 ? ` · ${Math.round(dict.progress * 100)}%` : ""}`
      : `Installing… ${Math.round(dict.progress * 100)}%`;
    window.clearTimeout(dictionaryPoll);
    dictionaryPoll = window.setTimeout(refreshDictionary, 350);
  } else if (dict.error) {
    showDictionaryPane("error");
    $<HTMLElement>("dictionaryError").textContent = dict.error;
    await diagnoseDictionary(dict.error);
  } else if (dict.installed) {
    showDictionaryPane("installed");
    const size = dict.bytes ? `${(dict.bytes / 1024 / 1024).toFixed(1)} MB download` : "installed";
    $<HTMLElement>("dictionaryVersion").textContent = `${dict.terms.toLocaleString()} terms · ${dict.kanji.toLocaleString()} kanji · ${size} · ${dict.revision ?? "unknown version"}`;
    const credits = $<HTMLUListElement>("dictionaryCredits");
    credits.replaceChildren(...dict.sources.map((source) => {
      const item = document.createElement("li");
      const link = document.createElement("a");
      link.href = source.licenseUrl || source.url;
      link.target = "_blank";
      link.rel = "noopener";
      link.textContent = `${source.name} — ${source.license}`;
      item.append(link);
      return item;
    }));
  } else {
    showDictionaryPane("missing");
  }
}

async function install({ update = false } = {}): Promise<void> {
  const previousRevision = update ? await installedRevision() : null;
  showDictionaryPane("installing");
  $<HTMLProgressElement>("dictionaryProgress").value = 0;
  $<HTMLElement>("dictionaryError").textContent = "";
  $<HTMLElement>("dictionaryDiagnostics").textContent = "";
  const preflight = await dictionaryPreflight();
  if (!preflight.ok) {
    showDictionaryPane("error");
    $<HTMLElement>("dictionaryError").textContent = "Dictionary preflight failed";
    $<HTMLElement>("dictionaryDiagnostics").textContent = preflight.diagnostics;
    return;
  }
  const pending = sendDictionary({ type: "installDictionary" });
  void refreshDictionary();
  const res = await pending;
  if (!res.ok) {
    if (/abort|cancel/i.test(res.error)) await refreshDictionary();
    else {
      // Firefox can reject a message channel with a generic error after the
      // background installer has already recorded the useful failure. Prefer
      // that durable status over overwriting it with the transport message.
      await refreshDictionary();
      if (!$<HTMLElement>("dictionaryError").textContent) {
        showDictionaryPane("error");
        $<HTMLElement>("dictionaryError").textContent = res.error;
      }
      await diagnoseDictionary(res.error);
    }
  } else {
    // Checking for an update that finds none reinstalls nothing, so say so
    // rather than claiming a fresh install happened.
    const revision = await installedRevision();
    status(!update ? "Offline dictionary installed"
      : revision === previousRevision ? "Dictionary is already up to date"
      : "Dictionary updated");
    await refreshDictionary();
    await renderPageState();
  }
}

async function installedRevision(): Promise<string | null> {
  const res = await sendDictionary({ type: "dictionaryStatus" });
  return res.ok ? res.dictionary.revision ?? null : null;
}

async function dictionaryPreflight(): Promise<{ ok: boolean; diagnostics: string }> {
  const apiBase = (config?.apiBase || DEFAULTS.apiBase).replace(/\/$/, "");
  const lines = ["build: 0.1.0-dev-storage-isolation", `api: ${apiBase}`];
  lines.push(`indexedDB: ${typeof indexedDB === "undefined" ? "missing" : "available"}`);
  lines.push(`gzip: ${typeof DecompressionStream === "undefined" ? "missing" : "available"}`);
  try {
    const response = await fetch(`${apiBase}/v1/dictionary-packs/current`, { cache: "no-store" });
    lines.push(`manifest: HTTP ${response.status}`);
    if (!response.ok) {
      lines.push(`response: ${(await response.text()).slice(0, 240)}`);
      return { ok: false, diagnostics: lines.join("\n") };
    }
    const manifest = await response.json() as { contentRevision?: unknown; downloadUrl?: unknown };
    lines.push(`revision: ${String(manifest.contentRevision ?? "missing")}`);
    lines.push(`download: ${typeof manifest.downloadUrl === "string" ? new URL(manifest.downloadUrl).host : "missing"}`);
    return { ok: true, diagnostics: lines.join("\n") };
  } catch (error) {
    lines.push(`manifest error: ${diagnosticError(error)}`);
    return { ok: false, diagnostics: lines.join("\n") };
  }
}

async function diagnoseDictionary(transportError: string): Promise<void> {
  const preflight = await dictionaryPreflight();
  const background = await sendDictionary({ type: "dictionaryStatus" });
  const backgroundLine = background.ok
    ? `background: reachable (${background.dictionary.stage ?? background.dictionary.error ?? "idle"})`
    : `background: ${background.error}`;
  $<HTMLElement>("dictionaryDiagnostics").textContent = [
    preflight.diagnostics,
    backgroundLine,
    `transport: ${transportError}`,
  ].join("\n");
}

function diagnosticError(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

$<HTMLButtonElement>("installDictionary").addEventListener("click", () => void install());
$<HTMLButtonElement>("retryDictionary").addEventListener("click", () => void install());
$<HTMLButtonElement>("updateDictionary").addEventListener("click", () => void install({ update: true }));
$<HTMLButtonElement>("removeDictionary").addEventListener("click", async () => {
  const res = await sendDictionary({ type: "removeDictionary" });
  if (!res.ok) status(res.error);
  await refreshDictionary();
});
$<HTMLButtonElement>("cancelDictionaryInstall").addEventListener("click", async () => {
  await sendDictionary({ type: "cancelDictionaryInstall" });
  status("Installation cancelled; the previous dictionary is still active");
  await refreshDictionary();
});
void refreshDictionary();

// ── What you can read of this page ───────────────────────────────────────────
// The popup's headline answer. Three states, in priority order, because each one
// makes the next meaningless: without a dictionary nothing parses; without an
// account every word is stateless, so coverage would read 0% and look broken
// rather than unearned; otherwise, show the real number.
const BANDS = [
  { key: "known", label: "known", color: "var(--state-known)" },
  { key: "due", label: "due", color: "var(--state-due)" },
  { key: "learning", label: "learning", color: "var(--state-learning)" },
  { key: "unknown", label: "unknown", color: "var(--state-unknown)" },
] as const;

async function renderPageState(): Promise<void> {
  const installed = (await sendDictionary({ type: "dictionaryStatus" }));
  const hasDictionary = installed.ok && installed.dictionary.installed;
  const connected = config?.apiKey ? true : false;

  $("needsDictionary").hidden = hasDictionary;
  $("signInBanner").hidden = !hasDictionary || connected;
  $<HTMLButtonElement>("parse").disabled = !hasDictionary;

  const coverage = $("coverage");
  if (!hasDictionary || !connected) {
    coverage.hidden = true;
    return;
  }

  const response = await send({ type: "activePageMetrics" });
  const metrics = response.ok ? response.metrics : null;
  if (!metrics?.total) {
    coverage.hidden = true;
    return;
  }

  coverage.hidden = false;
  // Occurrence coverage, not unique: it answers "how much of the text in front
  // of me can I read", which is what a reader feels. Uniques are the study view.
  $("coverageValue").textContent = `${metrics.occurrenceCoverage}%`;
  $("coverageDetail").textContent = `of ${metrics.total.toLocaleString()} words · ${metrics.uniqueCoverage}% of ${metrics.unique.toLocaleString()} unique`;

  const bar = $("coverageBar");
  for (const band of BANDS) {
    const share = metrics.total ? (metrics.occurrences[band.key] / metrics.total) * 100 : 0;
    const segment = bar.querySelector<HTMLElement>(`[data-band="${band.key}"]`);
    if (segment) segment.style.width = `${share}%`;
  }
  $<HTMLUListElement>("coverageLegend").replaceChildren(...BANDS.filter((band) => metrics.occurrences[band.key]).map((band) => {
    const item = document.createElement("li");
    const swatch = document.createElement("span");
    swatch.className = "legend-dot";
    swatch.style.background = band.color;
    item.append(swatch, document.createTextNode(`${metrics.occurrences[band.key].toLocaleString()} ${band.label}`));
    return item;
  }));
}

$<HTMLButtonElement>("goInstallDictionary").addEventListener("click", () => selectTab("dictionary"));
$<HTMLButtonElement>("bannerConnect").addEventListener("click", () => {
  selectTab("dictionary");
  $<HTMLButtonElement>("connect").click();
});

// ── Parse this page ──────────────────────────────────────────────────────────
$<HTMLButtonElement>("parse").addEventListener("click", async () => {
  await sendToActiveTab({ command: "parsePage" });
  window.close();
});

for (const [id, source] of [["readArticle", "article"], ["readSelection", "selection"], ["openPasteReader", "blank"]] as const) {
  $<HTMLButtonElement>(id).addEventListener("click", async () => {
    const res = await send({ type: "openReader", source });
    if (!res.ok) status(res.error);
    else window.close();
  });
}

function status(text: string): void {
  const el = $<HTMLParagraphElement>("status");
  el.textContent = text;
  window.setTimeout(() => (el.textContent = ""), 2500);
}
