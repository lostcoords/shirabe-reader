import { ext } from "./browser.js";
import { DEFAULT_KEYBINDS, type Keybind, type KeybindAction } from "./keybind.js";
import type { GlossLanguage } from "./languages.js";

export type { GlossLanguage };

// Injected at build time by build.mjs (esbuild `define`): the default API host :
// https://shirabe.localhost for dev/watch builds, https://shirabe.org for shipped
// builds. The user can still override it under Advanced.
declare const __DEFAULT_API_BASE__: string;

// Which key must be held while hovering a word to open the popup: Yomitan's
// "scan modifier" model. "none" shows it on plain hover; otherwise hold Alt /
// Ctrl / Shift / Meta so casual reading isn't interrupted.
export type ScanModifier = "none" | "alt" | "ctrl" | "shift" | "meta";
export type FuriganaMode = "all" | "unknown" | "hover" | "off";
// How (and whether) a word's part of speech is coloured, using the site's own
// groups and hues. "text" tints the word itself, which leaves the state underline
// free to keep saying how well you know it; "underline" gives the underline to the
// part of speech instead, so it replaces the state cue rather than fighting it.
export type PosColoring = "off" | "text" | "underline";

// User settings, persisted in extension-local storage. The OAuth tokens are the
// only secrets; everything else is a preference. Read/written from the
// background worker and the action popup (settings UI). The tokens come from
// the redirect login (see api.ts): an access token that lives an hour and is
// sent on every request, and a refresh token that renews it and is itself
// replaced on every renewal.
export type Config = {
  apiBase: string; // build-time default below; no trailing slash (/api/v1 is on every host)
  accessToken: string;
  accessTokenExpiresAt: string; // ISO; renew before this, not after
  refreshToken: string;
  account: string; // display name of the connected account (for the popup header)
  accountCheckedAt: string; // last successful /api/v1/me refresh
  scopes: string[]; // scopes the connected key carries (gates mining buttons)
  entitled: boolean; // owner may write to the SRS (Pro or a school member)
  furiganaMode: FuriganaMode;
  // Ordered, preferred first: the extension's copy of the account's
  // Prefs#languages. Synced from GET /api/v1/me while connected; edited locally
  // otherwise. Renders one meaning block per language, in this order.
  languages: GlossLanguage[];
  scanModifier: ScanModifier; // which key (if any) opens the hover popup
  keybinds: Record<KeybindAction, Keybind>; // rebindable shortcuts (parse + grade/save/known)
  enabledHosts: string[]; // sites granted persistent reader access
  disabledHosts: string[]; // domains/patterns where the reader is turned off entirely
  preferredDeckId: number | null; // connected mining target; null uses the server default
  posColoring: PosColoring;
  iPlusOneIncludesLearning: boolean;
  iPlusOneFrequencyMax: number;
  // Record the spoken line when mining a subtitle. It replays the cue to do it
  // (see content/sentence-audio.ts), so it's worth being able to turn off.
  mineSentenceAudio: boolean;
  // Send error reports (failure shape only: never page content, never a URL).
  // Firefox classes this as technicalAndInteraction data, which its policy only
  // lets an add-on collect when the reader can turn it off, so this switch is
  // what makes the manifest's optional declaration true.
  errorReports: boolean;
};

export const DEFAULTS: Config = {
  apiBase: __DEFAULT_API_BASE__,
  accessToken: "",
  accessTokenExpiresAt: "",
  refreshToken: "",
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
  posColoring: "underline",
  iPlusOneIncludesLearning: true,
  iPlusOneFrequencyMax: 10_000,
  mineSentenceAudio: true,
  errorReports: true,
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

// Where every "get Pro" click goes, tagged with the surface it came from: the
// same convention the web app follows with `pricing_path(source: …)`. One helper
// because three hand-built copies of this URL is how attribution quietly rots:
// an untagged /pricing is indistinguishable from someone arriving on their own.
export const pricingUrl = (apiBase: string, source: string): string =>
  `${apiBase.replace(/\/$/, "")}/pricing?source=${encodeURIComponent(source)}`;

// Where every source behind the dictionary is credited in full. Off the API base
// like the links above, so a dev build points at the local server, and with no
// locale segment: the site redirects to the reader's own language.
export const creditsUrl = (apiBase: string): string =>
  `${apiBase.replace(/\/$/, "")}/credits`;

// Signed in iff we hold a refresh token: the access token comes and goes by
// the hour and is renewed from it. Mining (save/grade/known) needs WRITE_SRS
// *and* SRS entitlement (Pro or school): matching require_srs_pro! on the API.
// A free account still gets dictionary lookup and word coloring.
export const isConnected = (config: Config): boolean => config.refreshToken.length > 0;
export const canWriteSrs = (config: Config): boolean =>
  config.scopes.includes("WRITE_SRS") && config.entitled;


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
