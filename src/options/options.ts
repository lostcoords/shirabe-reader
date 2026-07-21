import { ext } from "../common/browser.js";
import { DEFAULTS, loadConfig, onConfigChanged, saveConfig, type Config, type FuriganaMode, type GlossLanguage, type ScanModifier, type StatePreset } from "../common/config.js";
import { sendDictionary } from "../common/dictionary-port.js";
import { formatKeybind, KEYBIND_ACTIONS, KEYBIND_LABELS, keybindFromEvent, type Keybind, type KeybindAction } from "../common/keybind.js";
import { send } from "../common/messages.js";
import { installClientReporter } from "../common/client-reporter.js";

installClientReporter("options");

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

// ── Section nav ──────────────────────────────────────────────────────────────
const SECTION_IDS = ["reading", "dictionary", "account", "keyboard"] as const;
const settingsLinks = [...document.querySelectorAll<HTMLAnchorElement>(".settings-nav a")];
function selectSettingsSection(id: string): void {
  for (const link of settingsLinks) link.setAttribute("aria-current", String(link.hash === `#${id}`));
}
for (const link of settingsLinks) link.addEventListener("click", () => selectSettingsSection(link.hash.slice(1)));

const sectionObserver = new IntersectionObserver((entries) => {
  const visible = entries.find((entry) => entry.isIntersecting);
  if (visible?.target.id) selectSettingsSection(visible.target.id);
}, { rootMargin: "-15% 0px -70%", threshold: 0 });
for (const id of SECTION_IDS) sectionObserver.observe($(id));

// ── Reading preferences ──────────────────────────────────────────────────────
const prefs = {
  furiganaMode: $<HTMLSelectElement>("furiganaMode"),
  scanModifier: $<HTMLSelectElement>("scanModifier"),
  languages: $<HTMLSelectElement>("languages"),
  statePreset: $<HTMLSelectElement>("statePreset"),
  iPlusOneIncludesLearning: $<HTMLInputElement>("iPlusOneIncludesLearning"),
  iPlusOneFrequencyMax: $<HTMLInputElement>("iPlusOneFrequencyMax"),
};

let config: Config;

loadConfig().then((loaded) => {
  config = loaded;
  prefs.furiganaMode.value = config.furiganaMode;
  prefs.scanModifier.value = config.scanModifier;
  prefs.languages.value = config.languages.join(",");
  prefs.statePreset.value = config.statePreset;
  prefs.iPlusOneIncludesLearning.checked = config.iPlusOneIncludesLearning;
  prefs.iPlusOneFrequencyMax.value = String(config.iPlusOneFrequencyMax);
  const base = config.apiBase.replace(/\/$/, "");
  $<HTMLAnchorElement>("settingsLink").href = `${base}/settings`;
  $<HTMLAnchorElement>("privacyLink").href = `${base}/privacy`;
  $<HTMLAnchorElement>("licensesLink").href = ext.runtime.getURL("licenses.html");
  $<HTMLAnchorElement>("dictionaryLicensesLink").href = ext.runtime.getURL("licenses.html");
  renderKeybinds();
  void refreshDictionary();
  void refreshAccount();
});

onConfigChanged((next) => {
  config = next;
  prefs.languages.value = next.languages.join(",");
});

async function patch(change: Partial<Config>): Promise<void> {
  config = { ...config, ...change };
  await saveConfig(config);
}

$<HTMLFormElement>("prefs").addEventListener("change", async (event) => {
  const languages = prefs.languages.value.split(",") as GlossLanguage[];
  if (event.target === prefs.languages && config.apiKey) {
    const response = await send({ type: "updateLanguages", languages });
    if (!response.ok) {
      prefs.languages.value = config.languages.join(",");
      status(response.error);
      return;
    }
  }
  await patch({
    furiganaMode: prefs.furiganaMode.value as FuriganaMode,
    showFurigana: prefs.furiganaMode.value !== "off",
    scanModifier: prefs.scanModifier.value as ScanModifier,
    languages,
    statePreset: prefs.statePreset.value as StatePreset,
    iPlusOneIncludesLearning: prefs.iPlusOneIncludesLearning.checked,
    iPlusOneFrequencyMax: Math.max(1, Number(prefs.iPlusOneFrequencyMax.value) || DEFAULTS.iPlusOneFrequencyMax),
  });
  status(event.target === prefs.languages && config.apiKey ? "Synced with your profile" : "Saved");
});

// ── Account ──────────────────────────────────────────────────────────────────
const accountPanel = $<HTMLElement>("accountPanel");
const accountPane = (state: string) => accountPanel.querySelector<HTMLElement>(`[data-state="${state}"]`) as HTMLElement;
const ACCOUNT_STATES = ["connected", "connecting", "unentitled", "disconnected"] as const;

function showAccountPane(state: (typeof ACCOUNT_STATES)[number]): void {
  for (const name of ACCOUNT_STATES) accountPane(name).hidden = name !== state;
}

async function refreshAccount(): Promise<void> {
  const res = await send({ type: "status" });
  if (!res.ok) return;
  const { connected, account, entitled, connecting, apiBase } = res.status;
  const named = account ? ` as ${account}` : "";
  if (connected && entitled) {
    showAccountPane("connected");
    $<HTMLElement>("accountName").textContent = named;
    void refreshDecks();
  } else if (connected) {
    showAccountPane("unentitled");
    $<HTMLElement>("unentitledName").textContent = named;
    $<HTMLAnchorElement>("upgradeLink").href = apiBase.replace(/\/$/, "") + "/pricing";
  } else if (connecting) {
    showAccountPane("connecting");
  } else {
    showAccountPane("disconnected");
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
  status("Default deck saved");
});

$<HTMLButtonElement>("connect").addEventListener("click", async () => {
  showAccountPane("connecting");
  const res = await send({ type: "connect" });
  if (!res.ok) {
    status(res.error);
    showAccountPane("disconnected");
    return;
  }
  void refreshAccount();
});

for (const button of document.querySelectorAll<HTMLButtonElement>(".disconnect")) {
  button.addEventListener("click", async () => {
    await send({ type: "disconnect" });
    void refreshAccount();
  });
}

// ── Offline dictionary ───────────────────────────────────────────────────────
const dictionaryPanel = $<HTMLElement>("dictionaryPanel");
const dictionaryPane = (state: string) => dictionaryPanel.querySelector<HTMLElement>(`[data-dictionary-state="${state}"]`) as HTMLElement;
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
    dictionaryPoll = window.setTimeout(() => void refreshDictionary(), 350);
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
  const res = await sendDictionary({ type: "installDictionary" });
  void refreshDictionary();
  if (!res.ok) {
    if (!/abort|cancel/i.test(res.error)) {
      await refreshDictionary();
      if (!$<HTMLElement>("dictionaryError").textContent) {
        showDictionaryPane("error");
        $<HTMLElement>("dictionaryError").textContent = res.error;
      }
      await diagnoseDictionary(res.error);
    } else {
      await refreshDictionary();
    }
    return;
  }

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
}

async function waitForDictionaryInstall(): Promise<void> {
  for (let attempt = 0; attempt < 1_200; attempt += 1) {
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
    lines.push(`manifest error: ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`);
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

$<HTMLButtonElement>("installDictionary").addEventListener("click", () => void install());
$<HTMLButtonElement>("retryDictionary").addEventListener("click", () => void install());
$<HTMLButtonElement>("updateDictionary").addEventListener("click", () => void install({ update: true }));
$<HTMLButtonElement>("removeDictionary").addEventListener("click", async () => {
  const res = await sendDictionary({ type: "removeDictionary" });
  if (!res.ok) status(res.error);
  else status("Dictionary removed");
  await refreshDictionary();
});
$<HTMLButtonElement>("cancelDictionaryInstall").addEventListener("click", async () => {
  await sendDictionary({ type: "cancelDictionaryInstall" });
  status("Installation cancelled; the previous dictionary is still active");
  await refreshDictionary();
});

// ── Keyboard shortcuts ───────────────────────────────────────────────────────
let capturing: KeybindAction | null = null;

function renderKeybinds(): void {
  const container = $<HTMLElement>("keybinds");
  container.replaceChildren();
  for (const action of KEYBIND_ACTIONS) {
    const row = document.createElement("div");
    row.className = "kb-row";
    const label = document.createElement("span");
    label.textContent = KEYBIND_LABELS[action];
    const button = document.createElement("button");
    button.type = "button";
    button.className = "kb-btn";
    if (capturing === action) button.classList.add("capturing");
    button.textContent = capturing === action ? "Press keys…" : formatKeybind(config.keybinds[action]);
    button.addEventListener("click", () => {
      capturing = capturing === action ? null : action;
      renderKeybinds();
    });
    row.append(label, button);
    container.append(row);
  }
}

window.addEventListener("keydown", (event) => {
  if (!capturing) return;
  event.preventDefault();
  event.stopPropagation();
  const action = capturing;
  if (event.key === "Escape") {
    capturing = null;
    renderKeybinds();
    return;
  }
  const bind: Keybind = event.key === "Backspace" || event.key === "Delete" ? null : keybindFromEvent(event);
  if (bind === null && event.key !== "Backspace" && event.key !== "Delete") return;
  capturing = null;
  patch({ keybinds: { ...config.keybinds, [action]: bind } }).then(renderKeybinds);
});

function status(text: string): void {
  const element = $<HTMLParagraphElement>("status");
  element.textContent = text;
  window.setTimeout(() => (element.textContent = ""), 2500);
}
