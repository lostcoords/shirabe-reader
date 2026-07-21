import { convertVariants } from "kanji-processor";
import { deinflect, inflectionLabel, posConditionFlags } from "./deinflect.js";
import { posLabels, tagLabels } from "./jmdict-tags.js";
import { GLOSS_LABELS, withEnglishFallback, type GlossLanguage } from "./languages.js";
import type { Definition, ParsedToken, Sense } from "./types.js";
import { sha256 as createSha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";

declare const __EXTENSION_VERSION__: string;

// The physical name carries a schema suffix so a machine holding an earlier
// dev-built database opens a clean one rather than a shape this code cannot
// read. Superseded databases are not migrated: a generation is rebuilt from the
// pack, which is always re-downloadable.
const DB_NAME = "shirabe-offline-dictionary-v4";
const DB_VERSION = 1;
const SUPPORTED_SCHEMA = 3;
// Longest term the greedy longest-match will probe from any position — the
// scanner's caret window (dom-text.ts `maxChars`) mirrors it. Covers long
// compounds/expressions; unknown katakana runs are coalesced (`unknownRun`)
// rather than probed char-by-char, so raising this doesn't add per-run cost.
const MAX_SCAN_CHARS = 32;
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
  // `appliesTo` carries JMdict's per-writing restriction, present only when it
  // narrows: よいてんき spells 良い天気 and よい天気, but never いい天気.
  readings: Array<{ text: string; kind: string; appliesTo?: string[] }>;
  senses: OfflineSense[];
  pitch?: Array<{ text: string; reading: string; downstep: number; audioUrl: string }>;
  frequencies?: Array<{ source: string; text: string; reading: string | null; rank: number }>;
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
type Candidate = { text: string; reasons: string[]; conditions?: number; processingCost?: number };
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
let installApiBase: string | null = null;
let databasePromise: Promise<IDBDatabase> | null = null;
let activeGenerationCache: string | undefined | null = null;
let keepAliveTimer: ReturnType<typeof setInterval> | null = null;
let lastSnapshotWrite = 0;
const lookupProbeCache = new BoundedCache<Array<Stored<OfflineTerm>>>(4_000);

// Survives popup close and brief MV3 worker restarts so reopening the action
// can show the in-progress bar instead of the idle Install button.
const INSTALL_STATE_KEY = "dictionaryInstallState";
type InstallStateSnapshot = {
  installing: boolean;
  progress: number;
  stage: string | null;
  error: string | null;
  apiBase: string | null;
  updatedAt: number;
};

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
  const snapshot = installPromise ? null : await readInstallSnapshot();
  const installing = installPromise != null || !!snapshot?.installing;
  return {
    installed: !!active && !!manifest,
    revision: manifest?.contentRevision ?? null,
    builtAt: manifest?.builtAt ?? null,
    bytes: manifest?.bytes ?? 0,
    terms: manifest?.counts.terms ?? 0,
    kanji: manifest?.counts.kanji ?? 0,
    installing,
    progress: installPromise ? installProgress : (snapshot?.progress ?? installProgress),
    stage: installPromise ? installStage : (snapshot?.stage ?? installStage),
    error: installPromise ? installError : (snapshot?.error ?? installError),
    storageBytes: estimate?.usage ?? null,
    sources: manifest?.sources ?? [],
    lastCheckedAt: lastCheckedAt ?? null,
  };
}

/** If a previous worker died mid-install, pick the job back up. */
export function resumeInterruptedDictionaryInstall(apiBase: string): void {
  if (installPromise) return;
  void readInstallSnapshot().then((snapshot) => {
    if (!snapshot?.installing) return;
    void installDictionary(snapshot.apiBase || apiBase).catch(() => undefined);
  });
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
  installApiBase = apiBase.replace(/\/$/, "");
  installController = new AbortController();
  startInstallKeepAlive();
  void writeInstallSnapshot(true);
  installPromise = performInstall(apiBase, installController.signal)
    .catch((error: unknown) => {
      installError = error instanceof DOMException && error.name === "AbortError" ? null : describeInstallError(error, installStage);
      if (installError && typeof location !== "undefined" && /^(moz|chrome)-extension:$/.test(location.protocol)) {
        console.error("[Shirabe] Dictionary installation failed", { stage: installStage, error });
      }
      throw error;
    })
    .finally(() => {
      const failed = installError != null;
      installPromise = null;
      installController = null;
      installApiBase = null;
      stopInstallKeepAlive();
      if (failed) void writeInstallSnapshot(false);
      else void clearInstallSnapshot();
    });
  return installPromise;
}

export function cancelDictionaryInstall(): void {
  installController?.abort();
  // Snapshot stays "installing" until the abort settles in finally; clear early so
  // a reopened popup does not flash a zombie progress bar after Cancel.
  installStage = null;
  installProgress = 0;
  void clearInstallSnapshot();
}

function startInstallKeepAlive(): void {
  if (keepAliveTimer != null) return;
  // MV3 workers go idle ~30s after the last extension event. Dictionary import
  // is mostly IndexedDB and can outlive a closed popup; ping the runtime so the
  // worker (and in-memory installPromise / progress) stay alive.
  keepAliveTimer = setInterval(() => {
    const runtime = extensionRuntime();
    void runtime?.getPlatformInfo?.()?.then?.(() => undefined, () => undefined);
    void writeInstallSnapshot(true);
  }, 20_000);
}

function stopInstallKeepAlive(): void {
  if (keepAliveTimer == null) return;
  clearInterval(keepAliveTimer);
  keepAliveTimer = null;
}

function reportInstallProgress(progress: number, stage?: string | null): void {
  installProgress = progress;
  if (stage !== undefined) installStage = stage;
  const now = Date.now();
  // Throttle storage writes; the popup polls ~3×/s and does not need every tick.
  if (now - lastSnapshotWrite < 400) return;
  lastSnapshotWrite = now;
  void writeInstallSnapshot(true);
}

async function writeInstallSnapshot(installing: boolean): Promise<void> {
  const storage = extensionStorage();
  if (!storage) return;
  const snapshot: InstallStateSnapshot = {
    installing,
    progress: installProgress,
    stage: installStage,
    error: installError,
    apiBase: installApiBase,
    updatedAt: Date.now(),
  };
  try {
    await storage.set({ [INSTALL_STATE_KEY]: snapshot });
  } catch (error) {
    console.error("[Shirabe dictionary] could not persist install progress", error);
  }
}

async function clearInstallSnapshot(): Promise<void> {
  const storage = extensionStorage();
  if (!storage) return;
  try {
    await storage.remove(INSTALL_STATE_KEY);
  } catch {
    // Best-effort; a stale snapshot is cleared on the next successful install.
  }
}

async function readInstallSnapshot(): Promise<InstallStateSnapshot | null> {
  const storage = extensionStorage();
  if (!storage) return null;
  try {
    const stored = await storage.get(INSTALL_STATE_KEY);
    const value = stored[INSTALL_STATE_KEY];
    if (!value || typeof value !== "object") return null;
    const snapshot = value as InstallStateSnapshot;
    if (typeof snapshot.installing !== "boolean") return null;
    // Drop abandoned snapshots (worker died days ago without cleanup).
    if (snapshot.updatedAt && Date.now() - snapshot.updatedAt > 6 * 60 * 60 * 1000) {
      void clearInstallSnapshot();
      return null;
    }
    return snapshot;
  } catch {
    return null;
  }
}

function extensionStorage(): { get: (key: string) => Promise<Record<string, unknown>>; set: (items: Record<string, unknown>) => Promise<void>; remove: (key: string) => Promise<void> } | null {
  const api = (typeof globalThis !== "undefined" && ((globalThis as { browser?: { storage?: { session?: unknown; local?: unknown } }; chrome?: { storage?: { session?: unknown; local?: unknown } } }).browser
    || (globalThis as { chrome?: { storage?: { session?: unknown; local?: unknown } } }).chrome)) || null;
  const storage = api?.storage as { session?: { get: (key: string) => Promise<Record<string, unknown>>; set: (items: Record<string, unknown>) => Promise<void>; remove: (key: string) => Promise<void> }; local?: { get: (key: string) => Promise<Record<string, unknown>>; set: (items: Record<string, unknown>) => Promise<void>; remove: (key: string) => Promise<void> } } | undefined;
  // Prefer session (cleared when the browser restarts) but fall back to local.
  return storage?.session ?? storage?.local ?? null;
}

function extensionRuntime(): { getPlatformInfo?: () => Promise<unknown> } | null {
  const api = (typeof globalThis !== "undefined" && ((globalThis as { browser?: { runtime?: { getPlatformInfo?: () => Promise<unknown> } }; chrome?: { runtime?: { getPlatformInfo?: () => Promise<unknown> } } }).browser
    || (globalThis as { chrome?: { runtime?: { getPlatformInfo?: () => Promise<unknown> } } }).chrome)) || null;
  return api?.runtime ?? null;
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
  void clearInstallSnapshot();
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

    const definition = await bestWithLookahead(db, generation, rest, languages, apiBase);
    if (!definition?.sourceForm) {
      const surface = unknownRun(rest);
      tokens.push({ start: position, length: surface.length, surface, reading: null, lemma: surface, pos: "", content: false, state: "none" });
      position += surface.length;
      continue;
    }
    const surface = definition.sourceForm;
    // Number + counter: JMdict lists some of these as their own noun (七本 "seven
    // long cylindrical things", 六人 "six people") but not others (三匹 is a name
    // only), so matching the dictionary literally is inconsistent AND hides the
    // counter the learner actually needs. Emit the numeral and let the counter
    // match on the next pass, so 七本 reads 七 · 本 like 三匹 already does — the
    // extension's equivalent of the web's counter parts (tracker 2026-07-14).
    const numeral = counterNumeralLength(surface);
    if (numeral && await isCounter(db, generation, surface.slice(numeral))) {
      const head = surface.slice(0, numeral);
      tokens.push({
        start: position, length: head.length, surface: head, reading: null,
        lemma: head, pos: "", content: true, state: "none",
      });
      position += head.length;
      continue;
    }
    tokens.push({
      start: position, length: surface.length, surface, reading: definition.reading,
      lemma: definition.headword, pos: definition.senses[0]?.partsOfSpeech[0] ?? "",
      content: true, state: "none", frequency: definition.frequency,
    });
    position += surface.length;
  }
  return tokens;
}

const KATAKANA = /[ァ-ヶ]/;
const HAS_KANJI = /[\p{Script=Han}]/u;
const EMPHATIC = new Set([0x3063, 0x30c3, 0x30fc]); // っ ッ ー — the elongation marks
const HAS_EMPHATIC = /[っッー]/;

const katakanaToHiragana = (text: string): string =>
  text.replace(/[ァ-ヶ]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0x60));

// Port of Yomitan's collapseEmphaticSequences (full collapse): interior elongation
// marks (っ/ッ/ー) are dropped, so すっっごーーい → すごい and すっごい → すごい.
// Leading/trailing elongation is left alone. Legit sokuon (学校 → がこう) also
// collapses to a spurious variant, but ranking prefers the verbatim match.
function collapseEmphatic(text: string): string {
  if (!HAS_EMPHATIC.test(text)) return text; // fast path: no marks, no allocation
  const chars = [...text];
  let left = 0;
  while (left < chars.length && EMPHATIC.has(chars[left].codePointAt(0) as number)) left += 1;
  let right = chars.length - 1;
  while (right >= 0 && EMPHATIC.has(chars[right].codePointAt(0) as number)) right -= 1;
  if (left > right) return text; // all elongation
  const middle = chars.slice(left, right + 1).filter((ch) => !EMPHATIC.has(ch.codePointAt(0) as number));
  return chars.slice(0, left).join("") + middle.join("") + chars.slice(right + 1).join("");
}

// Length of the leading numeral in a possible number+counter compound (七本 → 1),
// or 0 when the surface does not start with a number. Kanji numerals and digits
// both count; 十/百/千 appear inside larger numbers (三十本) so they are included.
const COUNTER_NUMERAL = /^[0-9０-９一二三四五六七八九十百千万億兆]+/;
function counterNumeralLength(surface: string): number {
  const match = surface.match(COUNTER_NUMERAL);
  if (!match) return 0;
  // Need something left over to be the counter, and the numeral must not BE the
  // whole word (三十 on its own is a number, not a counter compound).
  return match[0].length < surface.length ? match[0].length : 0;
}

// Is `text` a counter word in its own right (本, 人, 匹, 時)? Checked against the
// dictionary rather than a hardcoded list, so the pack stays the source of truth.
async function isCounter(db: IDBDatabase, generation: string, text: string): Promise<boolean> {
  if (!text) return false;
  // Every entry for the spelling, not just the best-ranked one: 人 leads as the
  // noun ひと, and its counter sense にん would be invisible to a lookup that only
  // reads the winner. Raw JMdict `ctr`, since these are unmapped pack codes.
  const hits = await hitsForCandidates(db, generation, [{ prefix: text, candidate: { text, reasons: [] } }], false);
  return hits.some((hit) => hit.term.senses.some((sense) => sense.partsOfSpeech.includes("ctr")));
}

// The spellings to probe for one on-page surface: the verbatim text plus its
// script-folded / elongation-collapsed forms, each tagged with how many text
// transforms it took (0 = verbatim). Emphasis katakana (スゴイ→すごい) and stretched
// kana (すっごーい→すごい) are pervasive in captions/subtitles yet stored in JMdict as
// plain hiragana readings, so without folding they miss and become unknown runs.
// The processingCost lets ranking keep a coincidental folded homophone from
// beating the literal word. We fold katakana→hiragana (readings are hiragana in
// the pack, so this needs no reindex) but not the rare inverse, to bound probes.
export function lookupVariants(prefix: string): Array<{ text: string; processingCost: number }> {
  const variants = [{ text: prefix, processingCost: 0 }];
  // Linear scan rather than a Set: this runs for every probed prefix of every
  // position, and there are at most four variants, so the allocation costs more
  // than the lookup saves.
  const add = (text: string, cost: number): void => {
    if (!text || variants.some((variant) => variant.text === text)) return;
    variants.push({ text, processingCost: cost });
  };
  // Old/variant kanji (旧字体・異体字) standardize to the modern form — 萬→万, 國→国 —
  // which NFKC does not do (they are distinct unified ideographs). Safe at any
  // length: it only rewrites kanji, so it can't invent a kana word.
  if (HAS_KANJI.test(prefix)) add(convertVariants(prefix), 1);
  // A single mora is never an emphasis (スゴイ) or stretched (すっごい) form, but a
  // lone katakana ミ would fold to み and deinflect to 見る — so only vary length ≥ 2.
  if ([...prefix].length < 2) return variants;
  if (KATAKANA.test(prefix)) add(katakanaToHiragana(prefix), 1);
  const collapsed = collapseEmphatic(prefix);
  if (collapsed !== prefix) {
    add(collapsed, 1);
    if (KATAKANA.test(collapsed)) add(katakanaToHiragana(collapsed), 2);
  }
  return variants;
}

// Common auxiliary verbs that attach to a te-form (授けて+いただく, 読んで+しまう).
// They are separate verbs, not inflections, so the deinflector cannot reach them —
// but a long inflection chain CAN eat into their head (授けていた steals the い from
// いただく), which is where a purely greedy longest match goes wrong.
const TE_AUXILIARIES = ["いただく", "いただける", "くださる", "ください", "もらう", "もらえる", "くれる", "あげる", "やる", "しまう", "おく", "みる", "いく", "くる", "ある", "いる"];

// Greedy longest-match, with one step of lookahead. The longest reading of a span
// is usually right, but not always: 授けていただく offers the valid 5-char 授けていた
// (授ける + ている + た), which beats the correct 3-char 授けて and strands だく.
// Both readings are legal Japanese; what distinguishes them is what comes NEXT.
//
// So when the best match is followed by a te-form auxiliary that it has bitten
// into, prefer the shorter match that leaves the auxiliary whole. This is a
// deliberately narrow rule — it only fires when a shorter alternative ends at a
// て/で boundary AND the remainder then starts with a known auxiliary — rather
// than general lattice scoring, which is what Sudachi does and we cannot afford.
async function bestWithLookahead(db: IDBDatabase, generation: string, rest: string, languages: readonly GlossLanguage[], apiBase: string): Promise<Definition | null> {
  const source = rest.slice(0, MAX_SCAN_CHARS);
  const best = await lookupInDatabase(db, generation, source, languages, apiBase, true);
  const matched = best?.sourceForm;
  if (!matched || matched.length < 3) return best;

  // Fire only when the winning span ends STRICTLY INSIDE a following auxiliary —
  // that is the "bitten into it" case. 授けていただく: cutting at 授けて leaves
  // いただく (3→7) while the match ends at 5, inside it — so it bit in, and the
  // shorter reading wins. 書いている: cutting at 書いて leaves いる (3→5) and the
  // match ends at exactly 5, consuming the auxiliary cleanly — that is the
  // progressive, one token, and must be left alone.
  for (let cut = matched.length - 1; cut >= 2; cut -= 1) {
    if (matched[cut - 1] !== "て" && matched[cut - 1] !== "で") continue;
    const remainder = rest.slice(cut);
    const auxiliary = TE_AUXILIARIES.find((candidate) => remainder.startsWith(candidate));
    if (!auxiliary) continue;
    if (matched.length >= cut + auxiliary.length) continue; // consumed it whole — leave it
    const shorter = await lookupInDatabase(db, generation, matched.slice(0, cut), languages, apiBase, true);
    // Only take the shorter reading if it actually covers the te-form span.
    if (shorter?.sourceForm?.length === cut) return shorter;
  }

  return best;
}

async function lookupInDatabase(db: IDBDatabase, generation: string, source: string, languages: readonly GlossLanguage[], apiBase: string, contextual = false): Promise<Definition | null> {
  const prefixes = prefixesLongestFirst(source);
  // Exact prefixes first: IndexedDB reads run concurrently, and this is the
  // overwhelmingly common case. Each prefix is probed in its verbatim spelling
  // and its folded/collapsed variants so emphasis katakana and stretched kana
  // still reach their dictionary entry.
  const exactHits = await hitsForCandidates(db, generation, prefixes.flatMap((prefix) =>
    lookupVariants(prefix).map((variant) => ({
      prefix, candidate: { text: variant.text, reasons: [], processingCost: variant.processingCost },
    }))), !contextual);

  // Deinflecting only when nothing matched exactly loses to any shorter entry
  // that happens to be a real word: 読みませんでした matched the noun 読み and never
  // reached 読む; 高くなかった matched 高 instead of 高い. Only a prefix longer than
  // the exact match can improve on it, so deinflect just those — keeping
  // longest-match semantics without paying for deinflection on every lookup.
  // Measure the exact match against hits we would actually USE. A spurious exact
  // match — 有益, a name read あります — is not contextually confident, but counting
  // it here made the span look covered and skipped deinflecting あります → ある, so
  // the sentence fell back to あり + ます. Only a hit that could win may suppress
  // deinflection of its own span.
  const usableExact = contextual ? exactHits.filter(contextuallyConfident) : exactHits;
  const longestExact = usableExact.reduce((length, hit) => Math.max(length, hit.prefixLength), 0);
  const longerPrefixes = prefixes.filter((prefix) => [...prefix].length > longestExact);
  const deinflectedHits = longerPrefixes.length
    ? await hitsForCandidates(db, generation, longerPrefixes.flatMap((prefix) =>
      lookupVariants(prefix).flatMap((variant) =>
        deinflect(variant.text).map((found) => ({
          prefix,
          candidate: { text: found.term, reasons: found.inflections.map(inflectionLabel), conditions: found.conditions, processingCost: variant.processingCost },
        })))))
    : [];

  if (contextual) {
    const confident = [...deinflectedHits, ...exactHits].filter(contextuallyConfident);
    if (confident.length) {
      confident.sort(contextualCompare);
      return termDefinition(confident[0], languages, apiBase);
    }
  }

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
  longestOnly = true,
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
    terms: (await termsForProbe(keys, `${generation}\0${normalize(probe.candidate.text)}`))
      .filter((term) => posSatisfiesInflection(term, probe.candidate)),
  })));
  const longest = resolved.find((probe) => probe.terms.length)?.prefix;
  if (!longest) return [];
  const seen = new Set<string>();
  return resolved
    .filter((probe) => (!longestOnly || probe.prefix === longest) && probe.terms.length)
    .flatMap((probe) => probe.terms.flatMap((term) => {
      // Keyed by the CANDIDATE too, not just the prefix: a text-processor variant
      // often resolves to the same term as the verbatim spelling (學校/学校,
      // すごーい/すごい). Deduping on prefix alone kept only the verbatim probe —
      // and when that one matched a rare/search-only spelling the confidence gate
      // dropped it, losing the whole span. Keeping both lets the confident one
      // survive; `contextualCompare` still prefers the verbatim when both pass.
      const key = longestOnly ? term.id : `${probe.prefix}\0${probe.candidate.text}\0${term.id}`;
      if (seen.has(key)) return [];
      seen.add(key);
      return [{ term, candidate: probe.candidate, prefixLength: [...probe.prefix].length, surface: probe.prefix }];
    }));
}

const CONTEXTUAL_MISC = new Set(["yoji", "id", "proverb"]);
const SEARCH_ONLY_TAGS = new Set(["sK", "sk"]);
const RARE_KANJI_TAGS = new Set(["rK", "oK"]);
const CONTEXTUAL_FREQUENCY_LIMIT = 50_000;

// A deinflected candidate must land on a term whose part-of-speech can actually
// take that inflection: いつだった → いつだつ (godan った→つ, conditions v5) must not
// match 逸脱 (a noun/suru-verb). Exact candidates carry no conditions and always
// pass — only deinflections are gated, and like Yomitan an entry with no matching
// conjugating class simply doesn't match (a noun has no verb rules to fire).
function posSatisfiesInflection(term: Stored<OfflineTerm>, candidate: Candidate): boolean {
  const required = candidate.conditions ?? 0;
  if (!required) return true;
  return (posConditionFlags(term.senses.flatMap((sense) => sense.partsOfSpeech)) & required) !== 0;
}

function matchingExpression(hit: LookupHit) {
  const normalized = normalize(hit.candidate.text);
  return hit.term.expressions.find((expression) => normalize(expression.text) === normalized);
}

// The kana that spells the form the surface matched — mirrors WordCard#reading_for.
// A kana form reads as itself; a written form takes the first reading JMdict says
// applies to it, so 良い天気 reads よいてんき while いい天気 reads いいてんき. Pairing a
// form with a reading it doesn't own leaves the two unalignable, and furigana
// smears over the whole word instead of sitting on the kanji.
function readingFor(term: Stored<OfflineTerm>, matched: string | undefined): string | null {
  const kana = term.readings.filter((item) => item.kind === "kana");
  const applicable = matched
    ? kana.find((item) => item.text === matched) ??
      kana.find((item) => !item.appliesTo || item.appliesTo.includes(matched))
    : undefined;
  return (applicable ?? kana[0] ?? term.readings[0])?.text ?? null;
}

// The form to LEAD the card with — mirrors WordCard#headword / #canonical_headword.
// A specific written form the surface matched leads (look up 狗 → 狗, not 犬); a
// usually-kana word otherwise leads with its kana (いつ, not 何時), matching the
// site so the offline popup and the page read the word the same way.
function displayHeadword(hit: LookupHit, reading: string | null): string {
  const matched = matchingExpression(hit);
  if (matched) return matched.text;
  if (reading && isUsuallyKana(hit.term)) return reading;
  return hit.term.headword;
}

// WordCard/Entry#usually_kana?: JMdict `uk`, or every kanji writing is rare
// (rK/oK), or the word is kana-only. Such a word's kana IS its normal spelling.
function isUsuallyKana(term: Stored<OfflineTerm>): boolean {
  // Primary sense only — the backend reads `facets.first` (Entry#usually_kana?),
  // not "any facet", so a `uk` annotation on a minor later sense must not flip the
  // whole entry to kana. The pack writes senses in facet order, so senses[0] is
  // that primary facet (the exporter drops only facets with no glosses at all).
  if (term.senses[0]?.misc.includes("uk")) return true;
  const kanjiForms = term.expressions.filter((expression) => expression.script !== "kana");
  if (!kanjiForms.length) return true;
  return kanjiForms.every((expression) => expression.tags.some((tag) => RARE_KANJI_TAGS.has(tag)));
}

function matchingReading(hit: LookupHit): boolean {
  const normalized = normalize(hit.candidate.text);
  return hit.term.readings.some((reading) => normalize(reading.text) === normalized);
}

function forcedExpression(hit: LookupHit): boolean {
  return hit.term.senses.some((sense) => sense.misc.some((tag) => CONTEXTUAL_MISC.has(tag)));
}

function contextuallyConfident(hit: LookupHit): boolean {
  if (hit.candidate.reasons.length) return true; // a longer deinflected word
  const usuallyKana = hit.term.senses.some((sense) => sense.misc.includes("uk"));
  const expression = matchingExpression(hit);
  if (!expression) {
    // The surface matched a reading, not a writing form. For a usually-kana word
    // (について, こと, など) the kana IS the normal spelling, so a kana surface is as
    // confident as a common expression — otherwise the multi-kana word loses to a
    // bare particle prefix and について is split into に + つい + て.
    return usuallyKana && matchingReading(hit);
  }
  if (expression.tags.some((tag) => SEARCH_ONLY_TAGS.has(tag))) return false;
  if (forcedExpression(hit)) return true;
  // Demoting a usually-kana word applies to its KANJI spellings only: for について
  // / ついて / こと the kana IS the normal spelling, and JMdict lists it as a real
  // expression (not just a reading), so demoting it here shredded について into
  // に + つい + て. Mirrors the web tokenizer's `script != "kana"` rule.
  const rareKanji = expression.script !== "kana"
    && (usuallyKana || expression.tags.some((tag) => RARE_KANJI_TAGS.has(tag)));
  if (rareKanji) return false;
  const frequency = frequencyForHit(hit);
  return expression.common || (frequency !== null && frequency <= CONTEXTUAL_FREQUENCY_LIMIT);
}

function contextualCompare(a: LookupHit, b: LookupHit): number {
  const forced = Number(forcedExpression(b)) - Number(forcedExpression(a));
  if (forced) return forced;
  const length = b.prefixLength - a.prefixLength;
  if (length) return length;
  // Prefer the most literal spelling (Yomitan's shortest text-processing chain):
  // a verbatim match beats one reached by folding katakana or collapsing kana, so
  // a coincidental folded homophone can't outrank the word actually on the page.
  const processing = (a.candidate.processingCost ?? 0) - (b.candidate.processingCost ?? 0);
  if (processing) return processing;
  // Prefer the analysis that took fewer deinflection steps (Yomitan's shortest
  // inflection chain) over a longer, more contrived one landing on a commoner word.
  const inflections = a.candidate.reasons.length - b.candidate.reasons.length;
  if (inflections) return inflections;
  const common = Number(Boolean(matchingExpression(b)?.common)) - Number(Boolean(matchingExpression(a)?.common));
  if (common) return common;
  const aFrequency = frequencyForHit(a) ?? Number.POSITIVE_INFINITY;
  const bFrequency = frequencyForHit(b) ?? Number.POSITIVE_INFINITY;
  return aFrequency - bFrequency || score(b, b.surface) - score(a, a.surface) || a.term.id.localeCompare(b.term.id);
}

// Corpus rank for this hit — the applicable [text, reading] pair first, with a
// text-only floor as fallback. Mirrors Entry.contextual_matches:
// `frequency[[text, reading]] || text_frequency[text]`.
//
// Both halves matter. Keying on text ALONE lets a spelling shared with a
// homograph inherit the other reading's rank (辛い is common as からい, far rarer as
// つらい), which floats a rare reading through the confidence gate and up the
// ranking. Keying on the pair alone misses words the corpus filed under a reading
// this entry does not use (いい天気 is ranked under よいてんき but reads いいてんき),
// so the floor keeps those from looking rankless.
function frequencyForHit(hit: LookupHit): number | null {
  const text = normalize(hit.candidate.text);
  const rows = (hit.term.frequencies ?? []).filter((item) => normalize(item.text) === text);
  if (!rows.length) return null;
  const readings = new Set(hit.term.readings.map((item) => normalize(item.text)));
  const applicable = rows.filter((item) => item.reading != null && readings.has(normalize(item.reading)));
  const pool = applicable.length ? applicable : rows;
  return Math.min(...pool.map((item) => item.rank));
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
  reportInstallProgress(0, "Fetching the dictionary manifest");
  const manifestResponse = await fetch(`${base}/v1/dictionary-packs/current`, { cache: "no-store", signal });
  if (!manifestResponse.ok) throw new Error(await responseFailure("Dictionary manifest", manifestResponse));
  const manifest = (await manifestResponse.json()) as PackManifest;
  validateManifest(manifest);

  reportInstallProgress(installProgress, "Checking offline dictionary storage");
  // Avoid re-entering snapshot/installing flags via dictionaryStatus during install —
  // only need the active revision comparison.
  const dbForCheck = await openDatabase();
  const activeRevision = await meta<string>(dbForCheck, "activeGeneration");
  const current = { revision: activeRevision ?? null };
  if (current.revision === manifest.contentRevision) {
    reportInstallProgress(1, null);
    return manifest;
  }

  reportInstallProgress(installProgress, "Downloading the dictionary pack");
  const response = await fetch(manifest.downloadUrl, { cache: "no-store", signal });
  if (!response.ok) throw new Error(await responseFailure("Dictionary download", response));
  if (!response.body) throw new Error("This browser cannot stream the dictionary download.");
  const [importBranch, hashBranch] = response.body.tee();
  const digestPromise = sha256Stream(hashBranch, manifest.bytes, signal);

  reportInstallProgress(installProgress, "Opening offline dictionary storage");
  const db = await openDatabase();
  const generation = manifest.contentRevision;
  await clearGeneration(db, generation);
  try {
    reportInstallProgress(Math.max(installProgress, 0.2), "Decompressing and importing dictionary records");
    const stream = importBranch.pipeThrough(new DecompressionStream("gzip"));
    await importRecords(db, generation, stream, manifest, signal);
    reportInstallProgress(Math.max(installProgress, 0.95), "Verifying the dictionary checksum");
    const digest = await digestPromise;
    if (digest !== manifest.sha256) throw new Error("Dictionary checksum did not match. The previous dictionary is still active.");
    reportInstallProgress(0.98, "Activating the offline dictionary");
    const previous = await meta<string>(db, "activeGeneration");
    if (previous && previous !== generation) await setMeta(db, "previousGeneration", previous);
    await setMeta(db, "activeGeneration", generation);
    await setMeta(db, "manifest", manifest);
    activeGenerationCache = generation;
    lookupProbeCache.clear();
    reportInstallProgress(1, null);
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
    reportInstallProgress(0.2 + 0.75 * ((importedTerms + importedKanji) / expected));
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
      !Array.isArray(term.readings) || term.readings.some((item) => !exactKeys(item, ["text", "kind", "appliesTo"]) || !plainString(item.text) || !plainString(item.kind) || (item.appliesTo != null && !stringArray(item.appliesTo))) ||
      !Array.isArray(term.senses) || !term.senses.length || term.senses.some((sense) => !exactKeys(sense, ["glosses", "partsOfSpeech", "fields", "misc", "dialects", "restrictions"]) || !glossMap(sense.glosses, new Set(["eng", "spa"])) || !stringArray(sense.partsOfSpeech) || !stringArray(sense.fields) || !stringArray(sense.misc) || !stringArray(sense.dialects) || !stringArray(sense.restrictions)) ||
      (term.pitch != null && (!Array.isArray(term.pitch) || term.pitch.some((item) => !exactKeys(item, ["text", "reading", "downstep", "audioUrl"]) || !plainString(item.text) || !plainString(item.reading) || !Number.isInteger(item.downstep) || !r2AudioUrl(item.audioUrl)))) ||
      (term.frequencies != null && (!Array.isArray(term.frequencies) || term.frequencies.some((item) => !exactKeys(item, ["source", "text", "reading", "rank"]) || !plainString(item.source) || !plainString(item.text) || (item.reading !== null && !plainString(item.reading)) || !Number.isFinite(item.rank)))) ||
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
    reportInstallProgress(Math.max(installProgress, 0.18 * Math.min(1, received / Math.max(1, expectedBytes))));
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
  const rank = frequencyForHit(hit);
  const frequency = rank === null ? 0 : Math.max(0, 1_000 - rank / 100);
  // Penalise folded/collapsed spellings so a verbatim match wins the non-contextual
  // (single-word popup) ranking too, mirroring the contextual tiebreak above.
  const processing = (hit.candidate.processingCost ?? 0) * 3_000;
  return exact + common + frequency + hit.prefixLength * 10 - hit.candidate.reasons.length - processing;
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
        // Pack stores raw JMdict codes (v5r, vi, uk…); resolve to the same
        // short labels the site chips show so offline popups match the web.
        partsOfSpeech: posLabels(sense.partsOfSpeech),
        tags: tagLabels([...sense.fields, ...sense.misc, ...sense.dialects]),
        glosses,
      }];
    });
  });
  const reading = readingFor(term, matchingExpression(hit)?.text);
  const headword = displayHeadword(hit, reading);
  const exactPitch = (term.pitch ?? []).filter((item) => item.text === headword && item.reading === reading);
  const displayedPitch = exactPitch.length || headword === reading
    ? exactPitch
    : (term.pitch ?? []).filter((item) => item.text === reading && item.reading === reading);
  return {
    headword,
    reading,
    url: `${apiBase.replace(/\/$/, "")}/word/${encodeURIComponent(headword)}`,
    common: term.expressions.some((item) => item.common),
    jlpt: term.jlpt ? `N${term.jlpt}` : null,
    frequency: frequencyForHit(hit),
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

// On a lookup miss, a run of katakana (incl. the prolonged sound mark ー, which
// is script-neutral) or full-width alphanumerics is reliably a single unit — a
// loanword, name, or number the pack doesn't carry — so `unknownRun` consumes
// the whole run instead of emitting one code point at a time, which shattered
// ミュンヘン into ミ・ュ・ン・ヘ・ン. It stops at the script boundary, so a following
// particle or kanji word still tokenizes on its own. A kanji/hiragana miss
// stays a single code point: a real dictionary word can begin partway through
// such a run, and grouping would swallow it.
const KATAKANA_RUN = /^[\p{Script=Katakana}ー]+/u;
const FULLWIDTH_ALNUM_RUN = /^[０-９Ａ-Ｚａ-ｚ]+/u;
function unknownRun(rest: string): string {
  return (rest.match(KATAKANA_RUN) ?? rest.match(FULLWIDTH_ALNUM_RUN))?.[0]
    ?? String.fromCodePoint(rest.codePointAt(0) as number);
}

function isKanji(text: string): boolean {
  return /[一-龯㐀-䶿]/u.test(text);
}

function startsJapanese(text: string): boolean {
  return JAPANESE_HEAD.test(text);
}
