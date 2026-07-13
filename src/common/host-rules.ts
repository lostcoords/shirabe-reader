import { ext } from "./browser.js";

// A per-site parsing rule — the trimmed-for-Shirabe version of JitenReader's
// HostMeta. `host` patterns use "*" globs (Chrome match-pattern style). Built-in
// rules carry the smart bits (a `parse` root, whitespace folding for OCR) so
// dedicated reader sites just work; user allow/deny lists compile into bare
// {host, mode} rules.
export type HostRule = {
  host: string | string[];
  mode?: "auto" | "off"; // default "auto"
  parse?: string; // CSS root selector (falls back to <body> if it misses)
  filter?: string; // CSS selector of elements to exclude
  allFrames?: boolean; // parse sub-frames (video/iframe overlays)
  collapseWhitespace?: boolean; // fold newlines for OCR/manga readers
  custom?: "youtube"; // a dedicated parser for a site the generic one can't handle
};

// How the current page should behave. `rule` is the matched auto-rule (its
// selectors/flags drive the parser); absent for plain manual/global-auto.
export type HostResolution = { mode: "auto" | "manual" | "off"; rule?: HostRule };

// Bundled defaults: dedicated reader apps + common Japanese sites (the user chose
// "reader apps + common JP sites"). This list is also refreshable from the server
// (see loadHostRules) so we can add sites without shipping an extension update.
export const BUILTIN_RULES: HostRule[] = [
  // ── Dedicated reader apps (reading JP is the whole point) ──
  { host: ["*://reader.ttsu.app/*", "*://ttu-ebook.web.app/*"] }, // ッツ epub reader
  { host: ["*://reader.mokuro.app/*", "*://*.mokuro.app/*"], collapseWhitespace: true }, // Mokuro manga OCR
  { host: "*://app.readwok.com/*" },
  { host: "*://app.yatsu.moe/*" },
  { host: "*://*.satorireader.com/articles/*" },
  { host: "*://*.aozora.gr.jp/*", parse: ".main_text" }, // Aozora Bunko
  { host: "*://bunpro.jp/*" },
  // ── Common Japanese sites ──
  { host: ["*://ja.wikipedia.org/*", "*://ja.m.wikipedia.org/*"], parse: "#mw-content-text", filter: ".navbox, .reference, .mw-editsection" },
  { host: "*://www3.nhk.or.jp/news/easy/*" }, // NHK News Web Easy
  // ── Video captions (dedicated parser) ──
  { host: ["*://www.youtube.com/*", "*://m.youtube.com/*"], custom: "youtube" }, // on-screen JP subtitles
  // asbplayer local player UI (subtitle list / app chrome). Streaming-site
  // overlays are handled separately by parsers/asbplayer.ts on every host.
  { host: ["*://app.asbplayer.dev/*", "*://*.asbplayer.dev/*"] },
];

const REMOTE_KEY = "hostRules"; // storage cache of server-refreshed rules

// Glob match: "*" → ".*", both scheme+host+path anchored. "<all_urls>" always
// matches. Mirrors JitenReader's match-url semantics (only "*" wildcards).
export function matchUrl(pattern: string, url: string): boolean {
  if (pattern === "<all_urls>") return true;
  const regex = new RegExp("^" + pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$");
  return regex.test(url);
}

function ruleMatches(rule: HostRule, url: string): boolean {
  const hosts = Array.isArray(rule.host) ? rule.host : [rule.host];
  return hosts.some((h) => matchUrl(normalizePattern(h), url));
}

// A bare domain the user typed ("example.com") → a full match pattern. Anything
// already containing "://" or "*" is treated as an explicit pattern.
export function normalizePattern(raw: string): string {
  const p = raw.trim();
  if (!p) return "";
  if (p === "<all_urls>") return p;
  if (p.includes("://") || p.includes("*")) return p;
  return `*://${p}/*`;
}

// Split a textarea list (newline / comma / semicolon / whitespace separated).
export function parseHostList(text: string): string[] {
  return text
    .split(/[\n,;\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

// Resolve the page's mode. Precedence: the user "off" list wins over everything;
// then the user "auto" list; then a matching built-in/remote rule; else manual.
// There is deliberately no "auto-parse everywhere" switch — auto-parsing every
// page would send a lot of text needlessly; auto is always per-domain opt-in.
// `off` built-in rules (e.g. video apps we never want to touch) win over auto.
export function resolveHostMode(
  url: string,
  opts: { autoHosts: string[]; disabledHosts: string[]; rules: HostRule[] },
): HostResolution {
  if (opts.disabledHosts.some((p) => matchUrl(normalizePattern(p), url))) return { mode: "off" };

  const offRule = opts.rules.find((r) => r.mode === "off" && ruleMatches(r, url));
  if (offRule) return { mode: "off", rule: offRule };

  if (opts.autoHosts.some((p) => matchUrl(normalizePattern(p), url))) return { mode: "auto" };

  const autoRule = opts.rules.find((r) => r.mode !== "off" && ruleMatches(r, url));
  if (autoRule) return { mode: "auto", rule: autoRule };

  return { mode: "manual" };
}

// The domain we'd add to the auto/off list for a "do this on this whole site"
// toggle — the registrable host with a wildcard path, e.g. "*://ja.wikipedia.org/*".
export function siteScopeFor(url: string): string {
  try {
    return `*://${new URL(url).hostname}/*`;
  } catch {
    return "";
  }
}

// Built-in rules merged with any the background worker cached from the server.
// Server rules win on order (checked first) so we can override a stale built-in.
export async function loadHostRules(): Promise<HostRule[]> {
  try {
    const stored = await ext.storage.local.get(REMOTE_KEY);
    const remote = (stored[REMOTE_KEY] as HostRule[] | undefined) ?? [];
    return [...remote, ...BUILTIN_RULES];
  } catch {
    return BUILTIN_RULES;
  }
}

// Fetch the server's rule list and cache it. Best-effort: a 404 (endpoint not
// live yet) or network error simply leaves the built-ins in charge.
export async function refreshRemoteHostRules(apiBase: string): Promise<void> {
  try {
    const res = await fetch(`${apiBase.replace(/\/$/, "")}/reader/host-rules.json`, { headers: { Accept: "application/json" } });
    if (!res.ok) return;
    const rules = (await res.json()) as HostRule[];
    if (Array.isArray(rules)) await ext.storage.local.set({ [REMOTE_KEY]: rules });
  } catch {
    // Offline or endpoint absent — keep whatever is cached / the built-ins.
  }
}
