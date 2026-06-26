import { ext } from "./browser.js";

// User settings, persisted in extension-local storage. The API key is the only
// secret; everything else is a preference. Read/written from the background
// worker and the action popup (settings UI).
export type Config = {
  apiBase: string; // e.g. https://api.shirabe.org  (no trailing slash)
  apiKey: string;
  locale: string; // gloss language for definitions: en / es / ja …
  showFurigana: boolean;
  autoParse: boolean; // parse pages automatically vs. on demand
};

export const DEFAULTS: Config = {
  apiBase: "https://api.shirabe.org",
  apiKey: "",
  locale: "en",
  showFurigana: true,
  autoParse: false,
};

const KEY = "config";

export async function loadConfig(): Promise<Config> {
  const stored = await ext.storage.local.get(KEY);
  return { ...DEFAULTS, ...((stored[KEY] as Partial<Config>) ?? {}) };
}

export async function saveConfig(config: Config): Promise<void> {
  await ext.storage.local.set({ [KEY]: config });
}

// Notify listeners (e.g. the background worker's in-memory copy) when settings
// change in the popup.
export function onConfigChanged(fn: (config: Config) => void): void {
  ext.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes[KEY]) return;
    fn({ ...DEFAULTS, ...((changes[KEY].newValue as Partial<Config>) ?? {}) });
  });
}
