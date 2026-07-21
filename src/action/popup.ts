import { ext } from "../common/browser.js";
import { DEFAULTS, loadConfig, onConfigChanged, saveConfig, type Config, type FuriganaMode, type GlossLanguage, type ScanModifier } from "../common/config.js";
import { sendDictionary } from "../common/dictionary-port.js";
import { loadHostRules, matchUrl, normalizePattern, resolveHostMode, siteScopeFor, type HostRule } from "../common/host-rules.js";
import { send } from "../common/messages.js";
import { installClientReporter } from "../common/client-reporter.js";

installClientReporter("popup");

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

let config: Config;
let rules: HostRule[] = [];
let siteUrl = ""; // the active tab's URL, for per-site controls

Promise.all([loadConfig(), loadHostRules(), activeTabUrl()]).then(([c, r, url]) => {
  config = c;
  rules = r;
  siteUrl = url;
  $<HTMLAnchorElement>("licensesLink").href = ext.runtime.getURL("licenses.html");
  $<HTMLSelectElement>("dictionaryLanguages").value = c.languages.join(",");
  $<HTMLSelectElement>("lookupScanModifier").value = c.scanModifier;
  $<HTMLSelectElement>("lookupFuriganaMode").value = c.furiganaMode;
  void renderHostControls();
  void renderPageState();
  // Opening the action is the user's activation gesture. Use its activeTab
  // grant to install the lightweight scanner on this page immediately; parsing
  // remains a separate opt-in action and is not required for hover lookup.
  void activateScannerOnActiveTab();
});

onConfigChanged((next) => {
  config = next;
  $<HTMLSelectElement>("dictionaryLanguages").value = next.languages.join(",");
  $<HTMLSelectElement>("lookupScanModifier").value = next.scanModifier;
  $<HTMLSelectElement>("lookupFuriganaMode").value = next.furiganaMode;
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

$<HTMLSelectElement>("dictionaryLanguages").addEventListener("change", async (event) => {
  const select = event.currentTarget as HTMLSelectElement;
  const languages = select.value.split(",") as GlossLanguage[];
  if (config.apiKey) {
    const response = await send({ type: "updateLanguages", languages });
    if (!response.ok) {
      select.value = config.languages.join(",");
      status(response.error);
      return;
    }
  } else {
    await patch({ languages });
  }
  status(config.apiKey ? "Language synced with your profile" : "Definition language saved");
});

$<HTMLSelectElement>("lookupScanModifier").addEventListener("change", async (event) => {
  const scanModifier = (event.currentTarget as HTMLSelectElement).value as ScanModifier;
  await patch({ scanModifier });
  status("Popup trigger saved");
});

$<HTMLSelectElement>("lookupFuriganaMode").addEventListener("change", async (event) => {
  const furiganaMode = (event.currentTarget as HTMLSelectElement).value as FuriganaMode;
  await patch({ furiganaMode, showFurigana: furiganaMode !== "off" });
  status("Furigana setting saved");
});

// ── Per-site reader on/off ───────────────────────────────────────────────────
// Reader-on means Yomitan-style scanning (and dedicated adapters) on this host.
// Full-page parse stays opt-in via hotkey / context menu — there is no separate
// "parse automatically" control. Turning the reader on requests optional host
// access so the scanner survives reloads without reopening the popup.
const readerToggle = $<HTMLButtonElement>("readerToggle");

async function renderHostControls(): Promise<void> {
  const scope = siteScopeFor(siteUrl);
  if (!scope || !/^https?:/.test(siteUrl)) {
    readerToggle.hidden = true;
    return;
  }
  readerToggle.hidden = false;
  const host = new URL(siteUrl).hostname;
  $<HTMLElement>("readerToggleHost").textContent = host;
  const resolution = resolveHostMode(siteUrl, {
    disabledHosts: config.disabledHosts,
    rules,
  });
  const readerOn = resolution.mode !== "off";
  readerToggle.setAttribute("aria-pressed", String(readerOn));
  readerToggle.setAttribute("aria-label", `Turn reader ${readerOn ? "off" : "on"} for ${host}`);
  $<HTMLElement>("readerToggleLabel").textContent = `Reader is ${readerOn ? "on" : "off"}`;
}

readerToggle.addEventListener("click", async () => {
  const scope = siteScopeFor(siteUrl);
  if (!scope) return;
  const readerOn = readerToggle.getAttribute("aria-pressed") === "true";
  const disabledHosts = config.disabledHosts.filter((pattern) => !matchUrl(normalizePattern(pattern), siteUrl));

  if (readerOn) {
    // Turning off: suspend scanning on this site. Optional host permission stays
    // granted so re-enabling does not re-prompt the browser.
    disabledHosts.push(scope);
    await patch({ disabledHosts });
  } else {
    const enabledHosts = config.enabledHosts.filter((pattern) => !matchUrl(normalizePattern(pattern), siteUrl));
    const siteAccess = await requestSiteAccess(siteUrl);
    if (!siteAccess) {
      status("Site access was not granted; scanning still works in this tab while open");
    } else {
      enabledHosts.push(scope);
    }
    await patch({ disabledHosts, enabledHosts });
  }
  await renderHostControls();
  void activateScannerOnActiveTab();
});

async function requestSiteAccess(url: string): Promise<boolean> {
  if (!/^https?:/.test(url)) return false;
  const origin = `${new URL(url).origin}/*`;
  if (await ext.permissions.contains({ origins: [origin] })) return true;
  return ext.permissions.request({ origins: [origin] });
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
    setDictionaryDot(false);
    $<HTMLElement>("dictionaryError").textContent = res.error;
    await diagnoseDictionary(res.error);
    return;
  }
  const dict = res.dictionary;
  if (dict.installing) {
    showDictionaryPane("installing");
    setDictionaryDot(true);
    $<HTMLProgressElement>("dictionaryProgress").value = dict.progress;
    $<HTMLElement>("dictionaryProgressLabel").textContent = dict.stage
      ? `${dict.stage}${dict.progress > 0 ? ` · ${Math.round(dict.progress * 100)}%` : ""}`
      : `Installing… ${Math.round(dict.progress * 100)}%`;
    window.clearTimeout(dictionaryPoll);
    dictionaryPoll = window.setTimeout(() => void refreshDictionary(), 350);
  } else if (dict.error) {
    showDictionaryPane("error");
    setDictionaryDot(false);
    $<HTMLElement>("dictionaryError").textContent = dict.error;
    await diagnoseDictionary(dict.error);
  } else if (dict.installed) {
    showDictionaryPane("installed");
    setDictionaryDot(false);
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
    setDictionaryDot(false);
  }
}

function setDictionaryDot(active: boolean): void {
  const dot = document.getElementById("dictionaryDot");
  if (dot) dot.hidden = !active;
}

async function install({ update = false } = {}): Promise<void> {
  const previousRevision = update ? await installedRevision() : null;
  showDictionaryPane("installing");
  setDictionaryDot(true);
  $<HTMLProgressElement>("dictionaryProgress").value = 0;
  $<HTMLElement>("dictionaryError").textContent = "";
  $<HTMLElement>("dictionaryDiagnostics").textContent = "";
  const preflight = await dictionaryPreflight();
  if (!preflight.ok) {
    showDictionaryPane("error");
    setDictionaryDot(false);
    $<HTMLElement>("dictionaryError").textContent = "Dictionary preflight failed";
    $<HTMLElement>("dictionaryDiagnostics").textContent = preflight.diagnostics;
    return;
  }
  const res = await sendDictionary({ type: "installDictionary" });
  // Start progress polling immediately (also covers reopen while install runs).
  void refreshDictionary();
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
    return;
  }

  // Long installs acknowledge immediately; wait for status to leave "installing".
  await waitForDictionaryInstall();
  const finalStatus = await sendDictionary({ type: "dictionaryStatus" });
  if (finalStatus.ok && finalStatus.dictionary.error) {
    showDictionaryPane("error");
    $<HTMLElement>("dictionaryError").textContent = finalStatus.dictionary.error;
    await diagnoseDictionary(finalStatus.dictionary.error);
    return;
  }
  const revision = await installedRevision();
  status(!update ? "Offline dictionary installed"
    : revision === previousRevision ? "Dictionary is already up to date"
    : "Dictionary updated");
  await refreshDictionary();
  await renderPageState();
}

/** Poll until the background reports the install finished, failed, or cancelled. */
async function waitForDictionaryInstall(): Promise<void> {
  for (let attempt = 0; attempt < 1_200; attempt += 1) { // ~10 min at 500ms
    const res = await sendDictionary({ type: "dictionaryStatus" });
    if (!res.ok) return;
    if (!res.dictionary.installing) return;
    await refreshDictionary();
    await new Promise((resolve) => window.setTimeout(resolve, 500));
  }
}

async function installedRevision(): Promise<string | null> {
  const res = await sendDictionary({ type: "dictionaryStatus" });
  return res.ok ? res.dictionary.revision ?? null : null;
}

async function dictionaryPreflight(): Promise<{ ok: boolean; diagnostics: string }> {
  const apiBase = (config?.apiBase || DEFAULTS.apiBase).replace(/\/$/, "");
  const lines = ["build: 0.2.0-contextual-search", `api: ${apiBase}`];
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
  const installing = installed.ok && installed.dictionary.installing;
  const connected = config?.apiKey ? true : false;

  // While an install is running, don't re-offer Install — show a progress entry.
  $("needsDictionary").hidden = hasDictionary || installing;
  $("dictionaryInstallingBanner").hidden = !installing;
  $("signInBanner").hidden = !hasDictionary || connected || installing;
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
  $("iPlusOne").hidden = !metrics.iPlusOne;
  $("iPlusOneLabel").textContent = `${metrics.iPlusOne.toLocaleString()} ${metrics.iPlusOne === 1 ? "sentence" : "sentences"} with one new word`;

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
$<HTMLButtonElement>("goDictionaryProgress").addEventListener("click", () => selectTab("dictionary"));
$<HTMLButtonElement>("bannerConnect").addEventListener("click", () => {
  selectTab("account");
  $<HTMLButtonElement>("connect").click();
});

function status(text: string): void {
  const el = $<HTMLParagraphElement>("status");
  el.textContent = text;
  window.setTimeout(() => (el.textContent = ""), 2500);
}
