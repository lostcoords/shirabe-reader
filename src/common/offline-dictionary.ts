import { deinflect, inflectionLabel } from "./deinflect.js";
import { GLOSS_LABELS, withEnglishFallback, type GlossLanguage } from "./languages.js";
import type { Definition, ParsedToken, Sense } from "./types.js";
import { sha256 as createSha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";

declare const __EXTENSION_VERSION__: string;

// The physical name carries a schema suffix so a machine holding an earlier
// dev-built database opens a clean one rather than a shape this code cannot
// read. Superseded databases are not migrated: a generation is rebuilt from the
// pack, which is always re-downloadable.
const DB_NAME = "shirabe-offline-dictionary-v3";
const DB_VERSION = 1;
const SUPPORTED_SCHEMA = 2;
const MAX_SCAN_CHARS = 24;
const IMPORT_BATCH = 2_000;

export type PackManifest = {
  schemaVersion: number;
  buildRecipeVersion: number;
  minimumExtensionVersion: string;
  contentRevision: string;
  builtAt: string;
  artifact: string;
  compression: "gzip";
  mediaType: "application/x-ndjson";
  bytes: number;
  sha256: string;
  counts: { terms: number; kanji: number };
  languages: string[];
  dictionaries: Array<{ slug: string; version?: string | null }>;
  modifications: string[];
  sources: Array<{ name: string; url: string; license: string; licenseUrl?: string }>;
  downloadUrl: string;
};

export type DictionaryStatus = {
  installed: boolean;
  revision: string | null;
  builtAt: string | null;
  bytes: number;
  terms: number;
  kanji: number;
  installing: boolean;
  progress: number;
  stage: string | null;
  error: string | null;
  storageBytes: number | null;
  sources: PackManifest["sources"];
  lastCheckedAt: string | null;
};

export class DictionaryNotInstalledError extends Error {
  constructor(operation: "look up words" | "parse text") {
    super(`Install the Shirabe dictionary to ${operation} offline.`);
    this.name = "DictionaryNotInstalledError";
  }
}

type OfflineSense = {
  glosses: Record<string, string[]>;
  partsOfSpeech: string[];
  fields: string[];
  misc: string[];
  dialects: string[];
  restrictions: string[];
};

type OfflineTerm = {
  type: "term";
  id: string;
  dictionary: string;
  headword: string;
  expressions: Array<{ text: string; script: string; common: boolean; tags: string[] }>;
  readings: Array<{ text: string; kind: string }>;
  senses: OfflineSense[];
  pitch?: Array<{ text: string; reading: string; downstep: number; audioUrl: string }>;
  frequencies?: Array<{ source: string; rank: number }>;
  jlpt?: number | null;
};

type OfflineKanji = {
  type: "kanji";
  id: string;
  char: string;
  readings: Record<string, string[]>;
  meanings: Record<string, string[]>;
  strokes?: number;
  grade?: number;
  jlpt?: number;
  frequency?: number;
};

type Stored<T> = T & { pk: string; generation: string };
type Candidate = { text: string; reasons: string[] };
type LookupHit = { term: Stored<OfflineTerm>; candidate: Candidate; prefixLength: number; surface: string };

class BoundedCache<V> {
  private values = new Map<string, V>();

  constructor(private max: number) {}

  get(key: string): V | undefined {
    const value = this.values.get(key);
    if (value === undefined) return;
    this.values.delete(key);
    this.values.set(key, value);
    return value;
  }

  set(key: string, value: V): void {
    this.values.delete(key);
    this.values.set(key, value);
    if (this.values.size > this.max) this.values.delete(this.values.keys().next().value as string);
  }

  clear(): void {
    this.values.clear();
  }
}

let installPromise: Promise<PackManifest> | null = null;
let installController: AbortController | null = null;
let installProgress = 0;
let installStage: string | null = null;
let installError: string | null = null;
let databasePromise: Promise<IDBDatabase> | null = null;
let activeGenerationCache: string | undefined | null = null;
const lookupProbeCache = new BoundedCache<Array<Stored<OfflineTerm>>>(4_000);

export async function dictionaryStatus(): Promise<DictionaryStatus> {
  let db: IDBDatabase;
  try {
    db = await openDatabase();
  } catch (error) {
    throw tracedError(`IndexedDB open failed for ${DB_NAME} v${DB_VERSION}`, error);
  }
  let active: string | undefined;
  let manifest: PackManifest | undefined;
  let lastCheckedAt: string | undefined;
  try {
    [active, manifest, lastCheckedAt] = await Promise.all([
      meta<string>(db, "activeGeneration"), meta<PackManifest>(db, "manifest"), meta<string>(db, "lastUpdateCheck"),
    ]);
  } catch (error) {
    throw tracedError(`IndexedDB metadata read failed; stores=${Array.from(db.objectStoreNames).join(",")}`, error);
  }
  const estimate = await navigator.storage?.estimate?.().catch((error) => {
    console.error("[Shirabe dictionary] storage estimate failed", error);
    return undefined;
  });
  return {
    installed: !!active && !!manifest,
    revision: manifest?.contentRevision ?? null,
    builtAt: manifest?.builtAt ?? null,
    bytes: manifest?.bytes ?? 0,
    terms: manifest?.counts.terms ?? 0,
    kanji: manifest?.counts.kanji ?? 0,
    installing: installPromise != null,
    progress: installProgress,
    stage: installStage,
    error: installError,
    storageBytes: estimate?.usage ?? null,
    sources: manifest?.sources ?? [],
    lastCheckedAt: lastCheckedAt ?? null,
  };
}

export async function checkDictionaryUpdate(apiBase: string): Promise<void> {
  const db = await openDatabase();
  const active = await activeGeneration(db);
  if (!active) {
    await installDictionary(apiBase);
    await setMeta(db, "lastUpdateCheck", new Date().toISOString());
    return;
  }
  const last = await meta<string>(db, "lastUpdateCheck");
  if (last && Date.now() - Date.parse(last) < 24 * 60 * 60 * 1000) return;
  await setMeta(db, "lastUpdateCheck", new Date().toISOString());
  const response = await fetch(`${apiBase.replace(/\/$/, "")}/v1/dictionary-packs/current`, { cache: "no-store" });
  if (!response.ok) return;
  const available = (await response.json()) as PackManifest;
  validateManifest(available);
  if (active !== available.contentRevision) await installDictionary(apiBase);
}

export function installDictionary(apiBase: string): Promise<PackManifest> {
  if (installPromise) return installPromise;
  installProgress = 0;
  installStage = "Preparing dictionary installation";
  installError = null;
  installController = new AbortController();
  installPromise = performInstall(apiBase, installController.signal)
    .catch((error: unknown) => {
      installError = error instanceof DOMException && error.name === "AbortError" ? null : describeInstallError(error, installStage);
      if (installError && typeof location !== "undefined" && /^(moz|chrome)-extension:$/.test(location.protocol)) {
        console.error("[Shirabe] Dictionary installation failed", { stage: installStage, error });
      }
      throw error;
    })
    .finally(() => {
      installPromise = null;
      installController = null;
    });
  return installPromise;
}

export function cancelDictionaryInstall(): void {
  installController?.abort();
}

export async function removeDictionary(): Promise<void> {
  if (installPromise) throw new Error("Wait for the current dictionary installation to finish.");
  if (databasePromise) {
    (await databasePromise).close();
    databasePromise = null;
  }
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase(DB_NAME);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error ?? new Error("Could not remove the local dictionary."));
    request.onblocked = () => reject(new Error("Close other Shirabe Reader pages and try again."));
  });
  installProgress = 0;
  installStage = null;
  installError = null;
  activeGenerationCache = null;
  lookupProbeCache.clear();
}

export async function lookupOffline(query: string, languages: readonly GlossLanguage[], apiBase: string): Promise<Definition | null> {
  const source = normalize(query).slice(0, MAX_SCAN_CHARS);
  if (!source) return null;
  const db = await openDatabase();
  const generation = await activeGeneration(db);
  if (!generation) throw new DictionaryNotInstalledError("look up words");
  return lookupInDatabase(db, generation, source, languages, apiBase);
}

export async function parseOffline(text: string, languages: readonly GlossLanguage[], apiBase: string): Promise<ParsedToken[]> {
  const db = await openDatabase();
  const generation = await activeGeneration(db);
  if (!generation) throw new DictionaryNotInstalledError("parse text");
  const tokens: ParsedToken[] = [];
  let position = 0;
  while (position < text.length) {
    const rest = text.slice(position);
    if (!startsJapanese(rest)) {
      const match = rest.match(NOT_JAPANESE_RUN);
      const surface = match?.[0] ?? rest[0];
      tokens.push({ start: position, length: surface.length, surface, reading: null, lemma: surface, pos: "", content: false, state: "none" });
      position += surface.length;
      continue;
    }

    const definition = await lookupInDatabase(db, generation, rest.slice(0, MAX_SCAN_CHARS), languages, apiBase);
    if (!definition?.sourceForm) {
      const surface = String.fromCodePoint(rest.codePointAt(0) as number);
      tokens.push({ start: position, length: surface.length, surface, reading: null, lemma: surface, pos: "", content: false, state: "none" });
      position += surface.length;
      continue;
    }
    const surface = definition.sourceForm;
    tokens.push({
      start: position, length: surface.length, surface, reading: definition.reading,
      lemma: definition.headword, pos: definition.senses[0]?.partsOfSpeech[0] ?? "",
      content: true, state: "none", frequency: definition.frequency,
    });
    position += surface.length;
  }
  return tokens;
}

async function lookupInDatabase(db: IDBDatabase, generation: string, source: string, languages: readonly GlossLanguage[], apiBase: string): Promise<Definition | null> {
  const prefixes = prefixesLongestFirst(source);
  // Exact prefixes first: IndexedDB reads run concurrently, and this is the
  // overwhelmingly common case.
  const exactHits = await hitsForCandidates(db, generation, prefixes.map((prefix) => ({
    prefix, candidate: { text: prefix, reasons: [] },
  })));

  // Deinflecting only when nothing matched exactly loses to any shorter entry
  // that happens to be a real word: 読みませんでした matched the noun 読み and never
  // reached 読む; 高くなかった matched 高 instead of 高い. Only a prefix longer than
  // the exact match can improve on it, so deinflect just those — keeping
  // longest-match semantics without paying for deinflection on every lookup.
  const longerPrefixes = prefixes.filter((prefix) => [...prefix].length > (exactHits[0]?.prefixLength ?? 0));
  const deinflectedHits = longerPrefixes.length
    ? await hitsForCandidates(db, generation, longerPrefixes.flatMap((prefix) =>
      deinflect(prefix).map((found) => ({ prefix, candidate: { text: found.term, reasons: found.inflections.map(inflectionLabel) } })),
    ))
    : [];

  const hits = deinflectedHits.length ? deinflectedHits : exactHits;
  hits.sort((a, b) => score(b, source) - score(a, source));
  return hits[0] ? termDefinition(hits[0], languages, apiBase) : null;
}

// Kanji are a separate corpus, never a word-search result — the server draws the
// same line by whitelisting `kind: definition/name/encyclopedia` out of search
// (searches_controller.rb) and reaching KANJIDIC only from an explicit kanji
// page or an in-card breakdown. This is that explicit path: the popup's kanji
// strip, which is our breakdown.
export async function lookupKanjiOffline(character: string, languages: readonly GlossLanguage[], apiBase: string): Promise<Definition | null> {
  const source = normalize(character);
  if ([...source].length !== 1 || !isKanji(source)) return null;
  const db = await openDatabase();
  const generation = await activeGeneration(db);
  if (!generation) throw new DictionaryNotInstalledError("look up words");
  const kanji = await getByPk<Stored<OfflineKanji>>(db, "kanji", `${generation}\0${source}`);
  return kanji ? kanjiDefinition(kanji, languages, apiBase) : null;
}

async function hitsForCandidates(
  db: IDBDatabase,
  generation: string,
  probes: Array<{ prefix: string; candidate: Candidate }>,
): Promise<LookupHit[]> {
  if (!probes.length) return [];
  // IndexedDB commits a transaction once its requests drain, so issuing every
  // probe in this tick keeps them on ONE transaction instead of opening one per
  // candidate. The multiEntry index answers with the term records themselves, so
  // a probe is one query rather than a key lookup followed by a fetch per id.
  // Page text reaches parseOffline unnormalized and its token offsets are
  // measured against that raw text, so normalize the probe only — `prefix` stays
  // the on-page surface.
  const keys = db.transaction("terms").objectStore("terms").index("lookupKeys");
  const resolved = await Promise.all(probes.map(async (probe) => ({
    ...probe,
    terms: await termsForProbe(keys, `${generation}\0${normalize(probe.candidate.text)}`),
  })));
  const longest = resolved.find((probe) => probe.terms.length)?.prefix;
  if (!longest) return [];
  const seen = new Set<string>();
  return resolved
    .filter((probe) => probe.prefix === longest && probe.terms.length)
    .flatMap((probe) => probe.terms.flatMap((term) => {
      if (seen.has(term.id)) return [];
      seen.add(term.id);
      return [{ term, candidate: probe.candidate, prefixLength: [...probe.prefix].length, surface: probe.prefix }];
    }));
}

async function termsForProbe(index: IDBIndex, key: string): Promise<Array<Stored<OfflineTerm>>> {
  const cached = lookupProbeCache.get(key);
  if (cached) return cached;
  const terms = await requestResult<Array<Stored<OfflineTerm>>>(index.getAll(IDBKeyRange.only(key)));
  lookupProbeCache.set(key, terms);
  return terms;
}

async function performInstall(apiBase: string, signal: AbortSignal): Promise<PackManifest> {
  const base = apiBase.replace(/\/$/, "");
  installStage = "Fetching the dictionary manifest";
  const manifestResponse = await fetch(`${base}/v1/dictionary-packs/current`, { cache: "no-store", signal });
  if (!manifestResponse.ok) throw new Error(await responseFailure("Dictionary manifest", manifestResponse));
  const manifest = (await manifestResponse.json()) as PackManifest;
  validateManifest(manifest);

  installStage = "Checking offline dictionary storage";
  const current = await dictionaryStatus();
  if (current.revision === manifest.contentRevision) {
    installProgress = 1;
    installStage = null;
    return manifest;
  }

  installStage = "Downloading the dictionary pack";
  const response = await fetch(manifest.downloadUrl, { cache: "no-store", signal });
  if (!response.ok) throw new Error(await responseFailure("Dictionary download", response));
  if (!response.body) throw new Error("This browser cannot stream the dictionary download.");
  const [importBranch, hashBranch] = response.body.tee();
  const digestPromise = sha256Stream(hashBranch, manifest.bytes, signal);

  installStage = "Opening offline dictionary storage";
  const db = await openDatabase();
  const generation = manifest.contentRevision;
  await clearGeneration(db, generation);
  try {
    installStage = "Decompressing and importing dictionary records";
    const stream = importBranch.pipeThrough(new DecompressionStream("gzip"));
    await importRecords(db, generation, stream, manifest, signal);
    installStage = "Verifying the dictionary checksum";
    const digest = await digestPromise;
    if (digest !== manifest.sha256) throw new Error("Dictionary checksum did not match. The previous dictionary is still active.");
    installStage = "Activating the offline dictionary";
    const previous = await meta<string>(db, "activeGeneration");
    if (previous && previous !== generation) await setMeta(db, "previousGeneration", previous);
    await setMeta(db, "activeGeneration", generation);
    await setMeta(db, "manifest", manifest);
    activeGenerationCache = generation;
    lookupProbeCache.clear();
    installProgress = 1;
    installStage = null;
    void cleanupOtherGenerations(db, new Set([generation, ...(previous ? [previous] : [])]));
    return manifest;
  } catch (error) {
    await digestPromise.catch(() => undefined);
    await clearGeneration(db, generation);
    throw error;
  }
}

function describeInstallError(error: unknown, stage: string | null): string {
  const name = error instanceof DOMException || error instanceof Error ? error.name : "Error";
  const message = error instanceof Error ? error.message : String(error);
  const detail = message && !/unexpected error occurred/i.test(message) ? message : name;
  return `${stage ?? "Dictionary installation"}: ${detail || "Unknown error"}`;
}

async function responseFailure(label: string, response: Response): Promise<string> {
  try {
    const problem = await response.json() as { detail?: unknown; title?: unknown };
    const detail = typeof problem.detail === "string" ? problem.detail : typeof problem.title === "string" ? problem.title : null;
    if (detail) return `${label}: ${detail}`;
  } catch {
    // Non-JSON responses fall back to the stable HTTP status below.
  }
  return `${label} failed (${response.status}).`;
}

async function importRecords(db: IDBDatabase, generation: string, stream: ReadableStream<Uint8Array>, manifest: PackManifest, signal: AbortSignal): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let headerSeen = false;
  let importedTerms = 0;
  let importedKanji = 0;
  let batch: Array<OfflineTerm | OfflineKanji> = [];
  const seenIds = new Set<string>();

  const flush = async () => {
    if (!batch.length) return;
    await writeBatch(db, generation, batch);
    batch = [];
    const expected = Math.max(1, manifest.counts.terms + manifest.counts.kanji);
    installProgress = 0.2 + 0.75 * ((importedTerms + importedKanji) / expected);
  };

  while (true) {
    if (signal.aborted) throw new DOMException("Dictionary installation cancelled.", "AbortError");
    const { value, done } = await reader.read();
    buffer += value ? decoder.decode(value, { stream: !done }) : decoder.decode();
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf("\n");
      if (!line) continue;
      const raw = JSON.parse(line) as { type?: string; schemaVersion?: number };
      if (signal.aborted) throw new DOMException("Dictionary installation cancelled.", "AbortError");
      if (raw.type === "header") {
        const header = raw as { type: string; schemaVersion?: number; languages?: unknown; source?: unknown };
        if (!exactKeys(header, ["type", "schemaVersion", "languages", "source"]) ||
            header.schemaVersion !== SUPPORTED_SCHEMA || !Array.isArray(header.languages) || !plainString(header.source) ||
            !["eng", "spa"].every((language) => (header.languages as unknown[]).includes(language))) {
          throw new Error(`Unsupported dictionary schema ${raw.schemaVersion}.`);
        }
        headerSeen = true;
      } else if (raw.type === "term") {
        const record = raw as OfflineTerm;
        validateTerm(record);
        if (seenIds.has(record.id)) throw new Error(`Dictionary contains duplicate record id ${record.id}.`);
        seenIds.add(record.id);
        batch.push(record);
        importedTerms += 1;
      } else if (raw.type === "kanji") {
        const record = raw as OfflineKanji;
        validateKanji(record);
        if (seenIds.has(record.id)) throw new Error(`Dictionary contains duplicate record id ${record.id}.`);
        seenIds.add(record.id);
        batch.push(record);
        importedKanji += 1;
      } else {
        throw new Error("Dictionary contains an unknown record type.");
      }
      if (batch.length >= IMPORT_BATCH) await flush();
    }
    if (done) break;
  }
  if (buffer.trim()) throw new Error("Dictionary ended with an incomplete record.");
  await flush();
  if (!headerSeen) throw new Error("Dictionary header is missing.");
  if (importedTerms !== manifest.counts.terms || importedKanji !== manifest.counts.kanji) {
    throw new Error("Dictionary record counts did not match its manifest.");
  }
}

async function writeBatch(db: IDBDatabase, generation: string, records: Array<OfflineTerm | OfflineKanji>): Promise<void> {
  const transaction = db.transaction(["terms", "kanji"], "readwrite");
  const terms = transaction.objectStore("terms");
  const kanji = transaction.objectStore("kanji");
  for (const record of records) {
    if (record.type === "term") {
      terms.put({ ...record, generation, pk: `${generation}\0${record.id}`, keys: lookupKeysFor(record, generation) });
    } else {
      kanji.put({ ...record, generation, pk: `${generation}\0${record.char}` });
    }
  }
  await transactionDone(transaction);
}

// The keys a term answers to, for the multiEntry index. Normalized, because
// every probe arrives normalized — a raw key like "Ｔシャツ" would be unreachable
// once a query becomes "Tシャツ". Generation-prefixed so one index spans the
// staged and active generations without them colliding.
function lookupKeysFor(record: OfflineTerm, generation: string): string[] {
  const keys = [record.headword, ...record.expressions.map((item) => item.text), ...record.readings.map((item) => item.text)]
    .map(normalize)
    .filter(Boolean)
    .map((key) => `${generation}\0${key}`);
  return [...new Set(keys)];
}

function openDatabase(): Promise<IDBDatabase> {
  if (databasePromise) return databasePromise;
  databasePromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = (event) => {
      try {
        const db = request.result;
        const transaction = request.transaction as IDBTransaction;
        if (typeof location !== "undefined" && /^(moz|chrome)-extension:$/.test(location.protocol)) {
          console.info("[Shirabe dictionary] upgrading IndexedDB", { name: DB_NAME, from: event.oldVersion, to: DB_VERSION });
        }
        const metaStore = ensureStore(db, transaction, "meta", "key");
        ensureIndex(metaStore, "key", "key", { unique: true });
        const terms = ensureStore(db, transaction, "terms", "pk");
        ensureIndex(terms, "generation", "generation");
        // Every writing/reading a term answers to, indexed straight off the
        // record. A separate lookups table cost a row per key — 1.9M extra puts
        // on the full pack, ~2 of every 3 writes during install — and forced
        // each probe into two queries (keys → ids → records). multiEntry is the
        // same join, maintained by the engine, and returns the record itself.
        ensureIndex(terms, "lookupKeys", "keys", { multiEntry: true });
        const kanji = ensureStore(db, transaction, "kanji", "pk");
        ensureIndex(kanji, "generation", "generation");
      } catch (error) {
        console.error("[Shirabe dictionary] IndexedDB upgrade handler failed", error);
        throw error;
      }
    };
    request.onsuccess = () => {
      request.result.onversionchange = () => {
        request.result.close();
        databasePromise = null;
        activeGenerationCache = null;
        lookupProbeCache.clear();
      };
      resolve(request.result);
    };
    request.onerror = () => {
      databasePromise = null;
      reject(tracedError("IndexedDB open request failed", request.error));
    };
    request.onblocked = () => {
      databasePromise = null;
      reject(new Error("Close other Shirabe Reader pages so offline dictionary storage can be upgraded."));
    };
  });
  return databasePromise;
}

function tracedError(context: string, error: unknown): Error {
  const candidate = error as (Error & { code?: unknown }) | null | undefined;
  const name = candidate?.name || typeof error;
  const message = candidate?.message || String(error ?? "no browser error was provided");
  const code = candidate?.code == null ? "" : ` code=${String(candidate.code)}`;
  const stack = candidate?.stack ? `\noriginal stack:\n${candidate.stack}` : "";
  const traced = new Error(`${context}: ${name}${code}: ${message}${stack}`) as Error & { cause?: unknown };
  traced.cause = error;
  return traced;
}

function ensureStore(db: IDBDatabase, transaction: IDBTransaction, name: string, keyPath: string): IDBObjectStore {
  return db.objectStoreNames.contains(name)
    ? transaction.objectStore(name)
    : db.createObjectStore(name, { keyPath });
}

function ensureIndex(store: IDBObjectStore, name: string, keyPath: string | string[], options?: IDBIndexParameters): void {
  if (!store.indexNames.contains(name)) store.createIndex(name, keyPath, options);
}

async function meta<T>(db: IDBDatabase, key: string): Promise<T | undefined> {
  const row = await requestResult<{ key: string; value: T } | undefined>(db.transaction("meta").objectStore("meta").get(key));
  return row?.value;
}

async function activeGeneration(db: IDBDatabase): Promise<string | undefined> {
  if (activeGenerationCache !== null) return activeGenerationCache;
  activeGenerationCache = await meta<string>(db, "activeGeneration");
  return activeGenerationCache;
}

async function setMeta(db: IDBDatabase, key: string, value: unknown): Promise<void> {
  const transaction = db.transaction("meta", "readwrite");
  transaction.objectStore("meta").put({ key, value });
  await transactionDone(transaction);
}

async function getByPk<T>(db: IDBDatabase, store: string, key: string): Promise<T | undefined> {
  return requestResult(db.transaction(store).objectStore(store).get(key));
}

async function clearGeneration(db: IDBDatabase, generation: string): Promise<void> {
  for (const store of ["terms", "kanji"]) await deleteByIndex(db, store, generation, false);
}

async function cleanupOtherGenerations(db: IDBDatabase, retained: Set<string>): Promise<void> {
  for (const store of ["terms", "kanji"]) await deleteOutsideGenerations(db, store, retained);
}

function deleteOutsideGenerations(db: IDBDatabase, storeName: string, retained: Set<string>): Promise<void> {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(storeName, "readwrite");
    const request = transaction.objectStore(storeName).index("generation").openCursor();
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return;
      if (!retained.has(String(cursor.key))) cursor.delete();
      cursor.continue();
    };
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error("Dictionary cleanup failed."));
  });
}

function deleteByIndex(db: IDBDatabase, storeName: string, generation: string, inverse: boolean): Promise<void> {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(storeName, "readwrite");
    const request = transaction.objectStore(storeName).index("generation").openCursor();
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return;
      const matches = cursor.key === generation;
      if ((inverse && !matches) || (!inverse && matches)) cursor.delete();
      cursor.continue();
    };
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error("Dictionary cleanup failed."));
    transaction.onabort = () => reject(transaction.error ?? new Error("Dictionary cleanup was aborted."));
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error("Dictionary database transaction failed."));
    transaction.onabort = () => reject(transaction.error ?? new Error("Dictionary database transaction was aborted."));
  });
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Dictionary database request failed."));
  });
}


function validateManifest(manifest: PackManifest): void {
  if (manifest.schemaVersion !== SUPPORTED_SCHEMA) throw new Error(`This dictionary needs a newer Shirabe Reader (schema ${manifest.schemaVersion}).`);
  if (!/^\d+\.\d+\.\d+$/.test(manifest.minimumExtensionVersion) || compareVersions(manifest.minimumExtensionVersion, __EXTENSION_VERSION__) > 0) {
    throw new Error(`This dictionary needs Shirabe Reader ${manifest.minimumExtensionVersion} or newer.`);
  }
  const download = httpUrl(manifest.downloadUrl);
  if (!Number.isInteger(manifest.buildRecipeVersion) || manifest.buildRecipeVersion < 1 ||
      !/^[a-f0-9]{64}$/.test(manifest.sha256) || !download || !["http:", "https:"].includes(download.protocol) ||
      manifest.compression !== "gzip" || manifest.mediaType !== "application/x-ndjson" ||
      !plainString(manifest.contentRevision) || !Number.isFinite(Date.parse(manifest.builtAt)) ||
      !/^[A-Za-z0-9._-]+\.ndjson\.gz$/.test(manifest.artifact) ||
      !Number.isSafeInteger(manifest.bytes) || manifest.bytes <= 0 || !validCounts(manifest.counts) ||
      !Array.isArray(manifest.languages) || !["eng", "spa"].every((language) => manifest.languages.includes(language)) ||
      !Array.isArray(manifest.dictionaries) || manifest.dictionaries.some((item) => !plainString(item.slug) || (item.version != null && !plainString(item.version))) ||
      !stringArray(manifest.modifications) || !Array.isArray(manifest.sources) ||
      manifest.sources.some((source) => !plainString(source.name) || !plainString(source.license) || !httpUrl(source.url) || (source.licenseUrl != null && !httpUrl(source.licenseUrl)))) {
    throw new Error("Dictionary manifest is invalid.");
  }
}

function validCounts(value: unknown): value is PackManifest["counts"] {
  if (!value || typeof value !== "object" || Array.isArray(value) || !exactKeys(value, ["terms", "kanji"])) return false;
  const counts = value as Record<string, unknown>;
  return [counts.terms, counts.kanji].every((count) => Number.isSafeInteger(count) && Number(count) >= 0);
}

function compareVersions(left: string, right: string): number {
  const a = left.split(".").map(Number);
  const b = right.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return 0;
}

function validateTerm(term: OfflineTerm): void {
  const allowed = new Set(["type", "id", "dictionary", "headword", "expressions", "readings", "senses", "pitch", "frequencies", "jlpt"]);
  if (Object.keys(term).some((key) => !allowed.has(key)) || !plainString(term.id) || !plainString(term.dictionary) || !plainString(term.headword) ||
      !Array.isArray(term.expressions) || !term.expressions.length || term.expressions.some((item) => !exactKeys(item, ["text", "script", "common", "tags"]) || !plainString(item.text) || !plainString(item.script) || typeof item.common !== "boolean" || !stringArray(item.tags)) ||
      !Array.isArray(term.readings) || term.readings.some((item) => !exactKeys(item, ["text", "kind"]) || !plainString(item.text) || !plainString(item.kind)) ||
      !Array.isArray(term.senses) || !term.senses.length || term.senses.some((sense) => !exactKeys(sense, ["glosses", "partsOfSpeech", "fields", "misc", "dialects", "restrictions"]) || !glossMap(sense.glosses, new Set(["eng", "spa"])) || !stringArray(sense.partsOfSpeech) || !stringArray(sense.fields) || !stringArray(sense.misc) || !stringArray(sense.dialects) || !stringArray(sense.restrictions)) ||
      (term.pitch != null && (!Array.isArray(term.pitch) || term.pitch.some((item) => !exactKeys(item, ["text", "reading", "downstep", "audioUrl"]) || !plainString(item.text) || !plainString(item.reading) || !Number.isInteger(item.downstep) || !r2AudioUrl(item.audioUrl)))) ||
      (term.frequencies != null && (!Array.isArray(term.frequencies) || term.frequencies.some((item) => !exactKeys(item, ["source", "rank"]) || !plainString(item.source) || !Number.isFinite(item.rank)))) ||
      (term.jlpt != null && (!Number.isInteger(term.jlpt) || term.jlpt < 1 || term.jlpt > 5))) {
    throw new Error("Dictionary term record is invalid.");
  }
  rejectUnsafeStructuredContent(term);
}

function validateKanji(kanji: OfflineKanji): void {
  const allowed = new Set(["type", "id", "char", "readings", "meanings", "strokes", "grade", "jlpt", "frequency"]);
  if (Object.keys(kanji).some((key) => !allowed.has(key)) || !plainString(kanji.id) || !plainString(kanji.char) || [...kanji.char].length !== 1 ||
      !glossMap(kanji.readings, new Set(["on", "kun", "nanori", "pinyin", "korean_r", "korean_h", "vietnam"])) ||
      !glossMap(kanji.meanings, new Set(["eng", "spa"])) ||
      [kanji.strokes, kanji.grade, kanji.jlpt, kanji.frequency].some((value) => value != null && (!Number.isInteger(value) || value < 0))) {
    throw new Error("Dictionary kanji record is invalid.");
  }
  rejectUnsafeStructuredContent(kanji);
}

function plainString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 20_000 && !value.includes("\0");
}

function httpUrl(value: unknown): URL | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) ? url : null;
  } catch {
    return null;
  }
}

function r2AudioUrl(value: unknown): boolean {
  const url = httpUrl(value);
  return url?.protocol === "https:" && url.hostname === "cdn.shirabe.org" && url.pathname.startsWith("/audio/");
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.length <= 5_000 && value.every(plainString);
}

function glossMap(value: unknown, keys: Set<string>): value is Record<string, string[]> {
  return !!value && typeof value === "object" && !Array.isArray(value) && Object.entries(value).every(([key, items]) => keys.has(key) && stringArray(items));
}

function exactKeys(value: object, allowed: string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

// `url(` and `on…=` must only match a real CSS/HTML construct. Without a leading
// word boundary they also match ordinary glosses — "to hurl (at)" and "to curl
// (hair)" both contain "url (" — which aborted the whole install on four real
// JMdict entries.
const UNSAFE_STRUCTURED_CONTENT = /<\/?[a-z][^>]*>|\bon\w+\s*=|javascript:|data:text\/html|@import\b|\burl\s*\(/i;

function rejectUnsafeStructuredContent(value: unknown): void {
  if (UNSAFE_STRUCTURED_CONTENT.test(JSON.stringify(value))) {
    throw new Error("Dictionary record contains executable structured content.");
  }
}

async function sha256Stream(stream: ReadableStream<Uint8Array>, expectedBytes: number, signal: AbortSignal): Promise<string> {
  const hash = createSha256.create();
  const reader = stream.getReader();
  let received = 0;
  while (true) {
    if (signal.aborted) throw new DOMException("Dictionary installation cancelled.", "AbortError");
    const { value, done } = await reader.read();
    if (done) break;
    hash.update(value);
    received += value.byteLength;
    installProgress = Math.max(installProgress, 0.18 * Math.min(1, received / Math.max(1, expectedBytes)));
  }
  return bytesToHex(hash.digest());
}

function normalize(text: string): string {
  return text.normalize("NFKC").trim();
}

function prefixesLongestFirst(text: string): string[] {
  const chars = [...text];
  return Array.from({ length: chars.length }, (_, index) => chars.slice(0, chars.length - index).join(""));
}

function score(hit: LookupHit, source: string): number {
  const expressions = hit.term.expressions;
  const exact = expressions.some((expression) => expression.text === source) ? 10_000 : 0;
  const common = expressions.some((expression) => expression.common) ? 1_000 : 0;
  const frequency = hit.term.frequencies?.length ? Math.max(0, 1_000 - Math.min(...hit.term.frequencies.map((item) => item.rank)) / 100) : 0;
  return exact + common + frequency + hit.prefixLength * 10 - hit.candidate.reasons.length;
}

// One meaning block per language, in the reader's order — the same walk as the
// web's WordCard#build_meanings over Locales.source_stack_for. Within a block a
// sense with no gloss in that language falls back to the languages after it,
// English last (Locales.with_english_fallback), so a block never renders blank.
function termDefinition(hit: LookupHit, languages: readonly GlossLanguage[], apiBase: string): Definition {
  const term = hit.term;
  const blocks = languages.length ? languages : ["eng" as const];
  const applicable = term.senses.filter((sense) => !sense.restrictions.length || sense.restrictions.includes(hit.surface) || sense.restrictions.includes(term.headword));
  const senses: Sense[] = blocks.flatMap((language, index) => {
    // Exactly WordCard#fallback_db_langs_after: the languages *after* this one
    // in the reader's stack, English last, minus this block's own language. The
    // fallback fills a sense inside the block — it never adds a block, which is
    // why one language stays one language.
    const fallbacks = withEnglishFallback(blocks.slice(index + 1)).filter((code) => code !== language);
    return applicable.flatMap((sense) => {
      const glosses = [language, ...fallbacks].map((code) => sense.glosses[code]).find((list) => list?.length);
      if (!glosses) return [];
      return [{
        source: `${GLOSS_LABELS[language]} · ${dictionaryName(term.dictionary)}`,
        partsOfSpeech: sense.partsOfSpeech,
        tags: [...sense.fields, ...sense.misc, ...sense.dialects],
        glosses,
      }];
    });
  });
  const reading = term.readings.find((item) => item.kind === "kana")?.text ?? term.readings[0]?.text ?? null;
  const exactPitch = (term.pitch ?? []).filter((item) => item.text === term.headword && item.reading === reading);
  const displayedPitch = exactPitch.length || term.headword === reading
    ? exactPitch
    : (term.pitch ?? []).filter((item) => item.text === reading && item.reading === reading);
  return {
    headword: term.headword,
    reading,
    url: `${apiBase.replace(/\/$/, "")}/word/${encodeURIComponent(term.headword)}`,
    common: term.expressions.some((item) => item.common),
    jlpt: term.jlpt ? `N${term.jlpt}` : null,
    frequency: term.frequencies?.length ? Math.min(...term.frequencies.map((item) => item.rank)) : null,
    pitch: displayedPitch.map((item) => ({ downstep: item.downstep, audioUrl: item.audioUrl })),
    senses,
    examples: [],
    sourceForm: hit.surface,
    inflection: hit.candidate.reasons,
    offline: true,
  };
}

// KANJIDIC ships pinyin, Korean and Vietnamese readings alongside the Japanese
// ones, and lists them first. Taking whatever came first showed 猫 as "mao1"
// rather than ビョウ — a Chinese reading on 96% of the pack's kanji. Only on/kun
// are Japanese; kun carries okurigana after a dot (た.べる), which is not part of
// the character's own reading.
function kanjiReading(readings: OfflineKanji["readings"]): string | null {
  return readings.on?.[0] ?? readings.kun?.[0]?.split(".")[0] ?? null;
}

function kanjiDefinition(kanji: Stored<OfflineKanji>, languages: readonly GlossLanguage[], apiBase: string): Definition {
  const order = withEnglishFallback(languages);
  const language = order.find((code) => kanji.meanings[code]?.length) ?? "eng";
  const glosses = kanji.meanings[language] ?? [];
  return {
    headword: kanji.char,
    reading: kanjiReading(kanji.readings),
    url: `${apiBase.replace(/\/$/, "")}/kanji/${encodeURIComponent(kanji.char)}`,
    common: false,
    jlpt: kanji.jlpt ? `N${kanji.jlpt}` : null,
    frequency: kanji.frequency ?? null,
    pitch: [],
    senses: [{ source: `${GLOSS_LABELS[language]} · KANJIDIC2`, partsOfSpeech: [], tags: [], glosses }],
    examples: [],
    offline: true,
  };
}

function dictionaryName(slug: string): string {
  return ({ jmdict: "JMdict", jmnedict: "JMnedict" } as Record<string, string>)[slug] ?? slug;
}

// Full-width alphanumerics are ordinary Japanese orthography and start real
// headwords (Ｔシャツ, ２ちゃんねる, ＣＤプレーヤー), so the scanner must treat them as
// word characters. Both patterns must describe the same set: one finds where a
// word can start, the other consumes the run of text between words.
const JAPANESE_CHARS = String.raw`々〇〻\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}０-９Ａ-Ｚａ-ｚ`;
const JAPANESE_HEAD = new RegExp(`^[${JAPANESE_CHARS}]`, "u");
const NOT_JAPANESE_RUN = new RegExp(`^[^${JAPANESE_CHARS}]+`, "u");

function isKanji(text: string): boolean {
  return /[一-龯㐀-䶿]/u.test(text);
}

function startsJapanese(text: string): boolean {
  return JAPANESE_HEAD.test(text);
}
