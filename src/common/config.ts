import { ext } from "./browser.js";

// How the hover popup is summoned. "hover" shows it whenever the pointer rests
// on a word; "modifier" requires holding a key (Alt/Option) too, so casual
// reading isn't interrupted — the jpd-breader default.
export type PopupTrigger = "hover" | "modifier";

// User settings, persisted in extension-local storage. The API key is the only
// secret; everything else is a preference. Read/written from the background
// worker and the action popup (settings UI). The key is normally minted by the
// device-login flow (see api.ts) rather than pasted.
export type Config = {
  apiBase: string; // e.g. https://api.shirabe.org  (no trailing slash)
  apiKey: string;
  account: string; // display name of the connected account (for the popup header)
  scopes: string[]; // scopes the connected key carries (gates mining buttons)
  locale: string; // gloss language for definitions: en / es / ja …
  showFurigana: boolean;
  autoParse: boolean; // parse pages automatically vs. on demand
  popupTrigger: PopupTrigger;
};

export const DEFAULTS: Config = {
  apiBase: "https://api.shirabe.org",
  apiKey: "",
  account: "",
  scopes: [],
  locale: "en",
  showFurigana: true,
  autoParse: false,
  popupTrigger: "hover",
};

const KEY = "config";

export async function loadConfig(): Promise<Config> {
  const stored = await ext.storage.local.get(KEY);
  return { ...DEFAULTS, ...((stored[KEY] as Partial<Config>) ?? {}) };
}

// Signed in iff we hold a key. Mining (save/grade/known) additionally needs the
// WRITE_SRS scope — a read-only key still colors and defines words.
export const isConnected = (config: Config): boolean => config.apiKey.length > 0;
export const canWriteSrs = (config: Config): boolean => config.scopes.includes("WRITE_SRS");

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
