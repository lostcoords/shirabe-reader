import { ApiError, ShirabeApi } from "../common/api.js";
import { ext } from "../common/browser.js";
import { canWriteSrs, DEFAULTS, isConnected, loadConfig, onConfigChanged, saveConfig, type Config } from "../common/config.js";
import { refreshRemoteHostRules } from "../common/host-rules.js";
import type { Request, Response, Status } from "../common/messages.js";
import type { Definition, ParsedToken } from "../common/types.js";

// Single API client + our own copy of the config (the client hides it). Both
// stay in sync with stored settings.
let config: Config = DEFAULTS;
let api: ShirabeApi;
const ready = loadConfig().then((c) => {
  config = c;
  api = new ShirabeApi(c);
  // Best-effort refresh of the server-maintained auto-parse site list, so we can
  // add supported sites without shipping an extension update. No-ops if offline
  // or the endpoint isn't live yet (the bundled built-ins stay in charge).
  void refreshRemoteHostRules(c.apiBase);
});
onConfigChanged((c) => {
  config = c;
  api?.update(c);
});

// ── Request queue ────────────────────────────────────────────────────────────
// Serialize outbound calls with a small gap so a text-heavy page can't burst
// past the server's per-minute budget. The server is the real limiter; this
// just keeps us polite.
const MIN_GAP_MS = 120;
let chain: Promise<unknown> = Promise.resolve();

function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const result = chain.then(task);
  chain = result.then(() => delay(MIN_GAP_MS), () => delay(MIN_GAP_MS));
  return result;
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

// In-flight (or queued) parse requests, keyed by the content script's requestId,
// so a scrolled-away block can abort its outstanding request.
const parseAborts = new Map<number, AbortController>();

async function handle(request: Request): Promise<Response> {
  await ready;
  switch (request.type) {
    case "parse": {
      const tokens = await parseCache.fetch(request.text, () => enqueue(() => api.parse(request.text)));
      return { ok: true, type: "parse", tokens };
    }
    case "parseBatch": {
      // A batch is (near-)unique per request, so it isn't worth caching; the
      // enqueue gap still keeps requests polite. A requestId makes it abortable:
      // lazy viewport parsing cancels a block's request when it scrolls away —
      // even while still queued, since the controller exists before it runs.
      const controller = request.requestId != null ? new AbortController() : undefined;
      if (controller && request.requestId != null) parseAborts.set(request.requestId, controller);
      try {
        const tokens = await enqueue(() => api.parseBatch(request.texts, controller?.signal));
        return { ok: true, type: "parseBatch", tokens };
      } finally {
        if (request.requestId != null) parseAborts.delete(request.requestId);
      }
    }
    case "abortParse": {
      parseAborts.get(request.requestId)?.abort();
      parseAborts.delete(request.requestId);
      return { ok: true, type: "abortParse" };
    }
    case "lookup": {
      const definition = await lookupCache.fetch(request.query, () => enqueue(() => api.lookup(request.query)));
      return { ok: true, type: "lookup", definition };
    }
    case "save": {
      const state = await enqueue(() => api.save(request.lemma, request.rating));
      return { ok: true, type: "save", state };
    }
    case "setState": {
      const state = await enqueue(() => api.setState(request.lemma, request.state));
      return { ok: true, type: "setState", state };
    }
    case "connect":
      await connect();
      return { ok: true, type: "connect" };
    case "disconnect":
      await disconnect();
      return { ok: true, type: "disconnect" };
    case "status":
      return { ok: true, type: "status", status: await status() };
  }
}

// ── Redirect login (OAuth 2.0 authorization code + PKCE) ─────────────────────
// A browser extension can receive a redirect, so instead of a user code + poll
// we open the consent page in an auth window and let the browser hand a one-time
// code straight back to us. We exchange it (with the PKCE verifier we kept) for a
// scoped key — no visible code, no polling.
async function connect(): Promise<void> {
  const { verifier, challenge } = await pkce();
  const state = randomToken(16);
  const redirectUri = ext.identity.getRedirectURL();
  const url = api.authorizeUrl({ redirectUri, state, challenge, client: clientLabel() });

  const redirect = await ext.identity.launchWebAuthFlow({ url, interactive: true });
  const params = new URL(redirect).searchParams;
  const error = params.get("error");
  if (error) throw new ApiError(error === "access_denied" ? "You denied the request." : `Sign-in failed (${error}).`, 400);
  if (params.get("state") !== state) throw new ApiError("Sign-in was interrupted — please try again.", 400);
  const code = params.get("code");
  if (!code) throw new ApiError("No authorization code was returned.", 400);

  const { apiKey, scopes } = await api.exchangeCode({ code, verifier, redirectUri });
  await adopt(apiKey, scopes);
}

// PKCE (S256): a random verifier the client keeps + the SHA-256 challenge the
// server stores; at token exchange the verifier proves we started the flow.
async function pkce(): Promise<{ verifier: string; challenge: string }> {
  const verifier = randomToken(32);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return { verifier, challenge: base64url(new Uint8Array(digest)) };
}

function randomToken(bytes: number): string {
  return base64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// Persist a freshly-minted key, then look up whose account it belongs to.
async function adopt(apiKey: string, scopes: string[]): Promise<void> {
  const next: Config = { ...config, apiKey, scopes, account: "", entitled: false };
  await saveConfig(next);
  config = next;
  api.update(next);
  await refreshAccount();
}

// Re-check the connected account's name + SRS entitlement against the server, so
// a lapsed subscription (or a freshly-activated one) is reflected the next time
// the popup opens. Best-effort: on a network hiccup the stored values stay
// authoritative — the key still mines fine if /v1/me merely blips.
async function refreshAccount(): Promise<void> {
  if (!isConnected(config)) return;
  try {
    const { name, entitled } = await api.me();
    if (name === config.account && entitled === config.entitled) return;
    const next: Config = { ...config, account: name, entitled };
    await saveConfig(next);
    config = next;
  } catch {
    // Offline or transient — keep the last-known account/entitlement.
  }
}

async function disconnect(): Promise<void> {
  const next: Config = { ...config, apiKey: "", account: "", scopes: [], entitled: false };
  await saveConfig(next);
  config = next;
  api.update(next);
}

async function status(): Promise<Status> {
  await refreshAccount(); // freshen name + entitlement each time the popup asks
  return {
    connected: isConnected(config),
    account: config.account,
    canWrite: canWriteSrs(config),
    entitled: config.entitled,
    connecting: false,
    apiBase: config.apiBase,
  };
}

// A human-friendly key name on the server's "Connected apps" list.
function clientLabel(): string {
  const ua = navigator.userAgent;
  const browser = /Firefox/.test(ua) ? "Firefox" : /Edg/.test(ua) ? "Edge" : /Chrome/.test(ua) ? "Chrome" : "Browser";
  return `Shirabe Reader (${browser})`;
}

// Portable async messaging: sendResponse + `return true` works in both Chrome
// (no promise return) and Firefox.
ext.runtime.onMessage.addListener((request: Request, _sender, sendResponse) => {
  handle(request)
    .then(sendResponse)
    .catch((err: unknown) => {
      const error = err instanceof ApiError ? err.message : err instanceof Error ? err.message : String(err);
      sendResponse({ ok: false, error });
    });
  return true;
});

// ── Context menu: parse on demand ────────────────────────────────────────────
const MENU_PAGE = "shirabe-parse-page";
const MENU_SELECTION = "shirabe-parse-selection";

ext.contextMenus?.removeAll().then(() => {
  ext.contextMenus?.create({ id: MENU_PAGE, title: "Parse this page with Shirabe", contexts: ["page"] });
  ext.contextMenus?.create({ id: MENU_SELECTION, title: "Parse selection with Shirabe", contexts: ["selection"] });
});

ext.contextMenus?.onClicked.addListener((info, tab) => {
  if (tab?.id == null) return;
  if (info.menuItemId === MENU_PAGE) ext.tabs.sendMessage(tab.id, { command: "parsePage" });
  if (info.menuItemId === MENU_SELECTION) ext.tabs.sendMessage(tab.id, { command: "parseSelection" });
});

// Tiny LRU keyed by string. Insertion-order Map = cheap recency tracking:
// re-set on hit to mark recent, evict the oldest (first) key when over budget.
class LruCache<V> {
  private store = new Map<string, V>();
  constructor(private max: number) {}

  async fetch(key: string, miss: () => Promise<V>): Promise<V> {
    if (this.store.has(key)) {
      const value = this.store.get(key) as V;
      this.store.delete(key);
      this.store.set(key, value);
      return value;
    }
    const value = await miss();
    this.store.set(key, value);
    if (this.store.size > this.max) this.store.delete(this.store.keys().next().value as string);
    return value;
  }
}

// ── Caches ───────────────────────────────────────────────────────────────────
// Same paragraph or word gets revisited constantly as the user scrolls/hovers.
const parseCache = new LruCache<ParsedToken[]>(500);
const lookupCache = new LruCache<Definition | null>(1000);
