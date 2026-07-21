import { ext } from "./browser.js";
import { DEFAULT_KEYBINDS, type Keybind, type KeybindAction } from "./keybind.js";
import type { GlossLanguage } from "./languages.js";

export type { GlossLanguage };

// Injected at build time by build.mjs (esbuild `define`): the default API host —
// https://shirabe.localhost for dev/watch builds, https://shirabe.org for shipped
// builds. The user can still override it under Advanced.
declare const __DEFAULT_API_BASE__: string;

// Which key must be held while hovering a word to open the popup — Yomitan's
// "scan modifier" model. "none" shows it on plain hover; otherwise hold Alt /
// Ctrl / Shift / Meta so casual reading isn't interrupted.
export type ScanModifier = "none" | "alt" | "ctrl" | "shift" | "meta";
export type FuriganaMode = "all" | "unknown" | "hover" | "off";
export type StatePreset = "standard" | "colorVision" | "minimal";



// User settings, persisted in extension-local storage. The API key is the only
// secret; everything else is a preference. Read/written from the background
// worker and the action popup (settings UI). The key is normally minted by the
// device-login flow (see api.ts) rather than pasted.
export type Config = {
  apiBase: string; // build-time default below; no trailing slash (/v1 is on every host)
  apiKey: string;
  account: string; // display name of the connected account (for the popup header)
  accountCheckedAt: string; // last successful /v1/me refresh
  scopes: string[]; // scopes the connected key carries (gates mining buttons)
  entitled: boolean; // owner may write to the SRS (Pro or a school member)
  furiganaMode: FuriganaMode;
  // Ordered, preferred first — the extension's copy of the account's
  // Prefs#languages. Synced from GET /v1/me while connected; edited locally
  // otherwise. Renders one meaning block per language, in this order.
  languages: GlossLanguage[];
  scanModifier: ScanModifier; // which key (if any) opens the hover popup
  keybinds: Record<KeybindAction, Keybind>; // rebindable shortcuts (parse + grade/save/known)
  enabledHosts: string[]; // sites granted persistent reader access
  disabledHosts: string[]; // domains/patterns where the reader is turned off entirely
  preferredDeckId: number | null; // connected mining target; null uses the server default
  statePreset: StatePreset;
  iPlusOneIncludesLearning: boolean;
  iPlusOneFrequencyMax: number;
};

export const DEFAULTS: Config = {
  apiBase: __DEFAULT_API_BASE__,
  apiKey: "",
  account: "",
  accountCheckedAt: "",
  scopes: [],
  entitled: false,
  furiganaMode: "all",
  languages: ["eng"],
  scanModifier: "shift",
  keybinds: DEFAULT_KEYBINDS,
  enabledHosts: [],
  disabledHosts: [],
  preferredDeckId: null,
  statePreset: "standard",
  iPlusOneIncludesLearning: true,
  iPlusOneFrequencyMax: 20_000,
};

const KEY = "config";
const PRODUCTION_API_BASE = "https://shirabe.org";

// Merge stored settings over defaults, deep-merging `keybinds` so a newly-added
// action keeps its default when older stored settings don't mention it.
function withDefaults(stored: Partial<Config> | undefined): Config {
  const config = { ...DEFAULTS, ...(stored ?? {}) };
  config.keybinds = { ...DEFAULT_KEYBINDS, ...(stored?.keybinds ?? {}) };
  return config;
}

export async function loadConfig(): Promise<Config> {
  const stored = await ext.storage.local.get(KEY);
  const config = withDefaults(stored[KEY] as Partial<Config> | undefined);

  // A production one-shot build used to share dist/firefox with the running
  // watcher. If Firefox reloaded in that window, the persistent dev profile
  // saved shirabe.org and kept bypassing the local pack server on later runs.
  // Repair only that known default; an explicitly configured custom host wins.
  if (__DEFAULT_API_BASE__ !== PRODUCTION_API_BASE && config.apiBase === PRODUCTION_API_BASE) {
    config.apiBase = __DEFAULT_API_BASE__;
    await ext.storage.local.set({ [KEY]: config });
  }

  return config;
}

// Signed in iff we hold a key. Mining (save/grade/known) needs WRITE_SRS *and*
// SRS entitlement (Pro or school) — matching require_srs_pro! on the API. A
// free account still gets dictionary lookup and word coloring.
export const isConnected = (config: Config): boolean => config.apiKey.length > 0;
export const canWriteSrs = (config: Config): boolean =>
  config.scopes.includes("WRITE_SRS") && config.entitled;

// Connected study features are usable iff signed in and SRS-entitled. Local
// dictionary lookup and parsing never depend on this predicate.
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
