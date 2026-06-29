import { ApiError, ShirabeApi, type DeviceAuth } from "../common/api.js";
import { ext } from "../common/browser.js";
import { canWriteSrs, DEFAULTS, isConnected, loadConfig, onConfigChanged, saveConfig, type Config } from "../common/config.js";
import type { Request, Response, Status } from "../common/messages.js";
import type { Definition, ParsedToken } from "../common/types.js";

// Single API client + our own copy of the config (the client hides it). Both
// stay in sync with stored settings.
let config: Config = DEFAULTS;
let api: ShirabeApi;
const ready = loadConfig().then((c) => {
  config = c;
  api = new ShirabeApi(c);
});
// Resume an interrupted device handshake whenever the worker (re)starts — MV3
// can suspend us mid-poll, so the source of truth is storage, not memory.
ready.then(resumePolling);
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

async function handle(request: Request): Promise<Response> {
  await ready;
  switch (request.type) {
    case "parse": {
      const tokens = await parseCache.fetch(request.text, () => enqueue(() => api.parse(request.text)));
      return { ok: true, type: "parse", tokens };
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
      return { ok: true, type: "connect", auth: await connect() };
    case "disconnect":
      await disconnect();
      return { ok: true, type: "disconnect" };
    case "status":
      return { ok: true, type: "status", status: await status() };
  }
}

// ── Device login ─────────────────────────────────────────────────────────────
// Begin an RFC 8628-style handshake, open the consent page, and poll until the
// user approves — at which point we persist the minted key. The in-flight
// handshake lives in storage so a suspended worker resumes it on restart; the
// popup's status polling also wakes us, which restarts the loop.
const PENDING = "pendingDevice";
type Pending = { deviceCode: string; deadline: number; interval: number };

async function getPending(): Promise<Pending | null> {
  return ((await ext.storage.local.get(PENDING))[PENDING] as Pending) ?? null;
}
async function setPending(p: Pending | null): Promise<void> {
  if (p) await ext.storage.local.set({ [PENDING]: p });
  else await ext.storage.local.remove(PENDING);
}

async function connect(): Promise<DeviceAuth> {
  const auth = await api.authorizeDevice(clientLabel());
  await setPending({ deviceCode: auth.deviceCode, deadline: Date.now() + auth.expiresIn * 1000, interval: auth.interval });
  ext.tabs.create({ url: auth.verificationUriComplete }).catch(() => {});
  resumePolling();
  return auth;
}

let polling = false;

async function resumePolling(): Promise<void> {
  if (polling) return;
  polling = true;
  try {
    for (;;) {
      const pending = await getPending();
      if (!pending) return;
      if (Date.now() > pending.deadline) return void setPending(null);
      await delay(pending.interval * 1000);
      if (!(await getPending())) return; // disconnected/cleared while we waited

      let res: Awaited<ReturnType<ShirabeApi["pollDevice"]>>;
      try {
        res = await api.pollDevice(pending.deviceCode);
      } catch {
        continue; // transient network error — keep polling until the deadline
      }
      if (res.status === "approved") {
        await adopt(res.apiKey, res.scopes);
        return void setPending(null);
      }
      if (res.status === "denied" || res.status === "expired") return void setPending(null);
    }
  } finally {
    polling = false;
  }
}

// Persist a freshly-minted key and look up whose account it belongs to.
async function adopt(apiKey: string, scopes: string[]): Promise<void> {
  const next: Config = { ...config, apiKey, scopes, account: "" };
  await saveConfig(next);
  config = next;
  api.update(next);
  try {
    const { name } = await api.me();
    const named: Config = { ...next, account: name };
    await saveConfig(named);
    config = named;
  } catch {
    // The key still works for mining even if /v1/me hiccups; name is cosmetic.
  }
}

async function disconnect(): Promise<void> {
  await setPending(null); // abandon any in-flight handshake too
  const next: Config = { ...config, apiKey: "", account: "", scopes: [] };
  await saveConfig(next);
  config = next;
  api.update(next);
}

async function status(): Promise<Status> {
  return {
    connected: isConnected(config),
    account: config.account,
    canWrite: canWriteSrs(config),
    connecting: (await getPending()) != null,
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
