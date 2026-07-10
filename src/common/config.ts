import { ext } from "./browser.js";
import { DEFAULT_KEYBINDS, type Keybind, type KeybindAction } from "./keybind.js";

// Injected at build time by build.mjs (esbuild `define`): the default API host —
// https://shirabe.localhost for dev/watch builds, https://shirabe.org for shipped
// builds. The user can still override it under Advanced.
declare const __DEFAULT_API_BASE__: string;

// Which key must be held while hovering a word to open the popup — Yomitan's
// "scan modifier" model. "none" shows it on plain hover; otherwise hold Alt /
// Ctrl / Shift / Meta so casual reading isn't interrupted.
export type ScanModifier = "none" | "alt" | "ctrl" | "shift" | "meta";

// User settings, persisted in extension-local storage. The API key is the only
// secret; everything else is a preference. Read/written from the background
// worker and the action popup (settings UI). The key is normally minted by the
// device-login flow (see api.ts) rather than pasted.
export type Config = {
  apiBase: string; // build-time default below; no trailing slash (/v1 is on every host)
  apiKey: string;
  account: string; // display name of the connected account (for the popup header)
  scopes: string[]; // scopes the connected key carries (gates mining buttons)
  entitled: boolean; // owner may write to the SRS (Pro or a school member) — gates the whole reader
  showFurigana: boolean;
  showParseButton: boolean; // floating corner "Parse" button on manual-parse pages
  scanModifier: ScanModifier; // which key (if any) opens the hover popup
  keybinds: Record<KeybindAction, Keybind>; // rebindable shortcuts (parse + grade/save/known)
  autoParseHosts: string[]; // domains/patterns to parse automatically on load
  disabledHosts: string[]; // domains/patterns where the reader is turned off entirely
};

export const DEFAULTS: Config = {
  apiBase: __DEFAULT_API_BASE__,
  apiKey: "",
  account: "",
  scopes: [],
  entitled: false,
  showFurigana: true,
  showParseButton: true,
  scanModifier: "none",
  keybinds: DEFAULT_KEYBINDS,
  autoParseHosts: [],
  disabledHosts: [],
};

const KEY = "config";

// Merge stored settings over defaults, deep-merging `keybinds` so a newly-added
// action keeps its default when older stored settings don't mention it.
function withDefaults(stored: Partial<Config> | undefined): Config {
  const config = { ...DEFAULTS, ...(stored ?? {}) };
  config.keybinds = { ...DEFAULT_KEYBINDS, ...(stored?.keybinds ?? {}) };
  return config;
}

export async function loadConfig(): Promise<Config> {
  const stored = await ext.storage.local.get(KEY);
  return withDefaults(stored[KEY] as Partial<Config> | undefined);
}

// Signed in iff we hold a key. Mining (save/grade/known) additionally needs the
// WRITE_SRS scope — a read-only key still colors and defines words.
export const isConnected = (config: Config): boolean => config.apiKey.length > 0;
export const canWriteSrs = (config: Config): boolean => config.scopes.includes("WRITE_SRS");

// Usable iff signed in AND SRS-entitled (Pro or a school member). Without an
// entitlement the reader can neither mine nor colour words by what you know, so
// the popup shows an upgrade prompt instead of the reader UI.
export const isUsable = (config: Config): boolean => isConnected(config) && config.entitled;

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
