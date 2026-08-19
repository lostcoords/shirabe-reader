import { creditsUrl, DEFAULTS, isConnected, loadConfig, onConfigChanged, saveConfig, type Config, type FuriganaMode, type GlossLanguage, type PosColoring, type ScanModifier } from "../common/config.js";
import { mountAccountPanel } from "../common/account-panel.js";
import { mountDictionaryPanel } from "../common/dictionary-panel.js";
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
  posColoring: $<HTMLSelectElement>("posColoring"),
  mineSentenceAudio: $<HTMLInputElement>("mineSentenceAudio"),
  errorReports: $<HTMLInputElement>("errorReports"),
  iPlusOneIncludesLearning: $<HTMLInputElement>("iPlusOneIncludesLearning"),
  iPlusOneFrequencyMax: $<HTMLInputElement>("iPlusOneFrequencyMax"),
};

let config: Config;

loadConfig().then((loaded) => {
  config = loaded;
  prefs.furiganaMode.value = config.furiganaMode;
  prefs.scanModifier.value = config.scanModifier;
  prefs.languages.value = config.languages.join(",");
  prefs.posColoring.value = config.posColoring;
  prefs.mineSentenceAudio.checked = config.mineSentenceAudio;
  prefs.errorReports.checked = config.errorReports;
  prefs.iPlusOneIncludesLearning.checked = config.iPlusOneIncludesLearning;
  prefs.iPlusOneFrequencyMax.value = String(config.iPlusOneFrequencyMax);
  const base = config.apiBase.replace(/\/$/, "");
  $<HTMLAnchorElement>("settingsLink").href = `${base}/settings`;
  $<HTMLAnchorElement>("privacyLink").href = `${base}/privacy`;
  $<HTMLAnchorElement>("creditsLink").href = creditsUrl(config.apiBase);
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
  if (event.target === prefs.languages && isConnected(config)) {
    const response = await send({ type: "updateLanguages", languages });
    if (!response.ok) {
      prefs.languages.value = config.languages.join(",");
      status(response.error);
      return;
    }
  }
  await patch({
    furiganaMode: prefs.furiganaMode.value as FuriganaMode,
    scanModifier: prefs.scanModifier.value as ScanModifier,
    languages,
    posColoring: prefs.posColoring.value as PosColoring,
    mineSentenceAudio: prefs.mineSentenceAudio.checked,
    errorReports: prefs.errorReports.checked,
    iPlusOneIncludesLearning: prefs.iPlusOneIncludesLearning.checked,
    iPlusOneFrequencyMax: Math.max(1, Number(prefs.iPlusOneFrequencyMax.value) || DEFAULTS.iPlusOneFrequencyMax),
  });
  status(event.target === prefs.languages && isConnected(config) ? "Synced with your profile" : "Saved");
});

// ── Account ──────────────────────────────────────────────────────────────────
// Shared with the toolbar popup (common/account-panel.ts).
const { refresh: refreshAccount } = mountAccountPanel({
  cardId: "accountPanel",
  pricingSource: "extension_settings",
  config: () => config,
  patch,
  status,
});

// ── Offline dictionary ───────────────────────────────────────────────────────
// Shared with the toolbar popup (common/dictionary-panel.ts): the same card,
// one implementation.
const { refresh: refreshDictionary } = mountDictionaryPanel({
  apiBase: () => config?.apiBase || DEFAULTS.apiBase,
  status,
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
