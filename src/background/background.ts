import { ApiError, ShirabeApi } from "../common/api.js";
import { ext, usesPromiseMessageResponses } from "../common/browser.js";
import { canWriteSrs, DEFAULTS, isConnected, loadConfig, onConfigChanged, saveConfig, type Config } from "../common/config.js";
import { isR2AudioUrl } from "../common/audio.js";
import { normalizePattern, refreshRemoteHostRules } from "../common/host-rules.js";
import { cancelDictionaryInstall, checkDictionaryUpdate, DictionaryNotInstalledError, dictionaryStatus, installDictionary, lookupKanjiOffline, lookupOffline, parseOffline, removeDictionary, resumeInterruptedDictionaryInstall } from "../common/offline-dictionary.js";
import type { Deck, LookupHistoryItem, PageMetrics, Request, Response, Status, StudyDetails } from "../common/messages.js";
import type { Definition, ParsedToken, WordState } from "../common/types.js";
import { captureEvent, captureException, captureMeasurement, ingestClientReport, installBackgroundErrorHandlers } from "./telemetry.js";

// Single API client + our own copy of the config (the client hides it). Both
// stay in sync with stored settings.
let config: Config = DEFAULTS;
let api: ShirabeApi;
installBackgroundErrorHandlers();
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
  // Best-effort refresh of the server-maintained reader site list, so we can
  // add supported sites without shipping an extension update. No-ops if offline
  // or the endpoint isn't live yet (the bundled built-ins stay in charge).
  void traceBackgroundTask("refresh remote host rules", () => refreshRemoteHostRules(config.apiBase));
  void traceBackgroundTask("check dictionary update", checkAndNotifyDictionary);
  void traceBackgroundTask("sync registered content scripts", () => syncRegisteredContentScript(config));
  // Popup close can kill an MV3 worker mid-import; pick up the persisted job.
  resumeInterruptedDictionaryInstall(config.apiBase);
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
  for (const raw of current.enabledHosts) {
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

async function notifyDictionaryChanged(): Promise<void> {
  const tabs = await ext.tabs.query({});
  await Promise.all(tabs.filter((tab) => tab.id != null).map((tab) => ext.tabs.sendMessage(tab.id as number, { command: "dictionaryChanged" }).catch(() => undefined)));
}

let dictionaryRepair: Promise<void> | null = null;

function repairDictionaryInstallation(): Promise<void> {
  if (dictionaryRepair) return dictionaryRepair;
  dictionaryRepair = installDictionary(config.apiBase)
    .then(async () => {
      lookupCache.clear();
      await notifyDictionaryChanged();
    })
    .finally(() => {
      dictionaryRepair = null;
    });
  return dictionaryRepair;
}

async function checkAndNotifyDictionary(): Promise<void> {
  const before = await dictionaryStatus();
  await checkDictionaryUpdate(config.apiBase);
  const after = await dictionaryStatus();
  if (before.revision !== after.revision || before.installed !== after.installed) {
    lookupCache.clear();
    await notifyDictionaryChanged();
  }
}

async function notifyProfileChanged(): Promise<void> {
  const tabs = await ext.tabs.query({});
  await Promise.all(tabs.filter((tab) => tab.id != null).map((tab) =>
    ext.tabs.sendMessage(tab.id as number, { command: "profileChanged" }).catch(() => undefined),
  ));
}

// Last known coverage per tab, pushed by each parse/recolour. A service worker
// that gets evicted simply forgets, and the popup falls back to offering a parse.
const tabMetrics = new Map<number, PageMetrics>();
ext.tabs.onRemoved.addListener((tabId) => tabMetrics.delete(tabId));

async function handle(request: Request, senderTabId?: number, senderWindowId?: number): Promise<Response> {
  await ready;
  switch (request.type) {
    case "cancelParse":
      cancelLocalParse(request.requestId);
      return { ok: true, type: "cancelParse" };
    case "parseBatch": {
      const control = { cancelled: false };
      if (request.requestId != null) activeParses.set(request.requestId, control);
      try {
        const tokens = await parseBatchLocally(request.texts, control);
        return { ok: true, type: "parseBatch", tokens };
      } catch (error) {
        if (error instanceof DictionaryNotInstalledError) {
          void repairDictionaryInstallation().catch(() => undefined);
          return {
            ok: true, type: "parseBatch", tokens: request.texts.map(() => []), dictionaryInstalling: true,
          };
        }
        // A real parse failure (not the transient "not installed yet" state) —
        // core functionality broke on this page. Count it, then report as usual.
        captureMeasurement("parse_failed", 1);
        throw error;
      } finally {
        if (request.requestId != null) activeParses.delete(request.requestId);
      }
    }
    case "lookup": {
      try {
        const kind = request.kind ?? "word";
        const definition = await lookupCache.fetch(`${kind}:${config.languages.join(",")}:${request.query}`, async () => {
          // The kanji breakdown has no server counterpart (/v1 search excludes
          // KANJIDIC), so it answers from the local pack or not at all.
          if (kind === "kanji") return lookupKanjiOffline(request.query, config.languages, config.apiBase);
          const local = await lookupOffline(request.query, config.languages, config.apiBase);
          if (local) return local;
          return isConnected(config) ? api.lookup(request.query) : null;
        });
        if (definition) await recordLookup(request.query, definition.headword, definition.reading);
        return { ok: true, type: "lookup", definition };
      } catch (error) {
        if (!(error instanceof DictionaryNotInstalledError)) throw error;
        void repairDictionaryInstallation().catch(() => undefined);
        return { ok: true, type: "lookup", definition: null, dictionaryInstalling: true };
      }
    }
    case "dictionaryStatus":
      return { ok: true, type: "dictionaryStatus", dictionary: await dictionaryStatus() };
    case "installDictionary": {
      // Do not await the full import on this message channel. The popup may close
      // mid-install; progress is polled via dictionaryStatus, and a keep-alive +
      // storage snapshot keep the job visible after reopen.
      const pending = installDictionary(config.apiBase);
      void pending.then(async () => {
        lookupCache.clear();
        await notifyDictionaryChanged();
      }).catch(() => undefined);
      try {
        const manifest = await Promise.race([
          pending,
          new Promise<null>((resolve) => setTimeout(() => resolve(null), 150)),
        ]);
        if (manifest) return { ok: true, type: "installDictionary", manifest };
      } catch (error) {
        // Fast failures (manifest/network) still surface immediately.
        throw error;
      }
      return { ok: true, type: "installDictionary" };
    }
    case "removeDictionary":
      await removeDictionary();
      lookupCache.clear();
      await notifyDictionaryChanged();
      return { ok: true, type: "removeDictionary" };
    case "cancelDictionaryInstall":
      cancelDictionaryInstall();
      return { ok: true, type: "cancelDictionaryInstall" };
    case "captureTab": {
      const imageDataUrl = await ext.tabs.captureVisibleTab(senderWindowId, { format: "jpeg", quality: 82 });
      return { ok: true, type: "captureTab", imageDataUrl };
    }
    case "save": {
      const { type: _type, ...options } = request;
      // Content scripts capture with chrome hidden; fall back to a direct tab
      // grab so saves always attach an image when the tab is capturable.
      const imageDataUrl = options.imageDataUrl
        || await ext.tabs.captureVisibleTab(senderWindowId, { format: "jpeg", quality: 82 }).catch(() => undefined);
      const result = await api.save({ ...options, ...(imageDataUrl ? { imageDataUrl } : {}) });
      await cacheStates({ [request.lemma]: result.state }, { [request.lemma]: result });
      return { ok: true, type: "save", result };
    }
    case "decks":
      return { ok: true, type: "decks", decks: await cachedDecks() };
    case "states":
      return { ok: true, type: "states", ...(await stateSnapshotFor(request.lemmas)) };
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
      await ext.action?.setBadgeBackgroundColor({ color: "#0369a1", ...(senderTabId == null ? {} : { tabId: senderTabId }) });
      await ext.action?.setBadgeText({ text, ...(senderTabId == null ? {} : { tabId: senderTabId }) });
      return { ok: true, type: "pageMetrics" };
    }
    case "activePageMetrics": {
      const [tab] = await ext.tabs.query({ active: true, currentWindow: true });
      return { ok: true, type: "activePageMetrics", metrics: (tab?.id != null && tabMetrics.get(tab.id)) || null };
    }
    case "setState": {
      const state = await api.setState(request.lemma, request.state);
      await cacheStates({ [request.lemma]: state });
      return { ok: true, type: "setState", state };
    }
    case "connect":
      await connect();
      return { ok: true, type: "connect" };
    case "disconnect":
      await disconnect();
      return { ok: true, type: "disconnect" };
    case "syncProfile":
      await refreshAccount(true);
      await clearProfileCaches();
      await notifyProfileChanged();
      return { ok: true, type: "syncProfile" };
    case "audioClip": {
      const dataUrl = await audioCache.fetch(request.url, () => fetchAudioDataUrl(request.url));
      return { ok: true, type: "audioClip", dataUrl };
    }
    case "telemetry":
      ingestClientReport(request.report);
      return { ok: true, type: "telemetry" };
    case "updateLanguages": {
      if (!isConnected(config)) throw new ApiError("Connect your Shirabe account to sync profile languages.", 401);
      const languages = await api.updateLanguages(request.languages);
      const next: Config = { ...config, languages };
      await saveConfig(next);
      config = next;
      api.update(next);
      return { ok: true, type: "updateLanguages", languages };
    }
    case "status":
      return { ok: true, type: "status", status: await status() };
  }
}

// Parsing is local, always. The server used to parse whatever the local path
// couldn't, which meant a reader whose pack failed to install had their page
// text silently posted to us — the one thing the privacy promise rules out —
// and got a second tokenizer's boundaries at that. Without a dictionary we say
// so instead. Only lemmas leave the device, during the separate state refresh.
const LOCAL_PARSE_CONCURRENCY = 4;

// Live parse controls keyed by the content script's requestId, so a `cancelParse`
// message can stop the worker between text nodes. Only holds in-flight requests —
// each entry is removed the moment its parse settles, so a late cancel is a no-op
// and nothing leaks.
const activeParses = new Map<number, { cancelled: boolean }>();

export function cancelLocalParse(requestId: number): void {
  const control = activeParses.get(requestId);
  if (control) control.cancelled = true;
}

// A transport batch used to be parsed serially inside the worker, so grouping
// many text nodes saved message overhead but not parsing time. Run a small
// number concurrently: enough to keep IndexedDB busy without opening hundreds
// of lookup streams on a large page. `control.cancelled` short-circuits the
// remaining nodes when every block in the batch has scrolled out of view.
async function parseBatchLocally(texts: string[], control?: { cancelled: boolean }): Promise<ParsedToken[][]> {
  const startedAt = performance.now();
  const lists = new Array<ParsedToken[]>(texts.length);
  let next = 0;
  const worker = async () => {
    while (next < texts.length && !control?.cancelled) {
      const index = next++;
      lists[index] = await parseOffline(texts[index], config.languages, config.apiBase);
    }
  };
  await Promise.all(Array.from({ length: Math.min(LOCAL_PARSE_CONCURRENCY, texts.length) }, worker));
  for (let index = 0; index < lists.length; index += 1) lists[index] ??= []; // cancelled tail
  recordBackgroundPerformance("local-parse", startedAt, {
    texts: texts.length,
    chars: texts.reduce((sum, text) => sum + text.length, 0),
    tokens: lists.reduce((sum, list) => sum + list.length, 0),
  });
  return lists;
}

const backgroundPerformanceTotals = new Map<string, { runs: number; totalMs: number; maxMs: number }>();

function recordBackgroundPerformance(stage: string, startedAt: number, counts: Record<string, number>): void {
  const durationMs = performance.now() - startedAt;
  const prior = backgroundPerformanceTotals.get(stage) ?? { runs: 0, totalMs: 0, maxMs: 0 };
  const next = {
    runs: prior.runs + 1,
    totalMs: prior.totalMs + durationMs,
    maxMs: Math.max(prior.maxMs, durationMs),
  };
  backgroundPerformanceTotals.set(stage, next);
  if (durationMs < 50 && next.runs % 20 !== 0) return;
  console.debug("[Shirabe performance]", {
    stage,
    durationMs: Math.round(durationMs * 10) / 10,
    averageMs: Math.round((next.totalMs / next.runs) * 10) / 10,
    maxMs: Math.round(next.maxMs * 10) / 10,
    runs: next.runs,
    ...counts,
  });
}

const STATE_CACHE_KEY = "wordStateSnapshot";
const STATE_CACHE_MAX_AGE_MS = 5 * 60 * 1000;
const STATE_CACHE_MAX_LEMMAS = 20_000;
const STATE_REQUEST_MAX_LEMMAS = 1_000;
const DECK_CACHE_KEY = "profileDeckSnapshot";
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

async function stateSnapshotFor(lemmas: string[]): Promise<{ states: Record<string, WordState>; details: Record<string, StudyDetails> }> {
  const cached = await cachedStateSnapshot();
  if (!isConnected(config) || !config.scopes.includes("READ_SRS")) {
    return { states: pickStates(cached.states, lemmas), details: pickDetails(cached.details, lemmas) };
  }
  const freshAfter = Date.now() - STATE_CACHE_MAX_AGE_MS;
  if (lemmas.every((lemma) => lemma in cached.states && Date.parse(cached.checkedAt[lemma] ?? "") >= freshAfter)) {
    return { states: pickStates(cached.states, lemmas), details: pickDetails(cached.details, lemmas) };
  }
  try {
    await refreshRemoteStates(lemmas);
    const refreshed = await cachedStateSnapshot();
    return { states: pickStates(refreshed.states, lemmas), details: pickDetails(refreshed.details, lemmas) };
  } catch {
    return { states: pickStates(cached.states, lemmas), details: pickDetails(cached.details, lemmas) };
  }
}

type CachedStateSnapshot = {
  states: Record<string, WordState>;
  details: Record<string, StudyDetails>;
  checkedAt: Record<string, string>;
};
let memoryStateSnapshot: CachedStateSnapshot | null = null;

async function cachedStateSnapshot(): Promise<CachedStateSnapshot> {
  if (memoryStateSnapshot) return memoryStateSnapshot;
  const stored = await ext.storage.local.get(STATE_CACHE_KEY);
  const snapshot = stored[STATE_CACHE_KEY] as Partial<CachedStateSnapshot> | undefined;
  memoryStateSnapshot = { states: snapshot?.states ?? {}, details: snapshot?.details ?? {}, checkedAt: snapshot?.checkedAt ?? {} };
  return memoryStateSnapshot;
}

async function cacheStates(states: Record<string, WordState>, details: Record<string, StudyDetails> = {}): Promise<void> {
  stateCacheWrite = stateCacheWrite.then(async () => {
    const current = await cachedStateSnapshot();
    const checkedAt = { ...current.checkedAt };
    const now = new Date().toISOString();
    for (const lemma of Object.keys(states)) checkedAt[lemma] = now;
    const snapshot = {
      states: { ...current.states, ...states }, details: { ...current.details, ...details }, checkedAt,
    };
    pruneStateSnapshot(snapshot);
    memoryStateSnapshot = snapshot;
    await ext.storage.local.set({ [STATE_CACHE_KEY]: snapshot });
  });
  await stateCacheWrite;
}

let stateCacheWrite: Promise<void> = Promise.resolve();
const pendingRemoteStateLemmas = new Set<string>();
let remoteStateRefresh: Promise<void> | null = null;

async function refreshRemoteStates(lemmas: string[]): Promise<void> {
  for (const lemma of lemmas) pendingRemoteStateLemmas.add(lemma);
  if (!remoteStateRefresh) {
    remoteStateRefresh = drainRemoteStateRefresh().finally(() => {
      remoteStateRefresh = null;
    });
  }
  await remoteStateRefresh;
}

async function drainRemoteStateRefresh(): Promise<void> {
  await new Promise((resolve) => globalThis.setTimeout(resolve, 0));
  while (pendingRemoteStateLemmas.size) {
    const lemmas = [...pendingRemoteStateLemmas].slice(0, STATE_REQUEST_MAX_LEMMAS);
    for (const lemma of lemmas) pendingRemoteStateLemmas.delete(lemma);
    const fresh = await api.states(lemmas);
    await cacheStates(fresh.states, fresh.details);
  }
}

let memoryDeckSnapshot: { decks: Deck[]; checkedAt: string } | null = null;

async function cachedDecks(): Promise<Deck[]> {
  if (memoryDeckSnapshot && Date.parse(memoryDeckSnapshot.checkedAt) >= Date.now() - ACCOUNT_CACHE_MAX_AGE_MS) {
    return memoryDeckSnapshot.decks;
  }
  const stored = await ext.storage.local.get(DECK_CACHE_KEY);
  const cached = stored[DECK_CACHE_KEY] as { decks?: Deck[]; checkedAt?: string } | undefined;
  if (cached?.decks && Date.parse(cached.checkedAt ?? "") >= Date.now() - ACCOUNT_CACHE_MAX_AGE_MS) {
    memoryDeckSnapshot = { decks: cached.decks, checkedAt: cached.checkedAt as string };
    return cached.decks;
  }
  const decks = await api.decks();
  memoryDeckSnapshot = { decks, checkedAt: new Date().toISOString() };
  await ext.storage.local.set({ [DECK_CACHE_KEY]: memoryDeckSnapshot });
  return decks;
}

function pruneStateSnapshot(snapshot: CachedStateSnapshot): void {
  const lemmas = Object.keys(snapshot.checkedAt);
  if (lemmas.length <= STATE_CACHE_MAX_LEMMAS) return;
  lemmas.sort((a, b) => Date.parse(snapshot.checkedAt[a]) - Date.parse(snapshot.checkedAt[b]));
  for (const lemma of lemmas.slice(0, lemmas.length - STATE_CACHE_MAX_LEMMAS)) {
    delete snapshot.states[lemma];
    delete snapshot.details[lemma];
    delete snapshot.checkedAt[lemma];
  }
}

async function clearProfileCaches(): Promise<void> {
  await remoteStateRefresh?.catch(() => undefined);
  pendingRemoteStateLemmas.clear();
  await stateCacheWrite;
  memoryStateSnapshot = null;
  memoryDeckSnapshot = null;
  await ext.storage.local.remove([STATE_CACHE_KEY, DECK_CACHE_KEY]);
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
  const next: Config = { ...config, apiKey, scopes, account: "", accountCheckedAt: "", entitled: false };
  await saveConfig(next);
  await clearProfileCaches();
  config = next;
  api.update(next);
  await refreshAccount(true);
}

// Re-check the connected account's name + SRS entitlement against the server, so
// a lapsed subscription (or a freshly-activated one) is reflected the next time
// the popup opens. Best-effort: on a network hiccup the stored values stay
// authoritative — the key still mines fine if /v1/me merely blips.
const ACCOUNT_CACHE_MAX_AGE_MS = 5 * 60 * 1000;

async function refreshAccount(force = false): Promise<void> {
  if (!isConnected(config)) return;
  // While not entitled, re-check often so an upgrade shows mining controls
  // without waiting out the full cache window (or re-connecting).
  const maxAge = config.entitled ? ACCOUNT_CACHE_MAX_AGE_MS : 30_000;
  if (!force && Date.parse(config.accountCheckedAt) >= Date.now() - maxAge) return;
  try {
    const { name, entitled, languages } = await api.me();
    // The account's language order wins while connected, so the offline pack
    // renders meanings in the same order the website does for this reader. A
    // stack with nothing this pack ships (a French reader) leaves it untouched.
    const synced = languages.length ? languages : config.languages;
    const next: Config = {
      ...config, account: name, accountCheckedAt: new Date().toISOString(), entitled, languages: synced,
    };
    await saveConfig(next);
    config = next;
  } catch {
    // Offline or transient — keep the last-known account/entitlement.
  }
}

async function disconnect(): Promise<void> {
  const next: Config = { ...config, apiKey: "", account: "", accountCheckedAt: "", scopes: [], entitled: false };
  await saveConfig(next);
  await clearProfileCaches();
  config = next;
  api.update(next);
}

async function status(): Promise<Status> {
  await refreshAccount();
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
  // A telemetry request that fails must not report itself and loop.
  if (requestType !== "telemetry") {
    captureException(err, "background", { request: requestType });
    // Named failure counters for the shapes worth alerting on, distinct from the
    // raw exception: onboarding (dictionary install) and backend health (5xx).
    if (requestType === "installDictionary") captureEvent("dictionary_install_failed", { request: requestType });
    if (err instanceof ApiError && err.status >= 500) captureEvent("api_error", { status: String(err.status), request: requestType });
  }
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
  const response = handle(request, sender.tab?.id, sender.tab?.windowId).catch((error) => errorResponse(error, request.type));
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
  ext.contextMenus?.create({ id: MENU_PAGE, title: "Reparse this page with Shirabe", contexts: ["page"] });
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
// The same word gets revisited constantly as the user scans and hovers.
const lookupCache = new LruCache<Definition | null>(1000);
// Pronunciation clips replayed within a session — small, content-addressed, so
// a modest ring is plenty. Each entry is a base64 data: URL of one short clip.
const audioCache = new LruCache<string>(64);

// Fetch a pronunciation clip from R2 in the privileged background context and
// return it as a data: URL the content script can play under any page CSP.
// Only cdn.shirabe.org/audio/ URLs are ever fetched (isR2AudioUrl), so a
// compromised content script can't turn this into an SSRF primitive.
async function fetchAudioDataUrl(url: string): Promise<string> {
  if (!isR2AudioUrl(url)) throw new Error("Refusing to fetch a non-Shirabe audio URL.");
  const response = await fetch(url);
  if (!response.ok) {
    captureEvent("audio_fetch_failed", { status: String(response.status) });
    throw new Error(`Audio fetch failed (${response.status}).`);
  }
  const buffer = new Uint8Array(await response.arrayBuffer());
  const mediaType = response.headers.get("content-type") || "audio/mp4";
  let binary = "";
  for (let i = 0; i < buffer.length; i += 0x8000) binary += String.fromCharCode(...buffer.subarray(i, i + 0x8000));
  return `data:${mediaType};base64,${btoa(binary)}`;
}
