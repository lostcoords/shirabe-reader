import { ApiError, ShirabeApi } from "../common/api.js";
import { ext } from "../common/browser.js";
import { loadConfig, onConfigChanged } from "../common/config.js";
import type { Request, Response } from "../common/messages.js";
import type { Definition, ParsedToken } from "../common/types.js";

// Single API client, kept in sync with stored settings.
let api: ShirabeApi;
const ready = loadConfig().then((config) => {
  api = new ShirabeApi(config);
});
onConfigChanged((config) => api?.update(config));

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
    case "save":
      await enqueue(() => api.save(request.lemma));
      return { ok: true, type: "save" };
    case "setState":
      await enqueue(() => api.setState(request.lemma, request.state));
      return { ok: true, type: "setState" };
  }
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
