import { creditsUrl, DEFAULTS, isConnected, loadConfig, onConfigChanged, saveConfig, type AudioVoice, type ColorPreset, type Config, type DefinitionSize, type FuriganaMode, type GlossLanguage, type PosColoring, type ScanModifier, type StateColoring, type Theme } from "../common/config.js";
import { matchPreset, PRESET_IDS, PRESETS } from "../common/presets.js";
import type { WordState } from "../common/types.js";
import { mountAccountPanel } from "../common/account-panel.js";
import { mountDictionaryPanel } from "../common/dictionary-panel.js";
import { formatKeybind, KEYBIND_ACTIONS, KEYBIND_LABELS, keybindFromEvent, type Keybind, type KeybindAction } from "../common/keybind.js";
import { send } from "../common/messages.js";
import { installClientReporter } from "../common/client-reporter.js";

installClientReporter("options");

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

// ── Section nav ──────────────────────────────────────────────────────────────
const SECTION_IDS = ["reading", "dictionary", "account", "keyboard", "advanced"] as const;
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
  stateColoring: $<HTMLSelectElement>("stateColoring"),
  highlighting: $<HTMLInputElement>("highlighting"),
  mineSentenceAudio: $<HTMLInputElement>("mineSentenceAudio"),
  errorReports: $<HTMLInputElement>("errorReports"),
  iPlusOneIncludesLearning: $<HTMLInputElement>("iPlusOneIncludesLearning"),
  iPlusOneFrequencyMax: $<HTMLInputElement>("iPlusOneFrequencyMax"),
  colorPreset: $<HTMLSelectElement>("colorPreset"),
  theme: $<HTMLSelectElement>("theme"),
  definitionSize: $<HTMLSelectElement>("definitionSize"),
  audioVoice: $<HTMLSelectElement>("audioVoice"),
  audioAutoplay: $<HTMLInputElement>("audioAutoplay"),
  lookupDelay: $<HTMLInputElement>("lookupDelay"),
  popupHideDelay: $<HTMLInputElement>("popupHideDelay"),
  popupHideAutomatically: $<HTMLInputElement>("popupHideAutomatically"),
  markFrequent: $<HTMLInputElement>("markFrequent"),
  markFrequentMax: $<HTMLInputElement>("markFrequentMax"),
};

const advanced = {
  plainHosts: $<HTMLTextAreaElement>("plainHosts"),
  customWordCss: $<HTMLTextAreaElement>("customWordCss"),
  customPopupCss: $<HTMLTextAreaElement>("customPopupCss"),
};

const markedBoxes = [...document.querySelectorAll<HTMLInputElement>(".marked-states input[data-state]")];

// "Custom" is only ever a description of where the four fields have ended up, so
// it is offered only once they are somewhere no preset describes.
function renderPresetOptions(current: ColorPreset): void {
  const options = PRESET_IDS.map((id) => `<option value="${id}">${PRESETS[id].label}</option>`);
  if (current === "custom") options.push(`<option value="custom">Custom</option>`);
  prefs.colorPreset.innerHTML = options.join("");
  prefs.colorPreset.value = current;
}

function showColors(config: Config): void {
  prefs.posColoring.value = config.posColoring;
  prefs.stateColoring.value = config.stateColoring;
  for (const box of markedBoxes) box.checked = config.markedStates.includes(box.dataset.state as WordState);
  renderPresetOptions(matchPreset(config));
}

let config: Config;

loadConfig().then((loaded) => {
  config = loaded;
  prefs.furiganaMode.value = config.furiganaMode;
  prefs.scanModifier.value = config.scanModifier;
  prefs.languages.value = config.languages.join(",");
  showColors(config);
  prefs.highlighting.checked = config.highlighting;
  prefs.theme.value = config.theme;
  prefs.definitionSize.value = config.definitionSize;
  prefs.audioVoice.value = config.audioVoice;
  prefs.audioAutoplay.checked = config.audioAutoplay;
  prefs.lookupDelay.value = String(config.lookupDelay);
  prefs.popupHideDelay.value = String(config.popupHideDelay);
  prefs.popupHideAutomatically.checked = config.popupHideAutomatically;
  prefs.markFrequent.checked = config.markFrequent;
  prefs.markFrequentMax.value = String(config.markFrequentMax);
  advanced.plainHosts.value = config.plainHosts.join("\n");
  advanced.customWordCss.value = config.customWordCss;
  advanced.customPopupCss.value = config.customPopupCss;
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

// A blank or junk field falls back to the default rather than saving NaN, and a
// number outside the range the input advertises is pulled back into it.
function clamp(raw: string, min: number, max: number, fallback: number): number {
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

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
  // Picking a preset writes the fields it owns; touching one of those fields by
  // hand leaves the picker describing wherever they landed.
  const colors = event.target === prefs.colorPreset && prefs.colorPreset.value !== "custom"
    ? PRESETS[prefs.colorPreset.value as Exclude<ColorPreset, "custom">].fields
    : {
        posColoring: prefs.posColoring.value as PosColoring,
        stateColoring: prefs.stateColoring.value as StateColoring,
        markedStates: markedBoxes.filter((box) => box.checked).map((box) => box.dataset.state as WordState),
      };

  await patch({
    furiganaMode: prefs.furiganaMode.value as FuriganaMode,
    scanModifier: prefs.scanModifier.value as ScanModifier,
    languages,
    ...colors,
    colorPreset: matchPreset({ ...colors }),
    theme: prefs.theme.value as Theme,
    definitionSize: prefs.definitionSize.value as DefinitionSize,
    audioVoice: prefs.audioVoice.value as AudioVoice,
    audioAutoplay: prefs.audioAutoplay.checked,
    lookupDelay: clamp(prefs.lookupDelay.value, 0, 2_000, DEFAULTS.lookupDelay),
    popupHideDelay: clamp(prefs.popupHideDelay.value, 0, 5_000, DEFAULTS.popupHideDelay),
    popupHideAutomatically: prefs.popupHideAutomatically.checked,
    highlighting: prefs.highlighting.checked,
    mineSentenceAudio: prefs.mineSentenceAudio.checked,
    errorReports: prefs.errorReports.checked,
    iPlusOneIncludesLearning: prefs.iPlusOneIncludesLearning.checked,
    iPlusOneFrequencyMax: Math.max(1, Number(prefs.iPlusOneFrequencyMax.value) || DEFAULTS.iPlusOneFrequencyMax),
    markFrequent: prefs.markFrequent.checked,
    markFrequentMax: Math.max(1, Number(prefs.markFrequentMax.value) || DEFAULTS.markFrequentMax),
  });
  showColors(config);
  status(event.target === prefs.languages && isConnected(config) ? "Synced with your profile" : "Saved");
});

// ── Advanced ─────────────────────────────────────────────────────────────────
$<HTMLFormElement>("advancedPrefs").addEventListener("change", async () => {
  await patch({
    plainHosts: advanced.plainHosts.value.split("\n").map((line) => line.trim()).filter(Boolean),
    customWordCss: advanced.customWordCss.value,
    customPopupCss: advanced.customPopupCss.value,
  });
  status("Saved");
});

// The fields a settings file may carry: everything except the OAuth tokens and
// the account they belong to. Exporting a refresh token would put a live sign-in
// in a file people mail to each other, and importing one would hand this browser
// somebody else's account.
const SECRET_KEYS = ["accessToken", "accessTokenExpiresAt", "refreshToken", "account", "accountCheckedAt", "scopes", "entitled"] as const;

function shareable(config: Config): Partial<Config> {
  const copy: Record<string, unknown> = { ...config };
  for (const key of SECRET_KEYS) delete copy[key];
  return copy as Partial<Config>;
}

$<HTMLButtonElement>("exportSettings").addEventListener("click", () => {
  const blob = new Blob([JSON.stringify(shareable(config), null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "shirabe-reader-settings.json";
  link.click();
  URL.revokeObjectURL(url);
  status("Settings exported");
});

const importFile = $<HTMLInputElement>("importSettingsFile");
$<HTMLButtonElement>("importSettings").addEventListener("click", () => importFile.click());
importFile.addEventListener("change", async () => {
  const file = importFile.files?.[0];
  importFile.value = ""; // so re-picking the same file fires change again
  if (!file) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(await file.text());
  } catch {
    status("That file is not settings JSON");
    return;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    status("That file is not settings JSON");
    return;
  }
  // Only keys we already have, so an old or hand-edited file cannot introduce a
  // setting this build does not understand, and never the sign-in keys.
  const incoming = shareable(parsed as Config);
  const known = Object.fromEntries(Object.entries(incoming).filter(([key]) => key in DEFAULTS));
  if (!Object.keys(known).length) {
    status("Nothing in that file matched a setting");
    return;
  }
  await patch(known as Partial<Config>);
  location.reload(); // every control redraws from the file in one pass
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
