import { DEFAULTS, loadConfig, onConfigChanged, saveConfig, type AudioVoice, type ColorPreset, type Config, type DefinitionSize, type FuriganaMode, type PosColoring, type ScanModifier, type StateColoring, type Theme } from "../common/config.js";
import { matchPreset, PRESET_IDS, PRESETS } from "../common/presets.js";
import type { WordState } from "../common/types.js";
import { mountAccountPanel } from "../common/account-panel.js";
import { mountDictionaryPanel } from "../common/dictionary-panel.js";
import { sendDictionary } from "../common/dictionary-port.js";
import { formatKeybind, KEYBIND_ACTIONS, KEYBIND_LABELS, keybindFromEvent, type Keybind, type KeybindAction } from "../common/keybind.js";
import { send } from "../common/messages.js";
import { installClientReporter } from "../common/client-reporter.js";
import { canReportErrors, ERROR_REPORTS_PERMISSION, ext, usesPromiseMessageResponses } from "../common/browser.js";
import { GLOSS_LABELS, glossLanguagesFrom, uiLanguagesFrom } from "@shirabe-org/card/word-card/languages";

installClientReporter("options");

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

// ── Section nav ──────────────────────────────────────────────────────────────
const SECTION_IDS = ["account", "reading", "dictionary", "advanced"] as const;
const settingsLinks = [...document.querySelectorAll<HTMLAnchorElement>(".settings-nav a")];
function selectSettingsSection(id: string): void {
  const section = id === "keyboard" ? "reading" : id;
  for (const link of settingsLinks) link.setAttribute("aria-current", String(link.hash === `#${section}`));
}
for (const link of settingsLinks) link.addEventListener("click", () => selectSettingsSection(link.hash.slice(1)));

const sectionObserver = new IntersectionObserver(() => {
  const threshold = window.innerHeight * 0.3;
  let current: string = SECTION_IDS[0];
  for (const id of SECTION_IDS) if ($(id).getBoundingClientRect().top <= threshold) current = id;
  selectSettingsSection(current);
}, { rootMargin: "-15% 0px -70%", threshold: 0 });
for (const id of SECTION_IDS) sectionObserver.observe($(id));
window.requestAnimationFrame(() => {
  if (location.hash) selectSettingsSection(location.hash.slice(1));
});

// ── Reading preferences ──────────────────────────────────────────────────────
const prefs = {
  furiganaMode: $<HTMLSelectElement>("furiganaMode"),
  scanModifier: $<HTMLSelectElement>("scanModifier"),
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
  localOnlyAnalysis: $<HTMLInputElement>("localOnlyAnalysis"),
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
  const options = PRESET_IDS.map((id) => new Option(PRESETS[id].label, id));
  if (current === "custom") options.push(new Option("Custom", "custom"));
  prefs.colorPreset.replaceChildren(...options);
  prefs.colorPreset.value = current;
}

function showColors(config: Config): void {
  prefs.posColoring.value = config.posColoring;
  prefs.stateColoring.value = config.stateColoring;
  for (const box of markedBoxes) box.checked = config.markedStates.includes(box.dataset.state as WordState);
  renderPresetOptions(matchPreset(config));
}

let config: Config;

function showErrorReports(): void {
  void canReportErrors().then((allowed) => { prefs.errorReports.checked = config.errorReports && allowed; });
}

loadConfig().then((loaded) => {
  config = loaded;
  prefs.furiganaMode.value = config.furiganaMode;
  prefs.scanModifier.value = config.scanModifier;
  showColors(config);
  prefs.highlighting.checked = config.highlighting;
  prefs.theme.value = config.theme;
  prefs.definitionSize.value = config.definitionSize;
  prefs.audioVoice.value = config.audioVoice;
  prefs.audioAutoplay.checked = config.audioAutoplay;
  prefs.lookupDelay.value = String(config.lookupDelay);
  prefs.popupHideDelay.value = String(config.popupHideDelay);
  prefs.popupHideAutomatically.checked = config.popupHideAutomatically;
  prefs.localOnlyAnalysis.checked = config.localOnlyAnalysis;
  prefs.markFrequent.checked = config.markFrequent;
  prefs.markFrequentMax.value = String(config.markFrequentMax);
  advanced.plainHosts.value = config.plainHosts.join("\n");
  advanced.customWordCss.value = config.customWordCss;
  advanced.customPopupCss.value = config.customPopupCss;
  prefs.mineSentenceAudio.checked = config.mineSentenceAudio;
  showErrorReports();
  prefs.iPlusOneIncludesLearning.checked = config.iPlusOneIncludesLearning;
  prefs.iPlusOneFrequencyMax.value = String(config.iPlusOneFrequencyMax);
  const base = config.apiBase.replace(/\/$/, "");
  $<HTMLAnchorElement>("settingsLink").href = `${base}/settings`;
  $<HTMLAnchorElement>("manageDictionariesLink").href = `${base}/settings#dictionaries`;
  $<HTMLAnchorElement>("privacyLink").href = `${base}/privacy`;
  renderKeybinds();
  void refreshDictionary();
  void loadInstalledDictionarySources();
  void refreshAccount();
  renderDictionarySources();
});

onConfigChanged((next) => {
  if (config?.dictionaryStackDirty && !next.dictionaryStackDirty) status("Dictionary stack synced with Shirabe");
  config = next;
  showErrorReports();
  renderDictionarySources();
});

let installedDictionaries: Config["availableDictionaries"] = [];

async function loadInstalledDictionarySources(): Promise<void> {
  const response = await sendDictionary({ type: "dictionaryStatus" });
  if (!response.ok) return;
  installedDictionaries = response.dictionary.availableDictionaries.map((dictionary) => ({
    ...dictionary,
    languages: uiLanguagesFrom(dictionary.languages.flatMap((code) =>
      code in GLOSS_LABELS ? [code as keyof typeof GLOSS_LABELS] : glossLanguagesFrom([code]))),
  }));
  renderDictionarySources();
}

function currentStack(): string[] {
  if (config.dictionaryStack.length) return config.dictionaryStack;
  return installedDictionaries.some((dictionary) => dictionary.slug === "jmdict") ? ["jmdict:en"] : [];
}

function availableSources(): Config["availableDictionaries"] {
  const sources = new Map(installedDictionaries.map((dictionary) => [dictionary.slug, dictionary]));
  for (const dictionary of config.availableDictionaries) sources.set(dictionary.slug, dictionary);
  return [...sources.values()].map((dictionary) => ({
    ...dictionary,
    name: config.dictionaryNames[dictionary.slug] ?? dictionary.name,
  }));
}

function renderDictionarySources(): void {
  const container = $<HTMLElement>("dictionarySources");
  const hint = $<HTMLElement>("dictionarySourcesHint");
  if (!config || !availableSources().length) {
    container.replaceChildren();
    hint.hidden = false;
    return;
  }
  hint.hidden = true;
  const stack = currentStack();
  const activeOrder = stack.map((source) => source.split(":", 1)[0]).filter((slug, index, all) => all.indexOf(slug) === index);
  const available = availableSources();
  const ordered = [...activeOrder, ...available.map((item) => item.slug).filter((slug) => !activeOrder.includes(slug))];
  container.replaceChildren(...ordered.flatMap((slug) => {
    const option = available.find((item) => item.slug === slug);
    if (!option) return [];
    const selected = stack.filter((source) => source.startsWith(`${slug}:`)).map((source) => source.split(":")[1]!);
    const enabled = selected.length > 0;
    const group = document.createElement("div");
    group.className = "dictionary-source-group";
    group.dataset.enabled = String(enabled);
    const main = document.createElement("div");
    main.className = "dictionary-source";

    const handle = document.createElement("button");
    handle.type = "button";
    handle.className = "dictionary-drag";
    handle.textContent = "⋮⋮";
    handle.draggable = enabled;
    handle.disabled = !enabled;
    handle.setAttribute("aria-label", `Reorder ${option.name}. Use arrow keys or drag.`);
    handle.addEventListener("keydown", (event) => {
      if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
      event.preventDefault();
      void moveDictionary(slug, event.key === "ArrowUp" ? -1 : 1);
    });
    handle.addEventListener("dragstart", (event) => event.dataTransfer?.setData("application/x-shirabe-dictionary", slug));
    group.addEventListener("dragover", (event) => {
      if (!event.dataTransfer?.types.includes("application/x-shirabe-dictionary")) return;
      event.preventDefault();
      group.classList.add("drag-over");
    });
    group.addEventListener("dragleave", () => group.classList.remove("drag-over"));
    group.addEventListener("drop", (event) => {
      event.preventDefault();
      group.classList.remove("drag-over");
      const dragged = event.dataTransfer?.getData("application/x-shirabe-dictionary");
      if (dragged && dragged !== slug) void reorderDictionary(dragged, slug);
    });

    const label = document.createElement("div");
    label.className = "dictionary-source-label";
    const name = document.createElement("strong");
    name.className = "dictionary-source-name";
    name.textContent = slug === "jmdict" && option.name === "JMdict" ? "Shirabe JMdict" : option.name;
    if (!option.name.includes("(")) {
      const qualifier = document.createElement("span");
      qualifier.className = "dictionary-source-qualifier";
      qualifier.textContent = ` (${slug === "wikipedia" ? "articles" : slug === "jmnedict" ? "names" : "definitions"})`;
      name.append(qualifier);
    }
    const controls = document.createElement("div");
    controls.className = "dictionary-source-actions";
    const mode = config.dictionaryReveal[slug] ?? "show";
    const revealMenu = document.createElement("details");
    revealMenu.className = "dictionary-reveal-menu";
    const reveal = document.createElement("summary");
    reveal.className = "dictionary-reveal";
    reveal.title = mode === "show" ? "Always show definitions" : "Show definitions on hover";
    reveal.setAttribute("aria-label", `${option.name}: ${mode === "show" ? "always show" : "show on hover"}`);
    reveal.setAttribute("aria-disabled", String(!enabled));
    const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    icon.setAttribute("aria-hidden", "true");
    const symbol = document.createElementNS("http://www.w3.org/2000/svg", "use");
    symbol.setAttribute("href", mode === "hover" ? "#icon-eye-hover" : "#icon-eye");
    icon.append(symbol);
    reveal.append(icon);
    reveal.addEventListener("click", (event) => { if (!enabled) event.preventDefault(); });
    const revealChoices = document.createElement("div");
    revealChoices.className = "dictionary-reveal-choices";
    for (const [value, label] of [["show", "Always show"], ["hover", "Show on hover"]] as const) {
      const choice = document.createElement("button");
      choice.type = "button";
      choice.textContent = label;
      choice.setAttribute("aria-current", String(mode === value));
      choice.addEventListener("click", () => {
        revealMenu.open = false;
        void saveDictionarySources(stack, { ...config.dictionaryReveal, [slug]: value });
      });
      revealChoices.append(choice);
    }
    revealMenu.append(reveal, revealChoices);
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "dictionary-toggle";
    toggle.setAttribute("role", "switch");
    toggle.setAttribute("aria-checked", String(enabled));
    toggle.setAttribute("aria-label", `${enabled ? "Disable" : "Enable"} ${option.name}`);
    toggle.disabled = enabled && activeOrder.length === 1;
    toggle.append(document.createElement("span"));
    toggle.addEventListener("click", () => void setDictionaryEnabled(slug, !enabled));
    label.append(name);
    if (!installedDictionaries.some((dictionary) => dictionary.slug === slug)) {
      const note = document.createElement("span");
      note.className = "dictionary-source-note";
      note.textContent = "Available on Shirabe · Not in this offline pack";
      label.append(note);
    }
    controls.append(revealMenu, toggle);
    main.append(handle, label, controls);
    group.append(main);

    if (option.languages.length > 1) {
      const languageRow = document.createElement("div");
      languageRow.className = "dictionary-languages";
      const orderedLanguages = [...selected, ...option.languages.filter((language) => !selected.includes(language))];
      for (const language of orderedLanguages) {
        const code = language in GLOSS_LABELS ? language as keyof typeof GLOSS_LABELS : glossLanguagesFrom([language])[0];
        const pill = document.createElement("button");
        pill.type = "button";
        pill.className = "dictionary-language";
        pill.setAttribute("aria-pressed", String(selected.includes(language)));
        pill.setAttribute("aria-label", `${code ? GLOSS_LABELS[code] : language} in ${option.name}`);
        pill.draggable = selected.includes(language);
        if (selected.includes(language)) {
          const rank = document.createElement("span");
          rank.className = "dictionary-language-rank";
          rank.textContent = String(selected.indexOf(language) + 1);
          pill.append(rank);
        }
        pill.append(code ? GLOSS_LABELS[code] : language);
        pill.disabled = selected.includes(language) && selected.length === 1;
        pill.addEventListener("click", () => void setSourceLanguage(slug, language, !selected.includes(language)));
        pill.addEventListener("keydown", (event) => {
          if (!selected.includes(language) || (event.key !== "ArrowLeft" && event.key !== "ArrowRight")) return;
          event.preventDefault();
          void moveSourceLanguage(slug, language, event.key === "ArrowLeft" ? -1 : 1);
        });
        pill.addEventListener("dragstart", (event) => event.dataTransfer?.setData("application/x-shirabe-language", `${slug}:${language}`));
        pill.addEventListener("dragover", (event) => {
          if (event.dataTransfer?.types.includes("application/x-shirabe-language")) event.preventDefault();
        });
        pill.addEventListener("drop", (event) => {
          event.preventDefault();
          const dragged = event.dataTransfer?.getData("application/x-shirabe-language");
          if (dragged && dragged !== `${slug}:${language}`) void reorderSourceLanguage(dragged, `${slug}:${language}`);
        });
        languageRow.append(pill);
      }
      group.append(languageRow);
    }
    return [group];
  }));
}

async function setDictionaryEnabled(slug: string, enabled: boolean): Promise<void> {
  let stack = currentStack().filter((source) => source.split(":", 1)[0] !== slug);
  if (enabled) {
    const option = availableSources().find((item) => item.slug === slug);
    const preferred = uiLanguagesFrom(config.languages).filter((language) => option?.languages.includes(language));
    const languages = preferred.length ? preferred : option?.languages.slice(0, 1) ?? [];
    stack = [...stack, ...languages.map((language) => `${slug}:${language}`)];
  }
  await saveDictionarySources(stack, config.dictionaryReveal);
}

async function moveDictionary(slug: string, movement: -1 | 1): Promise<void> {
  const groups = currentStack().reduce<string[][]>((result, source) => {
    const group = result.find((items) => items[0]?.split(":", 1)[0] === source.split(":", 1)[0]);
    if (group) group.push(source); else result.push([source]);
    return result;
  }, []);
  const from = groups.findIndex((items) => items[0]?.split(":", 1)[0] === slug);
  const to = from + movement;
  if (from < 0 || to < 0 || to >= groups.length) return;
  [groups[from], groups[to]] = [groups[to]!, groups[from]!];
  await saveDictionarySources(groups.flat(), config.dictionaryReveal);
}

async function reorderDictionary(dragged: string, target: string): Promise<void> {
  const groups = currentStack().reduce<string[][]>((result, source) => {
    const group = result.find((items) => items[0]?.split(":", 1)[0] === source.split(":", 1)[0]);
    if (group) group.push(source); else result.push([source]);
    return result;
  }, []);
  const from = groups.findIndex((items) => items[0]?.split(":", 1)[0] === dragged);
  const to = groups.findIndex((items) => items[0]?.split(":", 1)[0] === target);
  if (from < 0 || to < 0 || from === to) return;
  const [group] = groups.splice(from, 1);
  groups.splice(to, 0, group!);
  await saveDictionarySources(groups.flat(), config.dictionaryReveal);
}

async function setSourceLanguage(slug: string, language: string, enabled: boolean): Promise<void> {
  const stack = [...currentStack()];
  const reference = `${slug}:${language}`;
  if (enabled) {
    const last = stack.reduce((found, source, index) => source.startsWith(`${slug}:`) ? index : found, -1);
    stack.splice(last + 1, 0, reference);
  } else {
    stack.splice(stack.indexOf(reference), 1);
  }
  await saveDictionarySources(stack, config.dictionaryReveal);
}

async function moveSourceLanguage(slug: string, language: string, direction: -1 | 1): Promise<void> {
  const stack = [...currentStack()];
  const index = stack.indexOf(`${slug}:${language}`);
  const other = index + direction;
  if (index < 0 || other < 0 || other >= stack.length || !stack[other]?.startsWith(`${slug}:`)) return;
  [stack[index], stack[other]] = [stack[other]!, stack[index]!];
  await saveDictionarySources(stack, config.dictionaryReveal);
}

async function reorderSourceLanguage(dragged: string, target: string): Promise<void> {
  const slug = dragged.split(":", 1)[0];
  if (slug !== target.split(":", 1)[0]) return;
  const stack = [...currentStack()];
  const from = stack.indexOf(dragged);
  const to = stack.indexOf(target);
  if (from < 0 || to < 0 || from === to) return;
  stack.splice(from, 1);
  stack.splice(to, 0, dragged);
  await saveDictionarySources(stack, config.dictionaryReveal);
}

async function saveDictionarySources(dictionaries: string[], dictionaryReveal: Record<string, "show" | "hover">): Promise<void> {
  const response = await send({ type: "updateDictionaryStack", dictionaries, dictionaryReveal });
  if (!response.ok) {
    status(response.error);
    renderDictionarySources();
    return;
  }
  config = { ...config, dictionaryStack: dictionaries, dictionaryReveal };
  renderDictionarySources();
  status(response.synced ? "Dictionary stack saved" : "Saved here; syncing with Shirabe when online");
  await refreshDictionary();
}

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
    ...colors,
    colorPreset: matchPreset({ ...colors }),
    theme: prefs.theme.value as Theme,
    definitionSize: prefs.definitionSize.value as DefinitionSize,
    audioVoice: prefs.audioVoice.value as AudioVoice,
    audioAutoplay: prefs.audioAutoplay.checked,
    lookupDelay: clamp(prefs.lookupDelay.value, 0, 2_000, DEFAULTS.lookupDelay),
    popupHideDelay: clamp(prefs.popupHideDelay.value, 0, 5_000, DEFAULTS.popupHideDelay),
    popupHideAutomatically: prefs.popupHideAutomatically.checked,
    localOnlyAnalysis: prefs.localOnlyAnalysis.checked,
    highlighting: prefs.highlighting.checked,
    mineSentenceAudio: prefs.mineSentenceAudio.checked,
    iPlusOneIncludesLearning: prefs.iPlusOneIncludesLearning.checked,
    iPlusOneFrequencyMax: Math.max(1, Number(prefs.iPlusOneFrequencyMax.value) || DEFAULTS.iPlusOneFrequencyMax),
    markFrequent: prefs.markFrequent.checked,
    markFrequentMax: Math.max(1, Number(prefs.markFrequentMax.value) || DEFAULTS.markFrequentMax),
  });
  showColors(config);
  status("Saved");
});

// ── Advanced ─────────────────────────────────────────────────────────────────
$<HTMLFormElement>("advancedPrefs").addEventListener("change", async (event) => {
  let permissionDenied = false;
  if (event.target === prefs.errorReports && prefs.errorReports.checked && usesPromiseMessageResponses) {
    try {
      permissionDenied = !await ext.permissions.request(ERROR_REPORTS_PERMISSION);
    } catch {
      permissionDenied = true;
    }
    if (permissionDenied) prefs.errorReports.checked = false;
  }
  await patch({
    errorReports: prefs.errorReports.checked,
    plainHosts: advanced.plainHosts.value.split("\n").map((line) => line.trim()).filter(Boolean),
    customWordCss: advanced.customWordCss.value,
    customPopupCss: advanced.customPopupCss.value,
  });
  status(permissionDenied ? "Error reports remain off" : "Saved");
});

// The fields a settings file may carry: everything except the OAuth tokens and
// the account they belong to. Exporting a refresh token would put a live sign-in
// in a file people mail to each other, and importing one would hand this browser
// somebody else's account.
const SECRET_KEYS = ["accessToken", "accessTokenExpiresAt", "accessTokenRefreshAt", "refreshToken", "account", "accountCheckedAt", "scopes", "entitled",
  "dictionaryStackFingerprint", "dictionaryStackDirty", "dictionaryNames", "availableDictionaries"] as const;

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
  onInstalled: loadInstalledDictionarySources,
  onRemoved: loadInstalledDictionarySources,
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
