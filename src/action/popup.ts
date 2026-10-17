import { ext } from "../common/browser.js";
import { DEFAULTS, isConnected, loadConfig, onConfigChanged, saveConfig, type Config, type FuriganaMode, type ScanModifier } from "../common/config.js";
import { GLOSS_LABELS, glossLanguagesFrom } from "@shirabe-org/card/word-card/languages";
import { mountAccountPanel } from "../common/account-panel.js";
import { mountDictionaryPanel } from "../common/dictionary-panel.js";
import { sendDictionary } from "../common/dictionary-port.js";
import { loadHostRules, matchUrl, normalizePattern, resolveHostMode, siteScopeFor, type HostRule } from "../common/host-rules.js";
import { send } from "../common/messages.js";
import { installClientReporter } from "../common/client-reporter.js";
import { installDevelopmentBuildStamp } from "../common/development-build.js";

installClientReporter("popup");

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
installDevelopmentBuildStamp($("devBuild"), (path) => ext.runtime.getURL(path));

let config: Config;
let rules: HostRule[] = [];
let siteUrl = ""; // the active tab's URL, for per-site controls

Promise.all([loadConfig(), loadHostRules(), activeTabUrl()]).then(([c, r, url]) => {
  config = c;
  rules = r;
  siteUrl = url;
  renderDictionaryStack(c);
  $<HTMLSelectElement>("lookupScanModifier").value = c.scanModifier;
  $<HTMLSelectElement>("lookupFuriganaMode").value = c.furiganaMode;
  $<HTMLSelectElement>("lookupHighlighting").value = c.highlighting ? "on" : "off";
  void renderHostControls();
  void renderPageState();
  // Opening the action is the user's activation gesture. Use its activeTab
  // grant to install the lightweight scanner on this page immediately; parsing
  // remains a separate opt-in action and is not required for hover lookup.
  void activateScannerOnActiveTab().then(renderPagePause);
});

onConfigChanged((next) => {
  config = next;
  renderDictionaryStack(next);
  $<HTMLSelectElement>("lookupScanModifier").value = next.scanModifier;
  $<HTMLSelectElement>("lookupFuriganaMode").value = next.furiganaMode;
  $<HTMLSelectElement>("lookupHighlighting").value = next.highlighting ? "on" : "off";
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

async function renderDictionaryStack(current: Config): Promise<void> {
  const response = await sendDictionary({ type: "dictionaryStatus" });
  if (response.ok && !response.dictionary.installed) {
    $<HTMLElement>("dictionaryStackSummary").textContent = "Install the dictionary to choose sources";
    return;
  }
  let stack = current.dictionaryStack;
  if (!stack.length && response.ok) stack = response.dictionary.activeSources;
  const groups = [...new Set(stack.map((source) => source.split(":", 1)[0]))];
  $<HTMLElement>("dictionaryStackSummary").textContent = groups.length
    ? groups.map((slug) => {
      const languages = stack.filter((source) => source.startsWith(`${slug}:`)).map((source) => source.split(":")[1]!);
      const labels = languages.map((language) => {
        const code = language in GLOSS_LABELS ? language as keyof typeof GLOSS_LABELS : glossLanguagesFrom([language])[0];
        return code ? GLOSS_LABELS[code] : language;
      });
      return `${current.dictionaryNames[slug] ?? slug}: ${labels.join(" → ")}`;
    }).join(" · ")
    : "Install the dictionary to choose sources";
}

$<HTMLButtonElement>("editDictionaryStack").addEventListener("click", async () => {
  await ext.tabs.create({ url: ext.runtime.getURL("options/options.html#dictionary") });
  window.close();
});

$<HTMLSelectElement>("lookupScanModifier").addEventListener("change", async (event) => {
  const scanModifier = (event.currentTarget as HTMLSelectElement).value as ScanModifier;
  await patch({ scanModifier });
  status("Popup trigger saved");
});

$<HTMLSelectElement>("lookupHighlighting").addEventListener("change", async (event) => {
  const highlighting = (event.currentTarget as HTMLSelectElement).value === "on";
  await patch({ highlighting });
  status(highlighting ? "Highlighting on" : "Highlighting off");
});

$<HTMLSelectElement>("lookupFuriganaMode").addEventListener("change", async (event) => {
  const furiganaMode = (event.currentTarget as HTMLSelectElement).value as FuriganaMode;
  await patch({ furiganaMode });
  status("Furigana setting saved");
});

// ── Per-site reader on/off ───────────────────────────────────────────────────
const readerToggle = $<HTMLButtonElement>("readerToggle");
const pagePause = $<HTMLButtonElement>("pagePause");

async function renderPagePause(): Promise<void> {
  if (!/^https?:/.test(siteUrl)) return;
  const [tab] = await ext.tabs.query({ active: true, currentWindow: true });
  if (tab?.id == null) return;
  try {
    const state = await ext.tabs.sendMessage(tab.id, { command: "pagePauseState" }) as { paused?: boolean };
    pagePause.hidden = false;
    pagePause.textContent = state?.paused ? "Resume this page" : "Pause on this page";
  } catch {
    pagePause.hidden = true;
  }
}

pagePause.addEventListener("click", async () => {
  const [tab] = await ext.tabs.query({ active: true, currentWindow: true });
  if (tab?.id == null) return;
  try {
    const state = await ext.tabs.sendMessage(tab.id, { command: "togglePagePause" }) as { paused?: boolean };
    pagePause.textContent = state?.paused ? "Resume this page" : "Pause on this page";
  } catch {
    pagePause.hidden = true;
  }
});

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
    apiBase: config.apiBase,
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
    disabledHosts.push(scope);
    await patch({ disabledHosts });
  } else {
    await patch({ disabledHosts });
  }
  await renderHostControls();
  void activateScannerOnActiveTab();
});

// ── Connection card ──────────────────────────────────────────────────────────
// Shared with the options page (common/account-panel.ts).
const { refresh } = mountAccountPanel({
  cardId: "account",
  pricingSource: "extension_popup",
  config: () => config,
  patch,
  status,
  onChanged: () => renderPageState(),
});
refresh();

// ── Offline dictionary ───────────────────────────────────────────────────────
// Shared with the options page (common/dictionary-panel.ts); the popup adds the
// header dot and re-reads the page once a pack lands.
const dictionaryPanel = mountDictionaryPanel({
  apiBase: () => config?.apiBase || DEFAULTS.apiBase,
  status,
  onBusy: (busy) => {
    const dot = document.getElementById("dictionaryDot");
    if (dot) dot.hidden = !busy;
  },
  onInstalled: () => { void renderDictionaryStack(config); return renderPageState(); },
  onRemoved: () => { void renderDictionaryStack(config); return renderPageState(); },
});
const refreshDictionary = dictionaryPanel.refresh;
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
  const connected = config ? isConnected(config) : false;

  // While an install is running, don't re-offer Install: show a progress entry.
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
