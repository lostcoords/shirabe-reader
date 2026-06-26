import { ext } from "../common/browser.js";
import { loadConfig, saveConfig, type Config } from "../common/config.js";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const fields = {
  apiBase: $<HTMLInputElement>("apiBase"),
  apiKey: $<HTMLInputElement>("apiKey"),
  locale: $<HTMLSelectElement>("locale"),
  showFurigana: $<HTMLInputElement>("showFurigana"),
  autoParse: $<HTMLInputElement>("autoParse"),
};

loadConfig().then((config) => {
  fields.apiBase.value = config.apiBase;
  fields.apiKey.value = config.apiKey;
  fields.locale.value = config.locale;
  fields.showFurigana.checked = config.showFurigana;
  fields.autoParse.checked = config.autoParse;
});

$<HTMLFormElement>("settings").addEventListener("submit", async (e) => {
  e.preventDefault();
  const config: Config = {
    apiBase: fields.apiBase.value.trim() || "https://api.shirabe.org",
    apiKey: fields.apiKey.value.trim(),
    locale: fields.locale.value,
    showFurigana: fields.showFurigana.checked,
    autoParse: fields.autoParse.checked,
  };
  await saveConfig(config);
  status("Saved");
});

$<HTMLButtonElement>("parse").addEventListener("click", async () => {
  const [tab] = await ext.tabs.query({ active: true, currentWindow: true });
  if (tab?.id == null) return;
  await ext.tabs.sendMessage(tab.id, { command: "parsePage" });
  window.close();
});

function status(text: string): void {
  const el = $<HTMLParagraphElement>("status");
  el.textContent = text;
  window.setTimeout(() => (el.textContent = ""), 1500);
}
