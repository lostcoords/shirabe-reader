import { ext } from "../common/browser.js";
import { DEFAULTS, loadConfig, onConfigChanged, saveConfig, type Config, type FuriganaMode, type GlossLanguage, type ScanModifier, type StatePreset } from "../common/config.js";
import { formatKeybind, KEYBIND_ACTIONS, KEYBIND_LABELS, keybindFromEvent, type Keybind, type KeybindAction } from "../common/keybind.js";
import { send } from "../common/messages.js";
import { installClientReporter } from "../common/client-reporter.js";

installClientReporter("options");

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const settingsLinks = [...document.querySelectorAll<HTMLAnchorElement>(".settings-nav a")];
function selectSettingsSection(id: string): void {
  for (const link of settingsLinks) link.setAttribute("aria-current", String(link.hash === `#${id}`));
}
for (const link of settingsLinks) link.addEventListener("click", () => selectSettingsSection(link.hash.slice(1)));

const sectionObserver = new IntersectionObserver((entries) => {
  const visible = entries.find((entry) => entry.isIntersecting);
  if (visible?.target.id) selectSettingsSection(visible.target.id);
}, { rootMargin: "-15% 0px -70%", threshold: 0 });
for (const id of ["reading", "keyboard"]) sectionObserver.observe($(id));

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
  renderKeybinds();
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

function status(text: string): void {
  const element = $<HTMLParagraphElement>("status");
  element.textContent = text;
  window.setTimeout(() => (element.textContent = ""), 2500);
}
