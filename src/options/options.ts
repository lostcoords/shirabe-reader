import { ext } from "../common/browser.js";
import { DEFAULTS, loadConfig, saveConfig, type Config, type FuriganaMode, type GlossLanguage, type ScanModifier, type StatePreset } from "../common/config.js";
import { parseHostList } from "../common/host-rules.js";
import { formatKeybind, KEYBIND_ACTIONS, KEYBIND_LABELS, keybindFromEvent, type Keybind, type KeybindAction } from "../common/keybind.js";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const prefs = {
  furiganaMode: $<HTMLSelectElement>("furiganaMode"),
  showParseButton: $<HTMLInputElement>("showParseButton"),
  scanModifier: $<HTMLSelectElement>("scanModifier"),
  languages: $<HTMLSelectElement>("languages"),
  statePreset: $<HTMLSelectElement>("statePreset"),
  iPlusOneIncludesLearning: $<HTMLInputElement>("iPlusOneIncludesLearning"),
  iPlusOneFrequencyMax: $<HTMLInputElement>("iPlusOneFrequencyMax"),
};
const advanced = {
  apiBase: $<HTMLInputElement>("apiBase"),
  apiKey: $<HTMLInputElement>("apiKey"),
  autoParseHosts: $<HTMLTextAreaElement>("autoParseHosts"),
  disabledHosts: $<HTMLTextAreaElement>("disabledHosts"),
};

let config: Config;

loadConfig().then((loaded) => {
  config = loaded;
  prefs.furiganaMode.value = config.furiganaMode;
  prefs.showParseButton.checked = config.showParseButton;
  prefs.scanModifier.value = config.scanModifier;
  prefs.languages.value = config.languages.join(",");
  prefs.statePreset.value = config.statePreset;
  prefs.iPlusOneIncludesLearning.checked = config.iPlusOneIncludesLearning;
  prefs.iPlusOneFrequencyMax.value = String(config.iPlusOneFrequencyMax);
  advanced.apiBase.value = config.apiBase;
  advanced.apiKey.value = config.apiKey;
  advanced.autoParseHosts.value = config.autoParseHosts.join("\n");
  advanced.disabledHosts.value = config.disabledHosts.join("\n");
  const base = config.apiBase.replace(/\/$/, "");
  $<HTMLAnchorElement>("settingsLink").href = `${base}/settings`;
  $<HTMLAnchorElement>("privacyLink").href = `${base}/privacy`;
  $<HTMLAnchorElement>("licensesLink").href = ext.runtime.getURL("licenses.html");
  renderKeybinds();
});

async function patch(change: Partial<Config>): Promise<void> {
  config = { ...config, ...change };
  await saveConfig(config);
}

$<HTMLFormElement>("prefs").addEventListener("change", () => {
  void patch({
    furiganaMode: prefs.furiganaMode.value as FuriganaMode,
    showFurigana: prefs.furiganaMode.value !== "off",
    showParseButton: prefs.showParseButton.checked,
    scanModifier: prefs.scanModifier.value as ScanModifier,
    languages: prefs.languages.value.split(",") as GlossLanguage[],
    statePreset: prefs.statePreset.value as StatePreset,
    iPlusOneIncludesLearning: prefs.iPlusOneIncludesLearning.checked,
    iPlusOneFrequencyMax: Math.max(1, Number(prefs.iPlusOneFrequencyMax.value) || DEFAULTS.iPlusOneFrequencyMax),
  });
  status("Saved");
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
  if (bind === null && event.key !== "Backspace" && event.key !== "Delete") return; // modifier-only, keep waiting
  capturing = null;
  patch({ keybinds: { ...config.keybinds, [action]: bind } }).then(renderKeybinds);
});

// Advanced: manual key + server + host lists. A pasted key's scopes are unknown,
// so assume the full set (the server still enforces) — that keeps mining live.
$<HTMLFormElement>("advancedForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const apiKey = advanced.apiKey.value.trim();
  await patch({
    apiBase: advanced.apiBase.value.trim() || DEFAULTS.apiBase,
    apiKey,
    scopes: apiKey ? ["READ_ACCOUNT", "READ_SRS", "WRITE_SRS"] : [],
    account: apiKey ? config.account : "",
    autoParseHosts: parseHostList(advanced.autoParseHosts.value),
    disabledHosts: parseHostList(advanced.disabledHosts.value),
  });
  status("Saved");
});

function status(text: string): void {
  const element = $<HTMLParagraphElement>("status");
  element.textContent = text;
  window.setTimeout(() => (element.textContent = ""), 2500);
}
