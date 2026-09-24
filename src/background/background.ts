import { ApiError, ShirabeApi, type Tokens } from "../common/api.js";
import { ext, usesPromiseMessageResponses } from "../common/browser.js";
import { canWriteSrs, DEFAULTS, isConnected, loadConfig, onConfigChanged, saveConfig, type Config } from "../common/config.js";
import { glossLanguagesFrom } from "@shirabe-org/card/word-card/languages";
import { isR2AudioUrl } from "@shirabe-org/card/word-card/audio";
import { refreshRemoteHostRules } from "../common/host-rules.js";
import { cancelDictionaryInstall, checkDictionaryUpdate, clearLocalDictionaryStack, deactivatePrivateDictionaries, disablePrivateDictionaryLookups, DictionaryNotInstalledError, dictionaryStatus, installDictionary, lookupEntryOffline, lookupGroupOffline, lookupKanjiOffline, lookupOffline, OfflineLookupUnavailableError, parseOffline, removeDictionary, resolveParsedSpan, resumeInterruptedDictionaryInstall, setActiveDictionaryStack } from "../common/offline-dictionary.js";
import type { Deck, Failure, PageMetrics, Request, Response, Status, StudyDetails } from "../common/messages.js";
import type { Definition, ParsedToken, WordState } from "../common/types.js";
import { captureEvent, captureException, captureMeasurement, ingestClientReport, installBackgroundErrorHandlers, setTelemetryEnabled } from "./telemetry.js";
import { installDevReload } from "./dev-reload.js";

// Single API client + our own copy of the config (the client hides it). Both
// stay in sync with stored settings.
let config: Config = DEFAULTS;
let api: ShirabeApi;
let dictionaryConnectionEpoch = 0;
installBackgroundErrorHandlers();
installDevReload();

// Installs and upgrades, which is the one number a store dashboard reports and
// nothing else can: how many people took a given version, and how quickly. It
// fires once per event rather than per startup, so it counts what it says.
ext.runtime.onInstalled?.addListener(({ reason }) => {
  if (reason !== "install" && reason !== "update") return;
  captureEvent("extension_installed", { reason });
});
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

  // Handlers are installed before this point (a startup crash is exactly what we
  // want to hear about), so anything queued while the setting was unknown is
  // dropped here if the reader has it off.
  setTelemetryEnabled(config.errorReports);

  api = new ShirabeApi(config, {
    // A renewal happened inside a request: the new pair is what every request
    // from now on goes out on, so it is persisted before the caller sees its
    // answer. Nothing else on Config moves.
    onTokens: async (tokens) => {
      const next: Config = { ...config, ...tokens };
      await saveConfig(next);
      config = next;
    },
    // The server refused to renew: the grant is over (revoked on the account
    // page, idle too long, or the refresh token replayed). Forget the tokens
    // and everything that came with them; the popup shows "connect" again.
    onSignedOut: async () => {
      await forgetConnection();
    },
  });
  if (!isConnected(config)) {
    await traceBackgroundTask("remove private dictionaries for signed-out reader", deactivatePrivateDictionaries);
    await clearLocalDictionaryStack();
  }
  if (config.dictionaryStack.length) {
    await traceBackgroundTask("apply local dictionary stack", () => setActiveDictionaryStack(
      config.dictionaryStack, config.dictionaryReveal, config.dictionaryNames, config.dictionaryStackFingerprint));
  }
  if (isConnected(config)) await refreshAccount(true);
  // Best-effort refresh of the server-maintained reader site list, so we can
  // add supported sites without shipping an extension update. No-ops if offline
  // or the endpoint isn't live yet (the bundled built-ins stay in charge).
  void traceBackgroundTask("refresh remote host rules", () => refreshRemoteHostRules(config.apiBase));
  void traceBackgroundTask("check dictionary update", checkAndNotifyDictionary);
  void ext.scripting.unregisterContentScripts({ ids: ["shirabe-auto-sites"] }).catch(() => undefined);
  // Popup close can kill an MV3 worker mid-import; pick up the persisted job.
  void dictionaryAuthorization().then((authorization) => resumeInterruptedDictionaryInstall(config.apiBase, authorization));
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
    if (error instanceof DOMException && error.name === "AbortError") return;
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
  setTelemetryEnabled(c.errorReports);
});

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

async function dictionaryAuthorization(): Promise<string | undefined> {
  return isConnected(config) && config.scopes.includes("user:dictionary:read") ? api.authorization() : undefined;
}

function repairDictionaryInstallation(): Promise<void> {
  if (dictionaryRepair) return dictionaryRepair;
  dictionaryRepair = dictionaryAuthorization().then((authorization) => installDictionary(config.apiBase, authorization))
    .then(async () => {
      if (config.dictionaryStack.length) await setActiveDictionaryStack(
        config.dictionaryStack, config.dictionaryReveal, config.dictionaryNames, config.dictionaryStackFingerprint);
      lookupCache.clear();
      await notifyDictionaryChanged();
    })
    .finally(() => {
      dictionaryRepair = null;
    });
  return dictionaryRepair;
}

async function checkAndNotifyDictionary(): Promise<void> {
  const connectionEpoch = dictionaryConnectionEpoch;
  const before = await dictionaryStatus();
  if (connectionEpoch !== dictionaryConnectionEpoch) return;
  const authorization = await dictionaryAuthorization();
  if (connectionEpoch !== dictionaryConnectionEpoch) return;
  if (authorization && config.dictionaryStackFingerprint && before.stackFingerprint !== config.dictionaryStackFingerprint) {
    await installDictionary(config.apiBase, authorization);
  } else {
    await checkDictionaryUpdate(config.apiBase, authorization, () => connectionEpoch === dictionaryConnectionEpoch);
  }
  if (config.dictionaryStack.length) await setActiveDictionaryStack(
    config.dictionaryStack, config.dictionaryReveal, config.dictionaryNames, config.dictionaryStackFingerprint);
  if (connectionEpoch !== dictionaryConnectionEpoch) return;
  const after = await dictionaryStatus();
  if (before.revision !== after.revision || before.stackFingerprint !== after.stackFingerprint || before.installed !== after.installed) {
    lookupCache.clear();
    await notifyDictionaryChanged();
  }
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
        const tokens = await parseBatchLocal(request.texts, control);
        return { ok: true, type: "parseBatch", tokens };
      } catch (error) {
        captureMeasurement("parse_failed", 1);
        throw error;
      } finally {
        if (request.requestId != null) activeParses.delete(request.requestId);
      }
    }
    case "parseBatchOnline": {
      const tokens = await parseBatchOnline(request.texts);
      return { ok: true, type: "parseBatchOnline", accepted: tokens !== null, tokens: tokens ?? [] };
    }
    case "lookup": {
      try {
        const kind = request.kind ?? "word";
        // A definition is whatever the active local stack says. Installing a new
        // stack clears this cache, so credentials do not belong in each key and
        // lookup never needs a network fallback.
        const definition = await lookupCache.fetch(`${kind}:${config.languages.join(",")}:${request.query}`, async () => (
          kind === "kanji"
            ? lookupKanjiOffline(request.query, config.languages, config.apiBase)
            : lookupOffline(request.query, config.languages, config.apiBase, config.audioVoice)
        ));
        return { ok: true, type: "lookup", definition };
      } catch (error) {
        if (error instanceof OfflineLookupUnavailableError) return { ok: false, code: "OFFLINE_LOOKUP_UNAVAILABLE", error: error.message };
        if (!(error instanceof DictionaryNotInstalledError)) throw error;
        void repairDictionaryInstallation().catch(() => undefined);
        return { ok: true, type: "lookup", definition: null, dictionaryInstalling: true };
      }
    }
    // The word the reader picked, by handle. Cached beside the ordinary lookup
    // and keyed the same way: a definition is whatever the pack says, so the
    // connection state is not part of the key.
    case "lookupEntry": {
      try {
        const definition = await lookupCache.fetch(
          `entry:${config.languages.join(",")}:${request.entry}:${request.surface}`,
          async () => lookupEntryOffline(request.entry, request.surface, config.languages, config.apiBase, config.audioVoice),
        );
        return { ok: true, type: "lookupEntry", definition };
      } catch (error) {
        if (error instanceof OfflineLookupUnavailableError) return { ok: false, code: "OFFLINE_LOOKUP_UNAVAILABLE", error: error.message };
        if (!(error instanceof DictionaryNotInstalledError)) throw error;
        return { ok: true, type: "lookupEntry", definition: null };
      }
    }
    case "lookupParsed": {
      const alternatives = await hydrateGroups(request.groups, request.surface);
      const definition = alternatives.find((candidate) => candidate.entry === request.entry) ?? alternatives[0] ?? null;
      return { ok: true, type: "lookupParsed", definition, alternatives };
    }
    case "lookupSpan": {
      const surface = request.text.slice(request.startOffset, request.endOffset);
      const resolved = await resolveParsedSpan(request.text, {
        start: request.startOffset, length: request.endOffset - request.startOffset, surface,
        lemma: request.lemma ?? surface, kind: request.kind,
        reading: request.reading ?? null, pos: request.pos ?? "", inflection: request.inflection,
        content: true, state: "none",
      });
      const alternatives = await hydrateGroups(resolved.groups, surface);
      if (alternatives[0] && request.inflection?.length && request.entry && request.entry !== alternatives[0].entry) {
        alternatives[0] = { ...alternatives[0], inflection: request.inflection,
          inflectionBase: request.lemma ?? alternatives[0].inflectionBase ?? alternatives[0].headword };
      }
      return { ok: true, type: "lookupSpan", definition: alternatives[0] ?? null, alternatives, groups: resolved.groups };
    }
    case "dictionaryStatus":
      return { ok: true, type: "dictionaryStatus", dictionary: await dictionaryStatus() };
    case "installDictionary": {
      // Do not await the full import on this message channel. The popup may close
      // mid-install; progress is polled via dictionaryStatus, and a keep-alive +
      // storage snapshot keep the job visible after reopen.
      const pending = dictionaryAuthorization().then((authorization) => installDictionary(config.apiBase, authorization));
      // Fast failures (manifest/network) reject the race and surface immediately
      // to the caller, which reports them through errorResponse.
      const manifest = await Promise.race([
        pending,
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 150)),
      ]);
      // Past that window nobody is left on the channel to surface a failure, and
      // a multi-megabyte download almost always fails later than 150ms: so the
      // install reports its own outcome from here on, or the counter is dead.
      void pending.then(async () => {
        if (config.dictionaryStack.length) await setActiveDictionaryStack(
          config.dictionaryStack, config.dictionaryReveal, config.dictionaryNames, config.dictionaryStackFingerprint);
        lookupCache.clear();
        await notifyDictionaryChanged();
      }, (error) => {
        captureException(error, "background", { request: "installDictionary" });
        captureEvent("dictionary_install_failed", { request: "installDictionary" });
      });
      if (manifest) return { ok: true, type: "installDictionary", manifest };
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
      // No fallback capture here. The content script is the only side that knows
      // to hide our popup first and to prefer the video frame, so a grab from
      // here is a screenshot of the popup covering the scene: worse than the no
      // image it replaces.
      const result = await api.save(options);
      await cacheStates({ [request.lemma]: result.state }, { [request.lemma]: result });
      return { ok: true, type: "save", result };
    }
    case "grade": {
      const result = await api.grade({ cardId: request.cardId, revision: request.revision, rating: request.rating });
      // Refresh the cached details too, not just the top-level state: the popup
      // prefers `details.state` on reopen, so caching state-only would let a stale
      // detail snap a just-graded word back to "due". Carry the cached decks +
      // cardId forward (grading changes neither) and overwrite state + intervals.
      const previous = (await cachedStateSnapshot()).details[request.lemma];
      const details: StudyDetails = {
        state: result.state,
        decks: previous?.decks ?? [],
        intervals: result.intervals,
        ...(result.cardId != null ? { cardId: result.cardId } : previous?.cardId != null ? { cardId: previous.cardId } : {}),
      };
      await cacheStates({ [request.lemma]: result.state }, { [request.lemma]: details });
      return { ok: true, type: "grade", result };
    }
    case "decks":
      return { ok: true, type: "decks", decks: await cachedDecks() };
    case "states":
      return { ok: true, type: "states", ...(await stateSnapshotFor(request.lemmas)) };
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
      const details = await api.setState(request.lemma, request.state);
      await cacheStates({ [request.lemma]: details.state });
      return { ok: true, type: "setState", state: details.state, details };
    }
    case "connect":
      await connect();
      return { ok: true, type: "connect" };
    case "disconnect":
      await disconnect();
      return { ok: true, type: "disconnect" };
    case "audioClip": {
      const dataUrl = await audioCache.fetch(request.url, () => fetchAudioDataUrl(request.url));
      return { ok: true, type: "audioClip", dataUrl };
    }
    case "telemetry":
      ingestClientReport(request.report);
      return { ok: true, type: "telemetry" };
    case "updateDictionaryStack": {
      const next: Config = { ...config, dictionaryStack: request.dictionaries,
        dictionaryReveal: request.dictionaryReveal, dictionaryStackDirty: isConnected(config),
        languages: glossLanguagesFrom(request.dictionaries.map((source) => source.split(":")[1]!)) };
      await saveConfig(next);
      config = next;
      api.update(next);
      await setActiveDictionaryStack(next.dictionaryStack, next.dictionaryReveal, next.dictionaryNames, next.dictionaryStackFingerprint);
      lookupCache.clear();
      await notifyDictionaryChanged();
      if (next.dictionaryStackDirty) void traceBackgroundTask("sync dictionary stack", () => refreshAccount(true));
      return { ok: true, type: "updateDictionaryStack", synced: !next.dictionaryStackDirty };
    }
    case "status":
      return { ok: true, type: "status", status: await status() };
  }
}

// Live parse controls keyed by the content script's requestId, so a `cancelParse`
// message can stop the worker between text nodes. Only holds in-flight requests :
// each entry is removed the moment its parse settles, so a late cancel is a no-op
// and nothing leaks.
const activeParses = new Map<number, { cancelled: boolean }>();

export function cancelLocalParse(requestId: number): void {
  const control = activeParses.get(requestId);
  if (control) control.cancelled = true;
}

async function parseBatchOnline(texts: string[]): Promise<ParsedToken[][] | null> {
  if (config.localOnlyAnalysis || !texts.length || texts.join("\n").length > 2_000) return null;
  const startedAt = performance.now();
  let parsed: Awaited<ReturnType<ShirabeApi["parseWithProvenance"]>>;
  try {
    const installed = await dictionaryStatus();
    parsed = await api.parseWithProvenance(texts, installed.activeSources);
  } catch {
    return null;
  }
  const installed = await dictionaryStatus();
  if (!matchingOnlineParse(parsed, installed)) return null;
  const lists = await Promise.all(parsed.tokens.map(async (tokens, index) => Promise.all(tokens.map(async (token, tokenIndex) => {
    const resolved = await resolveParsedSpan(texts[index]!, token, tokens[tokenIndex - 1]);
    return { ...token, entry: resolved.entry, groups: resolved.groups,
      ...(resolved.candidates.length > 1 ? { candidates: resolved.candidates } : {}) };
  }))));
  if (!matchingOnlineParse(parsed, await dictionaryStatus())) return null;
  recordBackgroundPerformance("online-parse", startedAt, {
    texts: texts.length,
    chars: texts.reduce((sum, text) => sum + text.length, 0),
    tokens: lists.reduce((sum, list) => sum + list.length, 0),
  });
  return lists;
}

function matchingOnlineParse(parsed: { packRevision: string; sources: string[]; stackFingerprint: string },
  installed: Awaited<ReturnType<typeof dictionaryStatus>>): boolean {
  return parsed.packRevision === installed.publicRevision &&
    JSON.stringify(parsed.sources) === JSON.stringify(installed.activeSources) &&
    (!isConnected(config) || parsed.stackFingerprint === installed.stackFingerprint);
}

async function parseBatchLocal(texts: string[], control?: { cancelled: boolean }): Promise<ParsedToken[][]> {
  const startedAt = performance.now();
  const lists: ParsedToken[][] = [];
  for (const text of texts) {
    lists.push(control?.cancelled ? [] : await parseOffline(text, config.languages, config.apiBase));
  }
  recordBackgroundPerformance("local-parse", startedAt, {
    texts: texts.length,
    chars: texts.reduce((sum, text) => sum + text.length, 0),
    tokens: lists.reduce((sum, list) => sum + list.length, 0),
  });
  return lists;
}

async function hydrateGroups(groups: readonly string[][], surface: string): Promise<Definition[]> {
  const definitions = await Promise.all(groups.map((group) =>
    lookupGroupOffline(group, surface, config.languages, config.apiBase, config.audioVoice)));
  return definitions.filter((definition): definition is Definition => definition !== null);
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
async function stateSnapshotFor(lemmas: string[]): Promise<{ states: Record<string, WordState>; details: Record<string, StudyDetails> }> {
  const cached = await cachedStateSnapshot();
  if (!isConnected(config) || !config.scopes.includes("user:study:read")) {
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

// storage.local outlives any single build, so a snapshot written by an older one
// still deserializes: a field short of the type it claims to be. `decks` was
// `memberships` on the wire not long ago, and the reader dereferences it
// directly to label a saved word. Normalize on the way out, so no consumer has
// to defend itself against a cache older than it is.
function pickDetails(details: Record<string, StudyDetails>, lemmas: string[]): Record<string, StudyDetails> {
  return Object.fromEntries(
    lemmas
      .filter((lemma) => details[lemma])
      .map((lemma) => [ lemma, { ...details[lemma], decks: details[lemma].decks ?? [] } ]),
  );
}

// The popup is a page that dies when it loses focus, and clicking the auth
// window is exactly how it loses focus. The worker outlives it, so the worker
// is what remembers a handshake is open: otherwise reopening the popup shows
// "Not connected" and offers a second auth window while the first is still up.
let connecting = false;

async function connect(): Promise<void> {
  connecting = true;
  try {
    await runConnect();
  } finally {
    connecting = false;
  }
}

async function runConnect(): Promise<void> {
  const flow = await api.begin(ext.identity.getRedirectURL());
  const redirect = await ext.identity.launchWebAuthFlow({ url: flow.url, interactive: true });
  await adopt(await api.complete(redirect, flow));
}

// Persist a freshly-minted token pair, then look up whose account it belongs to.
async function adopt(tokens: Tokens): Promise<void> {
  dictionaryConnectionEpoch += 1;
  await deactivatePrivateDictionaries();
  await clearLocalDictionaryStack();
  const next: Config = { ...config, ...tokens, account: "", accountCheckedAt: "", entitled: false,
    dictionaryStack: [], dictionaryStackFingerprint: "", dictionaryStackDirty: false,
    dictionaryReveal: {}, dictionaryNames: {}, availableDictionaries: [] };
  await saveConfig(next);
  await clearProfileCaches();
  config = next;
  api.update(next);
  await refreshAccount(true);
  await installDictionary(config.apiBase, await dictionaryAuthorization());
  await setActiveDictionaryStack(config.dictionaryStack, config.dictionaryReveal, config.dictionaryNames, config.dictionaryStackFingerprint);
  lookupCache.clear();
  await notifyDictionaryChanged();
}

// Re-check the connected account's name + SRS entitlement against the server, so
// a lapsed subscription (or a freshly-activated one) is reflected the next time
// the popup opens. Best-effort: on a network hiccup the stored values stay
// authoritative: the key still mines fine if /api/v1/me merely blips.
const ACCOUNT_CACHE_MAX_AGE_MS = 5 * 60 * 1000;

let accountRefresh: Promise<void> | null = null;

function refreshAccount(force = false): Promise<void> {
  if (accountRefresh) return force ? accountRefresh.then(() => refreshAccount(true)) : accountRefresh;
  const pending = refreshAccountNow(force).finally(() => { accountRefresh = null; });
  accountRefresh = pending;
  return pending;
}

async function refreshAccountNow(force: boolean): Promise<void> {
  if (!isConnected(config)) return;
  const connectionEpoch = dictionaryConnectionEpoch;
  // While not entitled, re-check often so an upgrade shows mining controls
  // without waiting out the full cache window (or re-connecting).
  const maxAge = config.entitled ? ACCOUNT_CACHE_MAX_AGE_MS : 30_000;
  if (!force && !config.dictionaryStackDirty && Date.parse(config.accountCheckedAt) >= Date.now() - maxAge) return;
  try {
    if (config.dictionaryStackDirty) {
      const stack = config.dictionaryStack;
      const reveal = config.dictionaryReveal;
      const fingerprint = await api.updateDictionaryStack(stack, reveal);
      if (connectionEpoch !== dictionaryConnectionEpoch || config.dictionaryStack !== stack || config.dictionaryReveal !== reveal) return;
      const synced: Config = { ...config, dictionaryStackDirty: false, dictionaryStackFingerprint: fingerprint };
      await saveConfig(synced);
      config = synced;
      api.update(synced);
    }
    const { name, entitled, languages, dictionaries, stackFingerprint, dictionaryReveal, dictionaryNames, availableDictionaries } = await api.me();
    if (connectionEpoch !== dictionaryConnectionEpoch) return;
    // The account's language order wins while connected, so the offline pack
    // renders meanings in the same order the website does for this reader. A
    // stack with nothing this pack ships (a French reader) leaves it untouched.
    const synced = languages.length ? languages : config.languages;
    const next: Config = {
      ...config, account: name, accountCheckedAt: new Date().toISOString(), entitled, languages: synced,
      dictionaryStack: config.dictionaryStackDirty ? config.dictionaryStack : dictionaries,
      dictionaryStackFingerprint: stackFingerprint,
      dictionaryStackDirty: config.dictionaryStackDirty,
      dictionaryReveal: config.dictionaryStackDirty ? config.dictionaryReveal : dictionaryReveal,
      dictionaryNames, availableDictionaries,
    };
    await saveConfig(next);
    config = next;
    api.update(next);
    await setActiveDictionaryStack(next.dictionaryStack, next.dictionaryReveal, next.dictionaryNames, next.dictionaryStackFingerprint);
  } catch {
    // Offline or transient: keep the last-known account/entitlement.
  }
}

// The reader's "disconnect": hand the grant back to the server (so it leaves
// their access list), then forget it here.
async function disconnect(): Promise<void> {
  await api.revoke();
  await forgetConnection();
}

async function forgetConnection(): Promise<void> {
  dictionaryConnectionEpoch += 1;
  await clearLocalDictionaryStack();
  const next: Config = {
    ...config, accessToken: "", accessTokenExpiresAt: "", accessTokenRefreshAt: "", refreshToken: "",
    account: "", accountCheckedAt: "", scopes: [], entitled: false,
    dictionaryStack: [], dictionaryStackFingerprint: "", dictionaryStackDirty: false,
    dictionaryReveal: {}, dictionaryNames: {}, availableDictionaries: [],
  };
  config = next;
  api.update(next);
  lookupCache.clear();
  disablePrivateDictionaryLookups();
  await saveConfig(next);
  await deactivatePrivateDictionaries();
  await clearLocalDictionaryStack();
  await notifyDictionaryChanged();
  await clearProfileCaches();
  void installDictionary(next.apiBase).then(notifyDictionaryChanged).catch(() => undefined);
}

async function status(): Promise<Status> {
  await refreshAccount();
  if (isConnected(config)) void traceBackgroundTask("sync changed dictionary stack", checkAndNotifyDictionary);
  return {
    connected: isConnected(config),
    account: config.account,
    canWrite: canWriteSrs(config),
    entitled: config.entitled,
    connecting,
    apiBase: config.apiBase,
  };
}

function errorResponse(err: unknown, requestType = "unknown"): Failure {
  const detail = formatBackgroundError(err);
  console.error("[Shirabe background] request failed", { requestType, error: err, formatted: detail });
  const api = err instanceof ApiError ? err : null;
  // An answer the server gave on purpose (not connected, no scope, needs Pro) is
  // a state, not a fault: reporting it as an exception buries the real ones and
  // tells us nothing we didn't design. 5xx and everything unexpected still ship.
  const expected = api != null && api.status >= 400 && api.status < 500;
  // A telemetry request that fails must not report itself and loop.
  if (requestType !== "telemetry" && !expected) {
    captureException(err, "background", { request: requestType });
    // Named failure counters for the shapes worth alerting on, distinct from the
    // raw exception: onboarding (dictionary install) and backend health (5xx).
    if (requestType === "installDictionary") captureEvent("dictionary_install_failed", { request: requestType });
    if (api && api.status >= 500) captureEvent("api_error", { status: String(api.status), request: requestType });
  }
  return {
    ok: false,
    // What a person reads. The dump rides along as `detail` for the options
    // page's diagnostics and the console: never straight into the popup.
    error: humanMessage(err),
    detail: `request: ${requestType}\n${detail}`,
    ...(api ? { status: api.status, ...(api.code ? { code: api.code } : {}) } : {}),
  };
}

// One sentence, no stack, no "exception:" preamble. An ApiError already carries
// the server's own wording ("Writing to the SRS requires Pro."); anything else
// gets its message, and a thrown non-Error gets a plain apology.
function humanMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  const message = err instanceof Error ? err.message.trim() : "";
  return message || "That didn't go through. Try again.";
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
// Pronunciation clips replayed within a session: small, content-addressed, so
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
    // ApiError, so the caller can branch on 404 ("no clip for this word yet")
    // instead of pattern-matching the sentence.
    throw new ApiError(`Audio fetch failed (${response.status}).`, response.status);
  }
  const buffer = new Uint8Array(await response.arrayBuffer());
  const mediaType = response.headers.get("content-type") || "audio/mp4";
  let binary = "";
  for (let i = 0; i < buffer.length; i += 0x8000) binary += String.fromCharCode(...buffer.subarray(i, i + 0x8000));
  return `data:${mediaType};base64,${btoa(binary)}`;
}
