import { ApiError, ShirabeApi } from "../common/api.js";
import { ext, usesPromiseMessageResponses } from "../common/browser.js";
import { canWriteSrs, DEFAULTS, isConnected, loadConfig, onConfigChanged, saveConfig, type Config } from "../common/config.js";
import { normalizePattern, refreshRemoteHostRules } from "../common/host-rules.js";
import { cancelDictionaryInstall, checkDictionaryUpdate, dictionaryStatus, installDictionary, lookupKanjiOffline, lookupOffline, parseOffline, removeDictionary } from "../common/offline-dictionary.js";
import type { LookupHistoryItem, PageMetrics, Request, Response, Status, StudyDetails } from "../common/messages.js";
import type { Definition, ParsedToken, WordState } from "../common/types.js";

// Single API client + our own copy of the config (the client hides it). Both
// stay in sync with stored settings.
let config: Config = DEFAULTS;
let api: ShirabeApi;
const ready = initializeBackground();

async function initializeBackground(): Promise<void> {
  try {
    config = await tracedBackgroundStep("load extension config from storage.local", loadConfig);
  } catch (error) {
    // A corrupt/inaccessible Firefox storage area must not disable the offline
    // dictionary too. Continue safely as a signed-out user and leave a precise
    // startup trace in the add-on console; later storage operations retain their
    // own errors, while IndexedDB can still be opened and repaired independently.
    config = DEFAULTS;
    console.error("[Shirabe background] initialization degraded to defaults", {
      stage: "load extension config from storage.local",
      error,
      formatted: formatBackgroundError(error),
    });
  }

  api = new ShirabeApi(config);
  // Best-effort refresh of the server-maintained auto-parse site list, so we can
  // add supported sites without shipping an extension update. No-ops if offline
  // or the endpoint isn't live yet (the bundled built-ins stay in charge).
  void traceBackgroundTask("refresh remote host rules", () => refreshRemoteHostRules(config.apiBase));
  void traceBackgroundTask("check dictionary update", () => checkDictionaryUpdate(config.apiBase));
  void traceBackgroundTask("sync registered content scripts", () => syncRegisteredContentScript(config));
}

async function tracedBackgroundStep<T>(stage: string, task: () => Promise<T>): Promise<T> {
  try {
    return await task();
  } catch (cause) {
    const error = new Error(`Background initialization failed during: ${stage}`);
    Object.assign(error, { cause });
    throw error;
  }
}

async function traceBackgroundTask(stage: string, task: () => Promise<unknown>): Promise<void> {
  try {
    await task();
  } catch (error) {
    console.error("[Shirabe background] best-effort startup task failed", {
      stage,
      error,
      formatted: formatBackgroundError(error),
    });
  }
}
onConfigChanged((c) => {
  config = c;
  api?.update(c);
  void syncRegisteredContentScript(c);
});

const CONTENT_SCRIPT_ID = "shirabe-auto-sites";

async function syncRegisteredContentScript(current: Config): Promise<void> {
  await ext.scripting.unregisterContentScripts({ ids: [CONTENT_SCRIPT_ID] }).catch(() => undefined);
  const matches: string[] = [];
  for (const raw of current.autoParseHosts) {
    const pattern = normalizePattern(raw);
    const candidates = pattern.startsWith("*://")
      ? [`https://${pattern.slice(4)}`, `http://${pattern.slice(4)}`]
      : [pattern];
    for (const candidate of candidates) {
      if (candidate && await ext.permissions.contains({ origins: [candidate] })) matches.push(candidate);
    }
  }
  if (!matches.length) return;
  await ext.scripting.registerContentScripts([{
    id: CONTENT_SCRIPT_ID,
    matches: [...new Set(matches)],
    js: ["content.js"],
    css: ["content.css"],
    allFrames: true,
    persistAcrossSessions: true,
    runAt: "document_idle",
  }]);
}

async function sendToTab(tabId: number, message: unknown): Promise<void> {
  try {
    await ext.tabs.sendMessage(tabId, message);
  } catch {
    await ext.scripting.insertCSS({ target: { tabId, allFrames: true }, files: ["content.css"] });
    await ext.scripting.executeScript({ target: { tabId, allFrames: true }, files: ["content.js"] });
    await ext.tabs.sendMessage(tabId, message);
  }
}

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

async function notifyDictionaryChanged(): Promise<void> {
  const tabs = await ext.tabs.query({});
  await Promise.all(tabs.filter((tab) => tab.id != null).map((tab) => ext.tabs.sendMessage(tab.id as number, { command: "dictionaryChanged" }).catch(() => undefined)));
}

// In-flight (or queued) parse requests, keyed by the content script's requestId,
// so a scrolled-away block can abort its outstanding request.
const parseAborts = new Map<number, AbortController>();

// Last known coverage per tab, pushed by each parse/recolour. A service worker
// that gets evicted simply forgets, and the popup falls back to offering a parse.
const tabMetrics = new Map<number, PageMetrics>();
ext.tabs.onRemoved.addListener((tabId) => tabMetrics.delete(tabId));

async function handle(request: Request, senderTabId?: number): Promise<Response> {
  await ready;
  switch (request.type) {
    case "parse": {
      const tokens = await parseCache.fetch(request.text, () => parseLocally(request.text));
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
        const tokens = await parseBatchLocally(request.texts, controller?.signal);
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
      const kind = request.kind ?? "word";
      const definition = await lookupCache.fetch(`${kind}:${config.languages.join(",")}:${request.query}`, async () => {
        // The kanji breakdown has no server counterpart (/v1 search excludes
        // KANJIDIC), so it answers from the local pack or not at all.
        if (kind === "kanji") return lookupKanjiOffline(request.query, config.languages, config.apiBase);
        try {
          const local = await lookupOffline(request.query, config.languages, config.apiBase);
          if (local) return local;
        } catch (error) {
          if (!isConnected(config)) throw error;
        }
        return isConnected(config) ? enqueue(() => api.lookup(request.query)) : null;
      });
      if (definition) await recordLookup(request.query, definition.headword, definition.reading);
      return { ok: true, type: "lookup", definition };
    }
    case "dictionaryStatus":
      return { ok: true, type: "dictionaryStatus", dictionary: await dictionaryStatus() };
    case "installDictionary": {
      const manifest = await installDictionary(config.apiBase);
      await notifyDictionaryChanged();
      return { ok: true, type: "installDictionary", manifest };
    }
    case "removeDictionary":
      await removeDictionary();
      lookupCache.clear();
      await notifyDictionaryChanged();
      return { ok: true, type: "removeDictionary" };
    case "cancelDictionaryInstall":
      cancelDictionaryInstall();
      return { ok: true, type: "cancelDictionaryInstall" };
    case "save": {
      const { type: _type, captureScreenshot, ...options } = request;
      const imageDataUrl = options.imageDataUrl || (captureScreenshot ? await ext.tabs.captureVisibleTab(undefined, { format: "jpeg", quality: 82 }) : undefined);
      const result = await enqueue(() => api.save({ ...options, ...(imageDataUrl ? { imageDataUrl } : {}) }));
      await cacheStates({ [request.lemma]: result.state }, { [request.lemma]: result });
      return { ok: true, type: "save", result };
    }
    case "decks":
      return { ok: true, type: "decks", decks: await enqueue(() => api.decks()) };
    case "states":
      return { ok: true, type: "states", ...(await stateSnapshotFor(request.lemmas)) };
    case "openReader":
      await openReader(request.source);
      return { ok: true, type: "openReader" };
    case "lookupHistory":
      return { ok: true, type: "lookupHistory", history: await lookupHistory() };
    case "clearLookupHistory":
      await ext.storage.local.remove(LOOKUP_HISTORY_KEY);
      return { ok: true, type: "clearLookupHistory" };
    case "pageMetrics": {
      // Remember the page's coverage so the popup can lead with "how much of
      // this can you read" instead of making you parse again to find out. Keyed
      // by tab, dropped when the tab goes.
      if (senderTabId != null) {
        if (request.metrics.total) tabMetrics.set(senderTabId, request.metrics);
        else tabMetrics.delete(senderTabId);
      }
      const text = request.metrics.total ? `${request.metrics.occurrenceCoverage}%` : "";
      await ext.action?.setBadgeBackgroundColor({ color: "#4f46e5", ...(senderTabId == null ? {} : { tabId: senderTabId }) });
      await ext.action?.setBadgeText({ text, ...(senderTabId == null ? {} : { tabId: senderTabId }) });
      return { ok: true, type: "pageMetrics" };
    }
    case "activePageMetrics": {
      const [tab] = await ext.tabs.query({ active: true, currentWindow: true });
      return { ok: true, type: "activePageMetrics", metrics: (tab?.id != null && tabMetrics.get(tab.id)) || null };
    }
    case "setState": {
      const state = await enqueue(() => api.setState(request.lemma, request.state));
      await cacheStates({ [request.lemma]: state });
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

async function openReader(source: "article" | "selection" | "blank"): Promise<void> {
  let draft = { title: "", text: "", sourceUrl: "" };
  if (source !== "blank") {
    const [tab] = await ext.tabs.query({ active: true, currentWindow: true });
    if (tab?.id != null) {
      const [injection] = await ext.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => {
          const selected = window.getSelection()?.toString().trim() ?? "";
          const candidates = [...document.querySelectorAll<HTMLElement>("article,main,[role='main'],.article,.post,.entry-content")];
          const article = candidates.sort((a, b) => score(b) - score(a))[0] ?? document.body;
          const clean = article.cloneNode(true) as HTMLElement;
          clean.querySelectorAll("script,style,noscript,nav,header,footer,aside,form,button,[aria-hidden='true']").forEach((node) => node.remove());
          const canonical = document.querySelector<HTMLLinkElement>("link[rel='canonical']")?.href || location.href;
          return { title: document.title, sourceUrl: canonical, selected, article: clean.innerText.trim() };

          function score(element: HTMLElement): number {
            const text = element.innerText.trim();
            const paragraphs = element.querySelectorAll("p").length;
            const linked = [...element.querySelectorAll<HTMLAnchorElement>("a")].reduce((sum, link) => sum + link.innerText.length, 0);
            return text.length + paragraphs * 120 - linked * 1.5;
          }
        },
      });
      const page = injection?.result as { title: string; sourceUrl: string; selected: string; article: string } | undefined;
      if (page) draft = { title: page.title, sourceUrl: page.sourceUrl, text: source === "selection" ? page.selected : page.article };
    }
  }
  await ext.storage.local.set({ readerDraft: draft });
  await ext.tabs.create({ url: ext.runtime.getURL("reader/reader.html") });
}

// Parsing is local, always. The server used to parse whatever the local path
// couldn't, which meant a reader whose pack failed to install had their page
// text silently posted to us — the one thing the privacy promise rules out —
// and got a second tokenizer's boundaries at that. Without a dictionary we say
// so instead. Only lemmas leave the device, in hydrateStates.
async function parseLocally(text: string): Promise<ParsedToken[]> {
  return hydrateStates(await parseOffline(text, config.languages, config.apiBase));
}

// Sequential so an abort can still land between texts: lazy viewport parsing
// cancels a block that scrolled away, and with no network request left to
// cancel, the only thing to stop is the work we have not started yet.
async function parseBatchLocally(texts: string[], signal?: AbortSignal): Promise<ParsedToken[][]> {
  const lists: ParsedToken[][] = [];
  for (const text of texts) {
    if (signal?.aborted) throw new DOMException("Parsing was cancelled.", "AbortError");
    lists.push(await parseOffline(text, config.languages, config.apiBase));
  }
  const hydrated = await hydrateStates(lists.flat());
  let offset = 0;
  return lists.map((list) => hydrated.slice(offset, (offset += list.length)));
}

async function hydrateStates(tokens: ParsedToken[]): Promise<ParsedToken[]> {
  const lemmas = [...new Set(tokens.filter((token) => token.content).map((token) => token.lemma))];
  if (!lemmas.length) return tokens;
  const states = await statesFor(lemmas);
  return tokens.map((token) => ({ ...token, state: states[token.lemma] ?? token.state }));
}

const STATE_CACHE_KEY = "wordStateSnapshot";
const LOOKUP_HISTORY_KEY = "lookupHistory";

async function lookupHistory(): Promise<LookupHistoryItem[]> {
  const stored = await ext.storage.local.get(LOOKUP_HISTORY_KEY);
  return (stored[LOOKUP_HISTORY_KEY] as LookupHistoryItem[] | undefined) ?? [];
}

async function recordLookup(query: string, headword: string, reading: string | null): Promise<void> {
  const history = await lookupHistory();
  const latest: LookupHistoryItem = { query, headword, reading, lookedUpAt: new Date().toISOString() };
  const deduped = history.filter((item) => item.query !== query || item.headword !== headword);
  await ext.storage.local.set({ [LOOKUP_HISTORY_KEY]: [latest, ...deduped].slice(0, 100) });
}

async function statesFor(lemmas: string[]): Promise<Record<string, WordState>> {
  return (await stateSnapshotFor(lemmas)).states;
}

async function stateSnapshotFor(lemmas: string[]): Promise<{ states: Record<string, WordState>; details: Record<string, StudyDetails> }> {
  const cached = await cachedStateSnapshot();
  if (!isConnected(config) || !config.scopes.includes("READ_SRS")) {
    return { states: pickStates(cached.states, lemmas), details: pickDetails(cached.details, lemmas) };
  }
  try {
    const fresh = await enqueue(() => api.states(lemmas));
    await cacheStates(fresh.states, fresh.details);
    return fresh;
  } catch {
    return { states: pickStates(cached.states, lemmas), details: pickDetails(cached.details, lemmas) };
  }
}

async function cachedStateSnapshot(): Promise<{ states: Record<string, WordState>; details: Record<string, StudyDetails> }> {
  const stored = await ext.storage.local.get(STATE_CACHE_KEY);
  const snapshot = stored[STATE_CACHE_KEY] as { states?: Record<string, WordState>; details?: Record<string, StudyDetails> } | undefined;
  return { states: snapshot?.states ?? {}, details: snapshot?.details ?? {} };
}

async function cacheStates(states: Record<string, WordState>, details: Record<string, StudyDetails> = {}): Promise<void> {
  const current = await cachedStateSnapshot();
  await ext.storage.local.set({ [STATE_CACHE_KEY]: {
    states: { ...current.states, ...states }, details: { ...current.details, ...details }, updatedAt: new Date().toISOString(),
  } });
}

function pickStates(states: Record<string, WordState>, lemmas: string[]): Record<string, WordState> {
  return Object.fromEntries(lemmas.filter((lemma) => states[lemma]).map((lemma) => [lemma, states[lemma]]));
}

function pickDetails(details: Record<string, StudyDetails>, lemmas: string[]): Record<string, StudyDetails> {
  return Object.fromEntries(lemmas.filter((lemma) => details[lemma]).map((lemma) => [lemma, details[lemma]]));
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

  const redirect = await ext.identity.launchWebAuthFlow({ url, interactive: true, redirect_uri: redirectUri });
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
    const { name, entitled, languages } = await api.me();
    // The account's language order wins while connected, so the offline pack
    // renders meanings in the same order the website does for this reader. A
    // stack with nothing this pack ships (a French reader) leaves it untouched.
    const synced = languages.length ? languages : config.languages;
    const unchanged = name === config.account && entitled === config.entitled
      && synced.join(",") === config.languages.join(",");
    if (unchanged) return;
    const next: Config = { ...config, account: name, entitled, languages: synced };
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

function errorResponse(err: unknown, requestType = "unknown"): { ok: false; error: string } {
  const error = formatBackgroundError(err);
  console.error("[Shirabe background] request failed", { requestType, error: err, formatted: error });
  return { ok: false, error: `request: ${requestType}\n${error}` };
}

function formatBackgroundError(error: unknown, depth = 0): string {
  if (depth > 3) return "cause: maximum depth reached";
  if (!(error instanceof Error) && !(error instanceof DOMException)) return String(error) || "Unknown thrown value";
  const candidate = error as Error & { code?: unknown; cause?: unknown };
  const lines = [
    `exception: ${candidate.name || "Error"}`,
    `message: ${candidate.message || "(empty)"}`,
  ];
  if (candidate.code != null) lines.push(`code: ${String(candidate.code)}`);
  if (candidate.stack) lines.push(`stack:\n${candidate.stack}`);
  if (candidate.cause != null) lines.push(`cause:\n${formatBackgroundError(candidate.cause, depth + 1)}`);
  return lines.join("\n");
}

// Firefox recommends returning the handler Promise. Chrome did not support
// Promise listener responses before 148, so it retains sendResponse + true.
// Keeping the two contracts explicit prevents Firefox from losing the original
// installer exception behind its generic "An unexpected error occurred".
ext.runtime.onMessage.addListener((request: Request, sender, sendResponse) => {
  const response = handle(request, sender.tab?.id).catch((error) => errorResponse(error, request.type));
  if (usesPromiseMessageResponses) return response;
  void response.then(sendResponse);
  return true;
});

// Dictionary imports can outlive a one-shot Firefox message channel. Keep a
// named port open for popup dictionary commands so the background page and the
// original error response both survive download, validation, and IndexedDB IO.
ext.runtime.onConnect.addListener((port) => {
  if (port.name !== "shirabe-dictionary") return;
  port.onMessage.addListener((message: { id?: unknown; request?: Request }) => {
    if (!Number.isInteger(message.id) || !message.request) return;
    void handle(message.request, port.sender?.tab?.id)
      .catch((error) => errorResponse(error, message.request?.type))
      .then((response) => port.postMessage({ id: message.id, response }));
  });
});

ext.runtime.onInstalled?.addListener((details) => {
  if (details.reason !== "install") return;
  void ready.then(async () => {
    const status = await dictionaryStatus();
    if (!status.installed) await installDictionary(config.apiBase);
  }).catch(() => undefined);
});

// ── Context menu: parse on demand ────────────────────────────────────────────
const MENU_PAGE = "shirabe-parse-page";
const MENU_SELECTION = "shirabe-parse-selection";
const MENU_LOOKUP = "shirabe-lookup-selection";

ext.contextMenus?.removeAll().then(() => {
  ext.contextMenus?.create({ id: MENU_PAGE, title: "Parse this page with Shirabe", contexts: ["page"] });
  ext.contextMenus?.create({ id: MENU_SELECTION, title: "Parse selection with Shirabe", contexts: ["selection"] });
  ext.contextMenus?.create({ id: MENU_LOOKUP, title: "Look up selection with Shirabe", contexts: ["selection"] });
});

ext.contextMenus?.onClicked.addListener((info, tab) => {
  if (tab?.id == null) return;
  if (info.menuItemId === MENU_PAGE) void sendToTab(tab.id, { command: "parsePage" });
  if (info.menuItemId === MENU_SELECTION) void sendToTab(tab.id, { command: "parseSelection" });
  if (info.menuItemId === MENU_LOOKUP) void sendToTab(tab.id, { command: "lookupSelection" });
});

// Tiny LRU keyed by string. Insertion-order Map = cheap recency tracking:
// re-set on hit to mark recent, evict the oldest (first) key when over budget.
class LruCache<V> {
  private store = new Map<string, V>();
  constructor(private max: number) {}

  clear(): void {
    this.store.clear();
  }

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
