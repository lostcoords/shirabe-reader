import { convertVariants } from "kanji-processor";
import { deinflect, inflectionLabel, posConditionFlags } from "./deinflect.js";
import { posChips, tagChips } from "./jmdict-tags.js";
import { GLOSS_TAGS, withEnglishFallback, type GlossLanguage } from "shirabe-sdk/word-card/languages.js";
import type { Definition, GlossRow, ParsedToken, Sense, SenseXref, TokenCandidate } from "./types.js";
import { sha256 as createSha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";

declare const __EXTENSION_VERSION__: string;

// The physical name carries a schema suffix so a machine holding an earlier
// dev-built database opens a clean one rather than a shape this code cannot
// read. Superseded databases are not migrated: a generation is rebuilt from the
// pack, which is always re-downloadable.
const DB_NAME = "shirabe-offline-dictionary-v4";
const DB_VERSION = 2;
const SUPPORTED_SCHEMA = 5;
// Longest term the greedy longest-match will probe from any position: the
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
  counts: { terms: number; kanji: number; sentences: number };
  languages: string[];
  dictionaries: Array<{ slug: string; version?: string | null }>;
  modifications: string[];
  sources: Array<{ name: string; url: string; license: string; licenseUrl?: string }>;
  downloadUrl: string;
  // How to NAME a pronunciation clip. The pack used to carry a pre-hashed URL on
  // every pitch row, 40% of the download, and random hex compresses to nothing.
  // So it now ships the recipe once and we hash the same input the server does
  // (`Audio::Clip#digest`): reading · accent · speaker · engine · salt. None of it
  // is secret (the pack published every URL it named, against a public-read
  // bucket), and it arrives as data so a change is a pack rebuild, not a release.
  audio: {
    baseUrl: string;
    path: string;
    extension: string;
    separator: string;
    engineVersion: number;
    salt: string;
    defaultVoice: string;
    voices: Record<string, number>;
  };
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

export class OfflineLookupUnavailableError extends Error {
  constructor(readonly reason: "meaning" | "entry") {
    super(reason === "meaning" ? "Meaning search is available online." : "Not available in this dictionary.");
    this.name = "OfflineLookupUnavailableError";
  }
}

type OfflineSense = {
  glosses: Record<string, string[]>;
  partsOfSpeech: string[];
  fields: string[];
  misc: string[];
  dialects: string[];
  restrictions: string[];
  // Both absent on the senses that have neither, which is most of them.
  // `notes` is per language because a note is written in one ("usu. in kana" is
  // not Spanish); a cross reference points at a Japanese word either way.
  notes?: Record<string, string[]>;
  xrefs?: Array<{ kind: string; text: string; reading?: string }>;
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
  pitch?: Array<{ text: string; reading: string; downstep: number }>;
  frequencies?: Array<{ source: string; text: string; reading: string | null; rank: number }>;
  // Sentence record ids ("tatoeba:tatoeba_1297"), most representative first.
  examples?: string[];
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

// A Tatoeba example, stored once and cited by every term it illustrates.
//
// `tokens` is the cut the SITE read this line with, shipped in the pack so both
// engines show the same words in the same places. Without it we would tokenize
// the line here with the other engine and disagree with the page the learner
// just came from. Optional: a pack built before recipe 10 has none, and the
// renderer falls back to the plain string.
type OfflineSentenceToken = { surface: string; reading?: string; lemma?: string; pos?: string };

type OfflineSentence = {
  type: "sentence";
  id: string;
  japanese: string;
  translations: Record<string, string>;
  tokens?: OfflineSentenceToken[];
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
let audioRecipeCache: PackManifest["audio"] | null | undefined = undefined;
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
  const response = await fetch(`${apiBase.replace(/\/$/, "")}/api/v1/dictionary-packs/current`, { cache: "no-store" });
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
  audioRecipeCache = undefined;
  lookupProbeCache.clear();
  candidateCache.clear();
  void clearInstallSnapshot();
}

export async function lookupOffline(query: string, languages: readonly GlossLanguage[], apiBase: string, voice?: string): Promise<Definition | null> {
  const normalized = normalize(query);
  const latin = /\p{Script=Latin}/u.test(normalized) && !/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(normalized);
  const source = normalized.slice(0, MAX_SCAN_CHARS);
  if (!source) return null;
  const db = await openDatabase();
  const generation = await activeGeneration(db);
  if (!generation) throw new DictionaryNotInstalledError("look up words");
  if (latin && source !== normalized) throw new OfflineLookupUnavailableError("meaning");
  const found = await lookupInDatabase(db, generation, source, languages, apiBase, false, latin);
  if (!found && latin) {
    throw new OfflineLookupUnavailableError("meaning");
  }
  return forPopup(db, generation, found, languages, voice);
}

// One named entry, for a reader who PICKED it. Everything else in this file
// answers "which word is this"; this answers "show me that one", because the
// reader has already settled the question and re-deriving it would hand them
// back the word they just rejected.
//
// A direct primary-key read: the terms store is keyed on `generation\0id` and an
// entry handle IS that id ("jmdict:1247250"), so choosing costs one get rather
// than a re-parse. `surface` is the span they tapped, kept because sense
// restrictions are keyed on the spelling in front of them.
export async function lookupEntryOffline(
  entry: string, surface: string, languages: readonly GlossLanguage[], apiBase: string, voice?: string,
): Promise<Definition | null> {
  const db = await openDatabase();
  const generation = await activeGeneration(db);
  if (!generation) throw new DictionaryNotInstalledError("look up words");

  const term = await getByPk<Stored<OfflineTerm>>(db, "terms", `${generation}\0${entry}`);
  if (!term) throw new OfflineLookupUnavailableError("entry");

  const matched = normalize(surface) || term.headword;
  const hit: LookupHit = {
    term,
    candidate: { text: matched, reasons: [] },
    prefixLength: [...matched].length,
    surface: matched,
  };
  return forPopup(db, generation, termDefinition(hit, languages, apiBase), languages, voice);
}

export async function parseOffline(text: string, languages: readonly GlossLanguage[], apiBase: string): Promise<ParsedToken[]> {
  const db = await openDatabase();
  const generation = await activeGeneration(db);
  if (!generation) throw new DictionaryNotInstalledError("parse text");
  const tokens: ParsedToken[] = [];
  let position = 0;
  // JMdict marks the nouns that verb with する (`vs`: 勉強, 電話, 日焼け). The very
  // next span is then almost certainly a form of する: and left to itself the
  // parser reads 下 (below) or 舌 (tongue) out of した, because an exact common
  // noun outranks a deinflected verb of the same length. One bit of context is
  // enough to settle it, and it is the bit Sudachi's POS bigrams carry.
  let afterSuruNoun = false;
  // Whether the token before this position was a content word, which is what
  // makes a leading は a particle rather than the first mora of a word.
  let afterContent = false;
  while (position < text.length) {
    const rest = text.slice(position);
    if (!startsJapanese(rest)) {
      const match = rest.match(NOT_JAPANESE_RUN);
      const surface = match?.[0] ?? rest[0];
      tokens.push({ start: position, length: surface.length, surface, reading: null, lemma: surface, pos: "", content: false, state: "none" });
      position += surface.length;
      afterSuruNoun = false; // punctuation or a Latin run ends the compound
      afterContent = false;
      continue;
    }

    const definition = await bestWithLookahead(db, generation, rest, languages, apiBase, afterSuruNoun);
    if (!definition?.sourceForm) {
      const surface = unknownRun(rest);
      tokens.push({ start: position, length: surface.length, surface, reading: null, lemma: surface, pos: "", content: false, state: "none" });
      position += surface.length;
      afterSuruNoun = false;
      afterContent = false;
      continue;
    }
    // A match that opens with a bound particle and only exists by deinflection
    // has eaten the particle in front of it: はもう is 食む, not は + もう. Emit the
    // particle alone and let the next pass read the word.
    if (await swallowedParticle(db, generation, definition, afterContent)) {
      const particle = [...rest][0]!;
      const { all } = await contextualCandidates(db, generation, particle);
      const hit = all.find((candidate) => candidate.term.senses.some((sense) => sense.partsOfSpeech.includes("prt")));
      const resolved = hit ? termDefinition(hit, languages, apiBase) : null;
      tokens.push({ start: position, length: particle.length, surface: particle,
        reading: resolved?.reading ?? null, lemma: particle, entry: resolved?.entry,
        pos: "prt", content: Boolean(resolved), state: "none" });
      position += particle.length;
      afterSuruNoun = false;
      afterContent = false;
      continue;
    }

    const surface = definition.sourceForm;
    // The other words this span could be, asked under the context the span was
    // read in: `afterSuruNoun` names what came BEFORE this token, so it has to be
    // read before the line below reassigns it for the next one. Passing the new
    // value asked a different question and, since the flag is in the cache key,
    // paid for a second gather to get the wrong answer.
    const alternatives = await alternativesFor(db, generation, rest, surface, definition, afterSuruNoun);
    afterSuruNoun = takesSuru(definition);
    // Number + counter: JMdict lists some of these as their own noun (七本 "seven
    // long cylindrical things", 六人 "six people") but not others (三匹 is a name
    // only), so matching the dictionary literally is inconsistent AND hides the
    // counter the learner actually needs. Emit the numeral and let the counter
    // match on the next pass, so 七本 reads 七 · 本 like 三匹 already does: the
    // extension's equivalent of the web's counter parts (tracker 2026-07-14).
    const numeral = counterNumeralLength(surface);
    if (numeral && await isCounter(db, generation, surface.slice(numeral))) {
      const head = surface.slice(0, numeral);
      tokens.push({
        start: position, length: head.length, surface: head, reading: null,
        lemma: head, pos: "", content: true, state: "none",
      });
      position += head.length;
      afterContent = true;
      continue;
    }
    tokens.push({
      start: position, length: surface.length, surface, reading: definition.reading,
      lemma: await copulaHead(db, generation, definition) ?? definition.headword,
      // The entry, not just the form it reduces to. Already in hand here, and the
      // only thing about this token that means the same on the server: two
      // tokenizers disagree about lemmas by design, and a save keyed on one of
      // them forks the card.
      entry: definition.entry,
      // Spread rather than assigned, so a token with nothing to choose between
      // carries no `candidates` key at all rather than an undefined one.
      ...alternatives ? { candidates: alternatives } : {},
      pos: firstPartOfSpeech(definition),
      content: true, state: "none", frequency: definition.frequency,
    });
    position += surface.length;
    afterContent = true;
  }
  // A numeral's surface keeps the width the page used; its lemma is the number, so
  // ２ and 2 are one card and not two. Applied to the finished stream because a
  // numeral arrives by three different routes (an entry, a counter compound, an
  // unrecognised run) and the answer is the same on all of them. The web normalises
  // the same way, and a card keyed on the width a subtitle happened to use is a card
  // nobody else will ever match.
  for (const token of tokens) {
    if (NUMERAL_ONLY.test(token.surface)) token.lemma = normalize(token.surface);
  }
  return mergeExpressions(db, generation, tokens, languages, apiBase);
}

// Port of Tokenizer#merge_expressions. Cheapest-path segmentation and JMdict's
// frequency lists disagree about grammar: それは is ranked 41,784 and んだ 21, so
// pricing them as words splits both into particles that are individually far
// commoner than the phrase they spell. The web hits this too: Sudachi emits
// morphemes. Answers it the same way, with a second pass that re-fuses a run
// the dictionary lists as one `exp`/`conj` entry. Frequency has no vote here: the
// dictionary saying "this is a grammatical unit" IS the evidence.
const GRAMMAR_POS = [ "exp", "conj" ];
// Sudachi's 格助詞. で in 本では binds the noun before it, so で+は is the
// compositional "as for, with" and not the connective では: the web declines that
// merge unless the run carries a content word (について has a verb in it), and the
// measured web output agrees: it keeps では/には/とは apart 44/59/21 times and
// merges them twice. Not の: as a nominaliser it leads のです, のだ, のに.
const CASE_PARTICLES = new Set([ "が", "を", "に", "で", "と", "へ", "から", "より" ]);
const BARE_PARTICLES = new Set([ ...CASE_PARTICLES, "は", "も", "の", "や", "か", "ね", "よ", "ぞ", "な", "ば" ]);
// Tokenizer#content_word?, from the other side: this pass repairs a grammar tail
// the path scorer priced apart, so only the HEAD of a run may be a word: the rest
// have to be particles or the copula. Told by surface, not by part of speech,
// because JMdict answers は with the noun 葉 and も with 藻; a kana particle looked
// up on its own is a homograph of something.
const GRAMMAR_TAILS = new Set([ ...BARE_PARTICLES, "です", "だ", "ます", "た", "て", "ん" ]);
// は alone, not every 係助詞: も is the same shape but forms words a reader wants
// whole (誰も "everyone", どっちも "both"). See grammarEntry.
const TOPIC_PARTICLE = "は";
const EXPRESSION_MAX_SPAN = 3;

async function mergeExpressions(db: IDBDatabase, generation: string, tokens: ParsedToken[],
  languages: readonly GlossLanguage[], apiBase: string): Promise<ParsedToken[]> {
  if (tokens.length < 2) return tokens;
  const merged: ParsedToken[] = [];
  let at = 0;
  while (at < tokens.length) {
    let taken = 1;
    let expression: Definition | null = null;
    for (let span = 2; span <= EXPRESSION_MAX_SPAN && at + span <= tokens.length; span += 1) {
      const run = tokens.slice(at, at + span);
      // Punctuation and Latin runs end a phrase; they never continue one.
      if (!run.every((token) => token.content)) break;
      // Nothing in front for a case particle to mark: the run opens the text,
      // follows punctuation, or the slot is already taken by another particle
      // (だけでも, 犯罪だとでも). Tokenizer#nothing_to_mark? draws the same line.
      // Both tests, because a bare particle looked up on its own is a homograph
      // of something: で and も come back `n` (出, 藻), so the surface set has to
      // stand in where the part of speech won't.
      const previous = tokens[at - 1];
      const unbound = !previous || !previous.content
        || previous.pos === "prt" || BARE_PARTICLES.has(previous.surface);
      const found = await grammarEntry(db, generation, run, languages, apiBase, unbound);
      if (found) { expression = found; taken = span; }
    }
    if (expression) {
      const run = tokens.slice(at, at + taken);
      merged.push({
        start: run[0]!.start, length: run.reduce((total, token) => total + token.length, 0),
        surface: run.map((token) => token.surface).join(""), reading: expression.reading,
        lemma: expression.headword, entry: expression.entry, pos: firstPartOfSpeech(expression),
        content: true, state: "none", frequency: expression.frequency,
      });
    } else {
      merged.push(tokens[at]!);
    }
    at += taken;
  }
  return merged;
}

// The `exp`/`conj` entry a run spells exactly, if the dictionary has one and the
// run is allowed to merge into it.
async function grammarEntry(db: IDBDatabase, generation: string, run: ParsedToken[],
  languages: readonly GlossLanguage[], apiBase: string, unbound = false): Promise<Definition | null> {
  if (!unbound
    && CASE_PARTICLES.has(run[0]!.surface) && run.every((token) => BARE_PARTICLES.has(token.surface))) return null;
  // A pronoun wearing the topic particle is the pronoun, marked: これ is what the
  // reader is pointing at and は is what the sentence does with it. JMdict lists
  // 此れは and それは anyway ("as for this", "very"), so this fused those two
  // demonstratives while あれは and 私は, identical in shape, stayed apart: the
  // dictionary deciding segmentation by accident of coverage. は ONLY: vetoing the
  // whole 係助詞 class also shattered 誰も / 何も / どっちも, which are real words.
  // Tokenizer#topic_marked_pronoun? draws the same line on the web.
  if (run[0]!.pos === "pn" && run.slice(1).every((token) => token.surface === TOPIC_PARTICLE)) return null;
  if (!run.slice(1).every((token) => GRAMMAR_TAILS.has(token.surface))) return null;
  const text = run.map((token) => token.surface).join("");
  const hits = await hitsForCandidates(db, generation,
    [ { prefix: text, candidate: { text, reasons: [] } } ], false);
  const grammar = hits.find((hit) => contextuallyConfident(hit, unbound)
    && hit.term.senses.some((sense) => GRAMMAR_POS.some((pos) => sense.partsOfSpeech.includes(pos))));
  return grammar ? termDefinition(grammar, languages, apiBase) : null;
}

const KATAKANA = /[ァ-ヶ]/;
const HAS_KANJI = /[\p{Script=Han}]/u;
const HONORIFIC_PREFIX = /^[おご御]/;
const EMPHATIC = new Set([0x3063, 0x30c3, 0x30fc]); // っ ッ ー: the elongation marks
const HAS_EMPHATIC = /[っッー]/;

const katakanaToHiragana = (text: string): string =>
  text.replace(/[ァ-ヶ]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0x60));

// Width is a typography accident of the page, never a distinction a reader
// means, but the two sides of a lookup fold it opposite ways: `normalize` puts
// the page's text through NFKC, which narrows ３ to 3, while JMdict files the
// counted number WIDE (３つ under 三つ, ＡＩ, ＥＤＴＡ). So a page writing 3つ
// probed 3つ, the pack held ３つ, and they never met: the run was cut into
// 3 | つの and a reader hovering it got nothing at all. The website was blind
// the same way and fixed it in `Entry.width_variants`.
const NARROW_ALNUM = /[0-9A-Za-z]/;
const widenAlnum = (text: string): string =>
  text.replace(/[0-9A-Za-z]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) + 0xfee0));

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
// A token's part of speech is the raw JMdict code: `v5b`, `adj-i`, `prt`, not
// the label the popup prints. Everything that consumes it matches on codes:
// the underline hues (content.css), the i+1 function-word test, counters. A
// definition is built for display, so its `partsOfSpeech` are already labels
// ("Godan verb"), which match none of them and colour nothing.
//
// JMdict also marks a part of speech on the sense that introduces it and lets
// later senses inherit, so reading only sense[0] leaves some words unlabelled.
// JMdict's suru-noun classes. `vs` is the plain one (勉強する); `vs-s`/`vs-i` are
// the irregulars (察する, 愛する): all three mean "する may follow this word".
const SURU_POS = new Set(["vs", "vs-s", "vs-i"]);
function takesSuru(definition: Definition): boolean {
  return definition.senses.some((sense) => sense.posCodes?.some((code) => SURU_POS.has(code)));
}

function firstPartOfSpeech(definition: Definition): string {
  for (const sense of definition.senses) {
    const code = sense.posCodes?.[0];
    if (code) return code;
  }
  return "";
}

const NUMERAL_ONLY = /^[0-9０-９]+$/;

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

// JMdict lists the に/な form of a word as an entry of its own: ように, ような,
// そんなに, 確かに are all real headwords. But Sudachi reads them as the head plus
// the adverbial copula and lemmatises to the head. Measured against the web's own
// output over 1,500 sentences, it strips the に/な exactly when the head is a
// na-adjective or a pre-noun adjectival (確かに→確か, そんなに→そんな, 好きな→好き)
// and keeps it when the head is a plain noun (ために, なしに) or nothing at all
// (さらに, すでに). So: keep the boundary: the phrase is what the reader saw and
// what the popup explains. Lemmatise the same way the site does, or a card
// minted here can never meet the one the site makes from the same sentence.
const COPULA_STEM_POS = [ "adj-na", "adj-pn" ];
// よう is the one head Sudachi splits off that JMdict does not class as either:
// ように/ような are `exp`, よう itself a plain noun. It is also the commonest by
// some way, so it is worth the exception rather than a rule stretched to fit it.
const COPULA_HEADS = new Set([ "よう" ]);

async function copulaHead(db: IDBDatabase, generation: string, definition: Definition): Promise<string | null> {
  const headword = definition.headword;
  if (headword.length < 3 || !/[にな]$/.test(headword)) return null;
  const stem = headword.slice(0, -1);
  if (COPULA_HEADS.has(stem)) return stem;
  const hits = await hitsForCandidates(db, generation, [ { prefix: stem, candidate: { text: stem, reasons: [] } } ], false);
  const head = hits.find((hit) => hit.term.senses.some((sense) =>
    COPULA_STEM_POS.some((pos) => sense.partsOfSpeech.includes(pos))));
  if (!head) return null;
  // And the head has to be the commoner word. Stripping on shape alone read そんな
  // as そん (損, a na-adjective meaning "loss") and さらに as さら (新, "brand new"):
  // a lexicalised adverb whose first characters happen to spell a rare homograph.
  // Where Sudachi really does strip a copula the head is the everyday word and the
  // に/な form the derived one: 確か 274 against 確かに 461, そんな 40 against
  // そんなに 2,099. So requiring that ordering keeps exactly the cases it should.
  const headRank = frequencyForHit(head);
  return headRank !== null && headRank < (definition.frequency ?? UNRANKED) ? stem : null;
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
  // Old/variant kanji (旧字体・異体字) standardize to the modern form: 萬→万, 國→国,
  // which NFKC does not do (they are distinct unified ideographs). Safe at any
  // length: it only rewrites kanji, so it can't invent a kana word.
  if (HAS_KANJI.test(prefix)) add(convertVariants(prefix), 1);
  // Safe at any length, and before the length guard below for that reason: a
  // lone 3 is a number whichever width it is written in, so widening cannot
  // invent a different word the way folding kana could.
  if (NARROW_ALNUM.test(prefix)) add(widenAlnum(prefix), 1);
  // A single mora is never an emphasis (スゴイ) or stretched (すっごい) form, but a
  // lone katakana ミ would fold to み and deinflect to 見る: so only vary length ≥ 2.
  const chars = [...prefix];
  if (chars.length < 2) return variants;
  // Honorific お/ご is productive, but JMdict only lists some of what it forms:
  // ご連絡 is an entry, ご配慮 is not. Without the stripped variant the reader gets
  // the bare prefix as its own lookup and the noun as another, so the same
  // construction reads two different ways depending on dictionary coverage.
  // Only before a kanji stem: お/ご before kana far more often opens an ordinary
  // word (おもう, およそ, ごはん) than an honorific. Listed forms are unaffected
  // either way: they match verbatim at cost 0 and outrank this by `processing`.
  if (HONORIFIC_PREFIX.test(prefix) && HAS_KANJI.test(chars[1])) add(chars.slice(1).join(""), 1);
  if (KATAKANA.test(prefix)) add(katakanaToHiragana(prefix), 1);
  const collapsed = collapseEmphatic(prefix);
  if (collapsed !== prefix) {
    add(collapsed, 1);
    if (KATAKANA.test(collapsed)) add(katakanaToHiragana(collapsed), 2);
  }
  return variants;
}

// Common auxiliary verbs that attach to a te-form (授けて+いただく, 読んで+しまう).
// They are separate verbs, not inflections, so the deinflector cannot reach them:
// but a long inflection chain CAN eat into their head (授けていた steals the い from
// いただく), which is where a purely greedy longest match goes wrong.
const TE_AUXILIARIES = ["いただく", "いただける", "くださる", "ください", "もらう", "もらえる", "くれる", "あげる", "やる", "しまう", "おく", "みる", "いく", "くる", "ある", "いる"];

// An auxiliary carries the predicate's tense, so it rarely stands in its
// dictionary spelling: ていった is て + いく in the past. So how many characters of
// `rest` spell one has to be answered by DEINFLECTING it: reading the plain
// spelling alone missed exactly the case that hurts. In 変わっていった, いった went
// unrecognised, so 変わってい took the span as the entry 変わっている ("to be
// eccentric") and stranded った. Longest first: ていった is いった (いく), not い (いる).
// Six characters covers the longest polite form a listed auxiliary inflects to
// (いただきます) and bounds the deinflection passes.
const MAX_AUXILIARY_CHARS = 6;

function auxiliaryLength(rest: string): number {
  for (let length = Math.min(rest.length, MAX_AUXILIARY_CHARS); length >= 1; length -= 1) {
    const candidate = rest.slice(0, length);
    // Verbatim first: by far the common case, and free next to a deinflection.
    if (TE_AUXILIARIES.includes(candidate)) return length;
    if (deinflect(candidate).some((found) => TE_AUXILIARIES.includes(found.term))) return length;
  }
  return 0;
}

// Greedy longest-match, with one step of lookahead. The longest reading of a span
// is usually right, but not always: 授けていただく offers the valid 5-char 授けていた
// (授ける + ている + た), which beats the correct 3-char 授けて and strands だく.
// Both readings are legal Japanese; what distinguishes them is what comes NEXT.
//
// So when the best match is followed by a te-form auxiliary that it has bitten
// into, prefer the shorter match that leaves the auxiliary whole. This is a
// deliberately narrow rule: it only fires when a shorter alternative ends at a
// て/で boundary AND the remainder then spells a known auxiliary, rather
// than general lattice scoring, which is what Sudachi does and we cannot afford.
async function bestWithLookahead(
  db: IDBDatabase, generation: string, rest: string,
  languages: readonly GlossLanguage[], apiBase: string, afterSuruNoun = false,
): Promise<Definition | null> {
  const source = rest.slice(0, MAX_SCAN_CHARS);
  // Gathered once and used twice: the winner becomes the token, the runners-up
  // are what the path scorer prices it against. Re-asking the database for a
  // list already in hand doubled the queries for every position on the page.
  const { trusted, all } = await contextualCandidates(db, generation, source, afterSuruNoun);
  const best = trusted.length
    ? termDefinition(wholeKatakanaWord(trusted, source), languages, apiBase)
    : await lookupInDatabase(db, generation, source, languages, apiBase, true);
  const matched = best?.sourceForm;
  if (!matched) return best;
  const compound = await dictionaryNounCompound(db, generation, source, best, all);
  if (compound) return termDefinition(compound, languages, apiBase);

  // Fire only when the winning span ends STRICTLY INSIDE a following auxiliary:
  // that is the "bitten into it" case. 授けていただく: cutting at 授けて leaves
  // いただく (3→7) while the match ends at 5, inside it: so it bit in, and the
  // shorter reading wins. 書いている: cutting at 書いて leaves いる (3→5) and the
  // match ends at exactly 5, consuming the auxiliary cleanly: that is the
  // progressive, one token, and must be left alone.
  for (let cut = matched.length - 1; cut >= 2 && matched.length >= 3; cut -= 1) {
    if (matched[cut - 1] !== "て" && matched[cut - 1] !== "で") continue;
    const auxiliary = auxiliaryLength(rest.slice(cut));
    if (!auxiliary) continue;
    if (matched.length >= cut + auxiliary) continue; // consumed it whole: leave it
    const shorter = await lookupInDatabase(db, generation, matched.slice(0, cut), languages, apiBase, true);
    // Only take the shorter reading if it actually covers the te-form span.
    if (shorter?.sourceForm?.length === cut) return shorter;
  }

  // Greedy longest-match asks "what is the longest word starting here?", which is
  // the wrong question when a shorter word leads to a better sentence: 本はとても
  // reads はと (鳩, a pigeon) + ても rather than は + とても, and 兄がいます reads がい
  // + ます. Both readings are words; what separates them is that one path is built
  // of common words and the other of rare ones.
  //
  // So price the two readings as PATHS and take the cheaper. Cost is corpus rank,
  // logged: Sudachi minimises a connection cost over a full lattice, and this is
  // the two-token slice of that we can afford. Ranks ride in the pack already.
  return pathAdjusted(db, generation, rest, languages, apiBase, best, trusted);
}

async function dictionaryNounCompound(
  db: IDBDatabase, generation: string, source: string, best: Definition, candidates: LookupHit[],
): Promise<LookupHit | undefined> {
  if (!firstPartOfSpeech(best).match(/^n(?:-|$)/)) return;
  const length = best.sourceForm!.length;
  const compounds = candidates.filter((hit) => hit.prefixLength > length && hit.candidate.reasons.length === 0
    && matchingExpression(hit) && hit.term.senses.some((sense) => sense.partsOfSpeech.includes("n"))
    && BOUND_PARTICLES.has(source[hit.prefixLength]!));
  if (!compounds.length) return;

  const cost = (surface: string, rank: number | null | undefined): number =>
    TOKEN_COST + [...surface].length * Math.log10(Math.max(rank ?? UNRANKED, 1));
  for (const compound of compounds.sort((a, b) => b.prefixLength - a.prefixLength)) {
    const overlap = source.slice(length, compound.prefixLength);
    const hits = await hitsForCandidates(db, generation, [{ prefix: overlap, candidate: { text: overlap, reasons: [] } }], false);
    const nouns = hits.filter((hit) => matchingExpression(hit) && hit.term.senses.some((sense) => sense.partsOfSpeech.includes("n")));
    if (!nouns.length) continue;
    const splitCost = cost(best.sourceForm!, best.frequency) + Math.min(...nouns.map((hit) => cost(overlap, frequencyForHit(hit))));
    if (cost(compound.surface, frequencyForHit(compound)) < splitCost) return compound;
  }
}

// Particles a word can be mis-cut across: they bind what comes BEFORE them, so a
// match that opens with one and was reached by deinflection has eaten it.
// `Tokenizer#BOUND_PARTICLES` is the same list on the web.
const BOUND_PARTICLES = new Set([ "は", "が", "を", "に", "へ", "も", "と", "で" ]);

// Did this match swallow the particle in front of it? 彼はもう帰った came back as
// 彼 | はもう | 帰った, because はもう deinflects to はむ (食む, an archaic "to eat")
// and longest-match takes the longer span. 私はたいてい went the same way through
// はたく. The topic particle belongs to 彼, and もう is the word.
//
// Three conditions, and all three are load-bearing. The match must have been
// reached by DEINFLECTION, so a listed expression is never touched (について and
// ではないか are exact matches and stay whole). It must open with a bound particle.
// And something must come BEFORE it, because a sentence-initial は is not marking
// anything. The web does this to Sudachi's output in `unswallow_particles`, for
// the same reason and with the same list; this is the longest-match side of it.
async function swallowedParticle(
  db: IDBDatabase, generation: string, definition: Definition | null, afterContent: boolean,
): Promise<boolean> {
  if (!afterContent || !definition?.sourceForm) return false;

  const characters = [...definition.sourceForm];
  if (characters.length < 2 || !BOUND_PARTICLES.has(characters[0]!)) return false;
  if (!definition.inflection?.length) return false;

  // …and the fourth condition, which the first draft left out and 長居できない
  // caught within the minute. "Is the tail a word?" does not separate them: きない
  // is an entry too (rank 137,415). What separates them is WHICH READING IS THE
  // RARE ONE, measured rather than guessed:
  //
  //   はもう   104,213   tail もう        42   the tail is 2,481x commoner  → は was eaten
  //   できない      62   tail きない 137,415   the tail is 2,216x rarer     → で is part of できる
  //
  // So the particle is only cut off when what is left is MUCH commoner than the
  // reading that swallowed it, on the same 6-bit bar `MUCH_COMMONER` sets for the
  // path scorer. Nothing here is a threshold anyone had to invent.
  const tail = characters.slice(1).join("");
  const hits = await hitsForCandidates(db, generation, [ { prefix: tail, candidate: { text: tail, reasons: [] } } ], false);
  const tailRank = Math.min(...hits.map((hit) => frequencyForHit(hit) ?? UNRANKED));
  if (!Number.isFinite(tailRank)) return false;

  return Math.log2((definition.frequency ?? UNRANKED) + 1) - Math.log2(tailRank + 1) >= MUCH_COMMONER;
}

// Every reading of this position the contextual gate trusts, best first: the
// same list `lookupInDatabase` picks its winner from, returned rather than
// rebuilt, so the scorer sees the runners-up greed threw away.
// The kana する actually inflects through (する・します・した・して・される・させる…).
// Its potential is suppletive: spelled できる, which JMdict carries as its own
// entry 出来る: so 長居できない is a form of できる, not of する, and the promotion
// below must not drag it across. The web reads it the same way.
const SURU_STEM = /^[しすさせ]/;

// One gather, two answers, and they are different questions.
//
// `trusted` is what the CUT is made of: the readings that cleared the contextual
// gate, best first. `all` is every reading the span produced before the gate ran,
// which is what "which word is this" may offer. The gate is right for the parser
// and wrong for the list: dropping it shatters 全く (adverb, common, but
// usually-kana so never confident) into 全 + く, while keeping it made 君
// unreachable for きみ, because a kanji word matched by its kana READING only
// clears the gate when the entry is `uk`.
//
// So both come out of the one gather rather than the gate being loosened. The
// pre-gate array already existed and was thrown away.
type SpanCandidates = { trusted: LookupHit[]; all: LookupHit[] };

const candidateCache = new BoundedCache<SpanCandidates>(600);

async function contextualCandidates(db: IDBDatabase, generation: string, source: string, afterSuruNoun = false): Promise<SpanCandidates> {
  // The suru bit belongs in the key: the same span reads differently after 勉強
  // than after の, and a cache that ignored it would serve one for the other.
  const key = `${generation}\0${afterSuruNoun ? "s" : ""}\0${source}`;
  const cached = candidateCache.get(key);
  if (cached) return cached;
  const candidates = await gatherCandidates(db, generation, source, afterSuruNoun);
  candidateCache.set(key, candidates);
  return candidates;
}

// Every OTHER word this exact span could be, best first, with the chosen one at
// the head. The offline half of `POST /api/v1/words/identify`.
//
// The list is not new work: `contextualCandidates` already gathered it to pick
// the winner and its answer is still in the cache, so this reads what greed threw
// away rather than asking again. `rest` is sliced to the same window the parser
// asked about, because a different window is a different cache key: asking about
// the whole remaining paragraph missed the entry every time and re-gathered one
// prefix per character of it.
//
// Read off `all`, not `trusted`: the gate that picks the CUT drops every word a
// spelling merely carries (君 for きみ is not `uk`, so it never cleared it), which
// is precisely the word a reader taps to ask about.
//
// Narrowed to hits covering the SAME span, because a picker offers other
// readings of the word in front of the reader, not shorter or longer cuts of it.
// Re-cutting the sentence is the parser's job and it has already done it. That
// narrowing is also what keeps the pre-gate list honest: the gate's rules about
// では and 全く are about where to CUT, and a hit on another span is filtered out
// here anyway.
//
// Absent where there is nothing to choose between, so a client can treat its
// presence as "there is a question here" rather than testing the length.
async function alternativesFor(
  db: IDBDatabase, generation: string, rest: string, surface: string,
  chosen: Definition, afterSuruNoun: boolean,
): Promise<TokenCandidate[] | undefined> {
  const { all } = await contextualCandidates(db, generation, rest.slice(0, MAX_SCAN_CHARS), afterSuruNoun);
  const hits = all
    .filter((hit) => hit.surface === surface)
    .sort(byLadder);
  const summaries: TokenCandidate[] = [];
  const seen = new Set<string>();
  for (const hit of hits) {
    // `term.id` IS the handle: the pack stores it already qualified
    // ("jmdict:1009470"), which is what `termDefinition` puts on `entry`.
    const entry = hit.term.id;
    if (seen.has(entry)) continue;
    seen.add(entry);
    summaries.push({
      entry,
      headword: hit.term.headword,
      reading: hit.term.readings[0]?.text ?? null,
      common: hit.term.expressions.some((expression) => expression.common),
    });
  }
  if (summaries.length < 2) return undefined;
  // The chosen word leads, whatever order the ladder left the list in: the head
  // is the answer, and a caller reading only `candidates[0]` must get `entry`.
  const at = summaries.findIndex((candidate) => candidate.entry === chosen.entry);
  if (at > 0) summaries.unshift(...summaries.splice(at, 1));
  return summaries;
}

/**
 * The server's rung ladder, standing on the rungs we have.
 *
 * `WordIds` orders candidates by: the class the sentence read (needs a
 * morphological analyser, which we do not have), then the spelling's own words
 * before the ones it merely carries, then the reading, then common, then corpus
 * rank. We climb every rung but the first, so an offline list and an
 * `identify` call given the same fields come out in the same order.
 *
 * Not the path scorer's order, which `contextualCompare` produces and which
 * answers a different question: "which CUT is cheapest", not "which WORD is
 * this". The two coincide often enough to hide the difference and diverge
 * exactly where a spelling names several words, which is the case this list
 * exists for. Where the cut IS settled, `contextualCompare` continues down these
 * same rungs rather than inventing its own tie-break: they share `filedRung`.
 *
 * Every hit here covers the same span (`alternativesFor` filtered to it), so a
 * hit's own `surface` is the spelling being ranked and nothing has to be passed
 * alongside.
 *
 * Rank is used weakly and last, because it is keyed on SPELLING on both sides:
 * は, 歯, 葉, 刃 and 派 all report the same number. Filed-before-carried has to
 * come first or the commonest particles in the language are decided by a coin
 * flip.
 */
function byLadder(a: LookupHit, b: LookupHit): number {
  const filed = filedRung(a, b);
  if (filed) return filed;
  // Rung 3: the reading the sentence used.
  const reading = Number(Boolean(matchingExpression(b))) - Number(Boolean(matchingExpression(a)));
  if (reading) return reading;
  // Rung 4: common, then rank, then a stable id so the order never wobbles.
  const common = Number(isCommonWord(b)) - Number(isCommonWord(a));
  if (common) return common;
  const rank = (frequencyForHit(a) ?? Number.POSITIVE_INFINITY) - (frequencyForHit(b) ?? Number.POSITIVE_INFINITY);
  if (rank) return rank;
  return a.term.id.localeCompare(b.term.id);
}

// Rung 2, and the one rung both the CUT and the LIST run: a word the spelling
// NAMES beats one it merely reads as. `filed` on the server; here, the entry
// leading with this spelling, or a usually-kana word matching by reading, which
// is what `Entry#headword?` means.
//
// …but a spelling's own words do not get to be rare AND win, which is the second
// half of `WordIds#pick`'s version. とき is filed under 鴇, the crested ibis
// whose kana form JMdict lists, and merely CARRIES 時: a reader writing とき
// means the time. Stated pairwise so one comparator can hold it: a carried
// COMMON word beats a filed rare one, and filed wins every other way round. は
// keeps its particle, which is filed AND common, so this never reaches it.
function filedRung(a: LookupHit, b: LookupHit): number {
  const aFiled = isFiledUnder(a, a.surface);
  if (aFiled === isFiledUnder(b, b.surface)) return 0;

  const [ filed, carried ] = aFiled ? [ a, b ] : [ b, a ];
  const filedFirst = !isCommonWord(filed) && isCommonWord(carried) ? 1 : -1;
  return aFiled ? filedFirst : -filedFirst;
}

// `Entry#common?`, ported: rung 4 asks whether the WORD is common, not whether
// this writing of it is. A word its spelling merely CARRIES has no matching
// expression at all (君 is not written きみ), so asking the writing answers false
// for every carried word and hands the rung straight to corpus rank, which is
// keyed on SPELLING and reports one number for は, 歯, 葉, 刃 and 派 alike. It is
// also the flag `alternativesFor` reports on each candidate, so the order and the
// label now come from the same question.
//
// The writing still wins where there is one: a rare spelling of a common word is
// a deliberate choice by whoever wrote the page, and rung 4 keeps saying so.
function isCommonWord(hit: LookupHit): boolean {
  return matchingExpression(hit)?.common ?? hit.term.expressions.some((expression) => expression.common);
}

// `Entry#headword?`, ported: a kanji writing the term is filed under, or a kana
// one where the word is usually written in kana. 君 merely READS きみ, so it is
// carried rather than filed, which is exactly the distinction that decides
// whether a spelling's own word or a borrowed one leads.
function isFiledUnder(hit: LookupHit, surface: string): boolean {
  const text = normalize(surface);
  const expression = hit.term.expressions.find((item) => normalize(item.text) === text);
  if (!expression) return false;
  return expression.script !== "kana" || isUsuallyKana(hit.term);
}

// The scorer looks one token ahead, which is the very span the parser reads on
// its next step: so the work lands in the cache above rather than being redone.
async function gatherCandidates(db: IDBDatabase, generation: string, source: string, afterSuruNoun = false): Promise<SpanCandidates> {
  const prefixes = prefixesLongestFirst(source);
  const exactHits = await hitsForCandidates(db, generation, prefixes.flatMap((prefix) =>
    lookupVariants(prefix).map((variant) => ({
      prefix, candidate: { text: variant.text, reasons: [], processingCost: variant.processingCost },
    }))), false);
  // Only a VERBATIM match may suppress deinflecting its own span. A folded one is
  // a guess about the spelling (あった → collapse the sokuon → あた, an obscure old
  // unit of length), and letting the guess stand in for the span meant あった never
  // reached ある at all: the same shape as あったまる losing to 頭.
  // Every span is deinflected, even one an exact match already covers. The old
  // optimisation: only deinflect prefixes LONGER than the longest exact hit.
  // Saved work by assuming an exact match is the better reading of its own span,
  // and that assumption hides an inflected verb behind every homograph: います is
  // an exact hit on 在す (archaic, rank 40,743) and so never reached いる (rank 38);
  // した is 下 and never reached する. The ranking below can only choose between
  // readings it has been given. Costs ~23 ms per 50 sentences with the candidate
  // cache in front of it, which is a fifth of what the cache itself saved.
  const deinflectedHits = await hitsForCandidates(db, generation, prefixes.flatMap((prefix) =>
    lookupVariants(prefix).flatMap((variant) =>
      deinflect(variant.text).map((found) => ({
        prefix,
        candidate: { text: found.term, reasons: found.inflections.map(inflectionLabel), conditions: found.conditions, processingCost: variant.processingCost },
      })))), false);
  const hits = [...deinflectedHits, ...exactHits];
  const confident = hits.filter((hit) => contextuallyConfident(hit));
  // Nothing cleared the gate: so fall back to what the parser is underneath, a
  // longest match. The gate exists to let a *confident shorter* word beat a long
  // unconfident one; with nothing confident it has no opinion, and dropping to
  // per-word score shattered 全く (adverb, common, but usually-kana so never
  // confident) into 全 + く on a hair's-breadth score difference.
  if (!confident.length) {
    hits.sort((a, b) => b.prefixLength - a.prefixLength || score(b, source) - score(a, source));
    return { trusted: hits, all: hits };
  }
  confident.sort(contextualCompare);
  // The sort prefers the analysis with fewer inflection steps, which is right
  // until the rarity gap is absurd: います is an exact match on 在す, an archaic
  // verb ranked 40,743, and that beat the polite いる (rank 38) for costing one
  // deinflection. A reading three orders of magnitude commoner over the same span
  // is not a tie the inflection count should be settling.
  // …but only against a leader that is nobody's idea of a common word. JMdict
  // marks 出来る common (rank 1,094) and it is still ~9 bits rarer than する, which
  // it is the potential form of: so the gap alone handed every 出来る on the page
  // to する. The rule is for the archaic homographs (在す is common nowhere); a
  // writing the dictionary itself calls common is not the accident it aims at.
  const leader = confident[0];
  if (leader && !matchingExpression(leader)?.common) {
    const rival = confident.find((hit) => hit.prefixLength === leader.prefixLength
      && rankCost(hit) + MUCH_COMMONER <= rankCost(leader));
    if (rival) confident.unshift(...confident.splice(confident.indexOf(rival), 1));
  }
  // JMdict lists plenty of inflected forms as entries in their own right: 知らない
  // and ならない as adjectives, ください and なさい as expressions, した as a noun. And
  // an exact match on one of those beats the deinflection that reaches the verb,
  // for the sole reason that it took no steps to get there. The web reads them as
  // forms and lemmas them to the verb, and the verb is what a card wants on its
  // front: 知る, not 知らない. Only ever in favour of a word JMdict itself calls
  // common, which is what keeps について off 似つく (rank 113,027) and 全く off 全い.
  //
  // A form entry is itself conjugable, so the rule cannot ask that the leader be
  // an EXACT match: 変わっていた is the past of the entry 変わっている ("to be
  // eccentric"): one step. Where the verb behind it takes three, and requiring a
  // stepless leader is the whole reason it stood. What actually marks the rival as
  // the same reading carried further is that it walks the leader's chain and keeps
  // going (`extendsChain`); with a stepless leader that is every chain, which is
  // the original rule unchanged.
  if (leader) {
    const form = confident.findIndex((hit) => hit.prefixLength === leader.prefixLength
      && extendsChain(leader.candidate.reasons, hit.candidate.reasons)
      && matchingExpression(hit)?.common
      && VERBAL_POS.test(firstSensePos(hit))
      && hit.candidate.reasons.every((reason) => PREDICATE_FORMS.has(reason))
      // …and the verb has to be the commoner reading of the two. それ is the
      // imperative of 剃る and たくさん the negative of 託す: real rules, firing on
      // the commonest pronouns there are. A form beats its own dictionary entry
      // only when the word behind it is the one people actually write.
      && rankCost(hit) < rankCost(leader));
    if (form > 0) confident.unshift(...confident.splice(form, 1));
  }
  // After a suru-noun, a form of する is the reading: 日焼け + した is not 日焼け
  // followed by a tongue. Only ever promotes an inflected する that the sort had
  // already accepted; it never invents one.
  if (afterSuruNoun) {
    const suru = confident.findIndex((hit) => hit.candidate.text === "する" && hit.candidate.reasons.length > 0
      && SURU_STEM.test(hit.surface));
    if (suru > 0) confident.unshift(...confident.splice(suru, 1));
  }
  return { trusted: confident, all: hits };
}

// A token's price: how rare it is, logged so the difference between rank 2 and
// rank 400 does not swamp everything else. An unranked entry is not free: it is
// the expensive case, because "a word nobody uses" is exactly what a greedy match
// hallucinates out of two neighbouring words.
const UNRANKED = 300_000;
const UNPARSED_COST = Math.log2(UNRANKED) + 2; // worse than any real word: it explains nothing

// How much commoner a rival has to be before it overrules the sort: 6 bits is
// ~64x, far past anything a genuine near-synonym pair shows.
const MUCH_COMMONER = 6;

function rankCost(hit: LookupHit): number {
  return Math.log2((frequencyForHit(hit) ?? UNRANKED) + 1);
}

function tokenCost(hit: LookupHit | null | undefined): number {
  if (!hit) return UNPARSED_COST;
  // Each deinflection step is a small extra assumption about the reading.
  return rankCost(hit) + hit.candidate.reasons.length * 0.25;
}

// How a reading is priced: the cheapest way to explain the text AFTER it, over a
// short window. This is the slice of Sudachi's lattice we can afford: Sudachi
// minimises a connection cost over the whole sentence; this minimises rank cost
// over the next few characters, which is where the greedy mistakes live.
//
// Every candidate is charged for the SAME window, so there is nothing to
// normalise and no bias toward the reading that happens to explain more. Three
// heuristics preceded this and each one moved the error somewhere else: pricing
// only two tokens made 時間 lose to 時 + 間がない (rank 32,510), and pricing the
// follow-on greedily judged a path on a mistake it did not have to make (after
// 時間 the greedy next token is がな, rank 5,974, not が at rank 5).
//
// `TOKEN_COST` is what stops a compound shattering into its particles: without
// it の + で (two of the commonest words there are) always undercuts ので. It is
// the counterweight Sudachi gets from connection costs.
const TOKEN_COST = 6;
const PATH_WINDOW = 10;

async function cheapestFrom(
  db: IDBDatabase, generation: string, window: string, from: number, memo: Map<number, number>,
): Promise<number> {
  if (from >= window.length) return 0;
  const cached = memo.get(from);
  if (cached != null) return cached;
  const tail = window.slice(from);
  // A path that reaches the end of the clause is finished, not stranded: charging
  // it for the 。 that follows made 書いている look worse than 書いて + いる.
  if (!startsJapanese(tail)) return 0;

  const { trusted: options } = await contextualCandidates(db, generation, tail.slice(0, MAX_SCAN_CHARS));
  // An unexplained character is always an option, and always the expensive one.
  let best = UNPARSED_COST + TOKEN_COST + await cheapestFrom(db, generation, window, from + 1, memo);
  for (const option of options.slice(0, MAX_PATH_ALTERNATIVES)) {
    const cost = tokenCost(option) + TOKEN_COST
      + await cheapestFrom(db, generation, window, from + option.prefixLength, memo);
    if (cost < best) best = cost;
  }
  memo.set(from, best);
  return best;
}

// Switching paths has to be a clear win, not a coin flip: a margin keeps the
// scorer from churning on near-ties, where the greedy answer is as good as any.
const PATH_MARGIN = 0.5;
// How many shorter readings to price against the greedy one. The shortest useful
// alternative is usually a particle the greedy match swallowed, and that can be
// several characters down (であったまる needs で, three lengths below であった).
const MAX_PATH_ALTERNATIVES = 4;

// Characters no Japanese word can START with: the long-vowel mark and the small
// kana, which all modify the mora before them. A cut that leaves one of these
// opening the next token has split a word down the middle, whatever the path
// costs say, so it is not an alternative worth pricing.
const NEVER_INITIAL = /^[ーぁぃぅぇぉっゃゅょゎァィゥェォッャュョヮヵヶ゛゜]/;

// Katakana, including the long-vowel mark and the small forms: one unbroken run
// of these is one word. Japanese does not write two katakana words against each
// other without a separator (a ・, a particle, a change of script), so a cut with
// katakana on both sides is inside a word, not between two.
//
// Pricing cannot answer this and should not try. カレ folds to かれ and matches
// 彼, one of the commonest words in the language, so カレ + ー really is the
// cheaper path and the reader hovering curry was told "he". The same arithmetic
// shredded チョコレート into チョ + コレ (此れ) + ー + ト, セミナー into セ + ミナ
// + ー, カレンダー into カレ + ンダ + ー: 71 common words in a sweep of the 1,002
// exposed to it. ラーメン was never at risk only because ラーメ spells nothing,
// which is luck, not a rule.
// One character of a katakana run, long-vowel mark included: the same class
// `unknownRun` already groups whole for the same reason, applied one layer up.
const KATAKANA_CHAR = /[\p{Script=Katakana}ー]/u;

// Would cutting here land in the middle of a katakana run?
const cutsInsideKatakana = (rest: string, at: number): boolean =>
  at > 0 && at < rest.length && KATAKANA_CHAR.test(rest[at - 1]!) && KATAKANA_CHAR.test(rest[at]!);

// The same rule applied to the WINNER rather than to the alternatives it is
// priced against. Candidates are ordered by score, not by length, so a very
// common short word can lead the list outright and never reach the path scorer
// at all: バラ (rose) leads バラバラ and バランス, ナミ leads ナミビア. When the
// leader stops inside a katakana run, the longest candidate that does not is the
// word; when no candidate clears the run, the leader stands, because then we are
// guessing either way.
function wholeKatakanaWord(candidates: LookupHit[], source: string): LookupHit {
  const leader = candidates[0]!;
  if (!cutsInsideKatakana(source, leader.prefixLength)) return leader;

  let whole: LookupHit | undefined;
  for (const hit of candidates) {
    if (cutsInsideKatakana(source, hit.prefixLength)) continue;
    if (!whole || hit.prefixLength > whole.prefixLength) whole = hit;
  }
  return whole ?? leader;
}

async function pathAdjusted(
  db: IDBDatabase, generation: string, rest: string,
  languages: readonly GlossLanguage[], apiBase: string, best: Definition | null,
  candidates: LookupHit[],
): Promise<Definition | null> {
  const winner = candidates[0];
  // At the end of the text there is no path to compare: the winner explains
  // everything that is left.
  if (!winner || winner.prefixLength >= rest.length) return best;

  // One reading per span length, best first: the list holds every entry that
  // matched, and 25 readings of お are 25 identical paths.
  const byLength = new Map<number, LookupHit>();
  for (const hit of candidates) if (!byLength.has(hit.prefixLength)) byLength.set(hit.prefixLength, hit);
  const alternatives = [...byLength.values()]
    .filter((hit) => hit.prefixLength < winner.prefixLength)
    .filter((hit) => !NEVER_INITIAL.test(rest.slice(hit.prefixLength)))
    .filter((hit) => !cutsInsideKatakana(rest, hit.prefixLength))
    .slice(0, MAX_PATH_ALTERNATIVES);
  if (!alternatives.length) return best;

  const window = rest.slice(0, PATH_WINDOW);
  const memo = new Map<number, number>();
  const priced = async (hit: LookupHit): Promise<number> =>
    tokenCost(hit) + TOKEN_COST + await cheapestFrom(db, generation, window, hit.prefixLength, memo);
  const [greedy, ...rivals] = await Promise.all([winner, ...alternatives].map(priced));
  const cheapest = rivals.reduce((best_, cost, index) =>
    (cost < best_.cost ? { cost, index } : best_), { cost: Infinity, index: -1 });
  // Switching has to be a clear win. On a near-tie the greedy reading stands:
  // it is the one every other rule in here was tuned against.
  if (cheapest.cost + PATH_MARGIN >= greedy) return best;

  return termDefinition(alternatives[cheapest.index], languages, apiBase);
}

async function lookupInDatabase(db: IDBDatabase, generation: string, source: string, languages: readonly GlossLanguage[], apiBase: string, contextual = false, whole = false): Promise<PendingDefinition | null> {
  const prefixes = whole ? [source] : prefixesLongestFirst(source);
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
  // the exact match can improve on it, so deinflect just those: keeping
  // longest-match semantics without paying for deinflection on every lookup.
  // Measure the exact match against hits we would actually USE. A spurious exact
  // match: 有益, a name read あります, is not contextually confident, but counting
  // it here made the span look covered and skipped deinflecting あります → ある, so
  // the sentence fell back to あり + ます. Only a hit that could win may suppress
  // deinflection of its own span.
  // Verbatim only, for the reason in `gatherCandidates`: a spelling we guessed at
  // must not stand in for the span and hide the inflected reading of it.
  const usableExact = (contextual ? exactHits.filter((hit) => contextuallyConfident(hit)) : exactHits)
    .filter((hit) => !hit.candidate.processingCost);
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
    const confident = [...deinflectedHits, ...exactHits].filter((hit) => contextuallyConfident(hit));
    if (confident.length) {
      confident.sort(contextualCompare);
      return termDefinition(confident[0], languages, apiBase);
    }
  }

  // Rank both sets together rather than letting a deinflection displace an exact
  // match outright. 全く is an adverb the page literally spells that way, but
  // JMdict marks the word usually-kana (まったく), so the contextual gate declines
  // it: and with exact hits discarded the only reading left was 全い, a rare
  // adjective it is the ku-form of. `score` already weights span length above
  // everything, so the case that rule protected (読みませんでした reaching 読む, not
  // the noun 読み) still holds: the longer deinflected span outscores the short
  // exact one on its own merits.
  const hits = [...deinflectedHits, ...exactHits];
  hits.sort((a, b) => score(b, source) - score(a, source));
  return hits[0] ? termDefinition(hits[0], languages, apiBase) : null;
}

// Kanji are a separate corpus, never a word-search result: the server draws the
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
  // measured against that raw text, so normalize the probe only: `prefix` stays
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
      // すごーい/すごい). Deduping on prefix alone kept only the verbatim probe.
      // And when that one matched a rare/search-only spelling the confidence gate
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
// Kanji spellings that do not represent how the word is normally written, which
// is what makes a word "usually kana". `sK` belongs here as surely as `rK`: a
// search-only form is not merely rare, it is one JMdict refuses to display at
// all, so a word whose every kanji form is `sK` is written in kana and nothing
// else. Leaving it out said カレー was not filed under カレー (its only kanji
// forms, 咖哩 and 咖喱, are both `sK`), and a JMnedict "Curry" that IS written
// カレー then took the rung and the word.
const RARE_KANJI_TAGS = new Set(["rK", "oK", "sK"]);
const CONTEXTUAL_FREQUENCY_LIMIT = 50_000;

// A deinflected candidate must land on a term whose part-of-speech can actually
// take that inflection: いつだった → いつだつ (godan った→つ, conditions v5) must not
// match 逸脱 (a noun/suru-verb). Exact candidates carry no conditions and always
// pass: only deinflections are gated, and like Yomitan an entry with no matching
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

// The kana that spells the form the surface matched: mirrors WordCard#reading_for.
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

// The form to LEAD the card with: mirrors WordCard#headword / #canonical_headword.
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
  // Primary sense only: the backend reads `senses.first` (Entry#usually_kana?),
  // not "any sense", so a `uk` annotation on a minor later sense must not flip the
  // whole entry to kana. The pack writes senses in sense order, so senses[0] is
  // that primary sense (the exporter drops only senses with no glosses at all).
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

function contextuallyConfident(hit: LookupHit, unbound = false): boolean {
  // A run of bare particles led by a case particle is not a word here, whatever
  // JMdict says about では (rank 80) or には (rank 30): で in 本では binds the noun
  // in front of it, so the reader is looking at で + は. Tokenizer#mergeable_expression?
  // declines exactly this merge from the other side, and the web's output over
  // 1,500 sentences bears it out: では/には/とは/でも come out apart 44/59/21/27
  // times against 2/2/0/2 merged. A deliberate lookup of では still finds the
  // entry; this is a rule about reading a sentence, not about the dictionary.
  //
  // Unless nothing in front of the run can take the case: it opens the clause,
  // or another particle already holds the slot (だけでも). There で is not binding
  // anything, and でも / では are the words JMdict lists.
  if (!unbound && particleCluster(hit.surface)) return false;
  const inflected = hit.candidate.reasons.length > 0;
  const usuallyKana = hit.term.senses.some((sense) => sense.misc.includes("uk"));
  const expression = matchingExpression(hit);
  if (!expression) {
    // The surface matched a reading, not a writing form. For a usually-kana word
    // (について, こと, など) the kana IS the normal spelling, so a kana surface is as
    // confident as a common expression: otherwise the multi-kana word loses to a
    // bare particle prefix and について is split into に + つい + て.
    return usuallyKana && matchingReading(hit);
  }
  if (expression.tags.some((tag) => SEARCH_ONLY_TAGS.has(tag))) return false;
  if (forcedExpression(hit)) return true;
  // Demoting a usually-kana word applies to its KANJI spellings only: for について
  // / ついて / こと the kana IS the normal spelling, and JMdict lists it as a real
  // expression (not just a reading), so demoting it here shredded について into
  // に + つい + て. Mirrors the web tokenizer's `script != "kana"` rule.
  // …and it does not apply to a form we reached by DEINFLECTING: the page spells
  // the word however it spells it, and the dictionary form we landed on is not a
  // spelling choice the reader made.
  // …nor to a kanji spelling JMdict itself marks common. `uk` says the word is
  // usually written in kana, not that this writing is rare: 全く is `uk` (まったく)
  // and *also* a common writing ranked 1,119, and demoting it left the adverb on
  // the page with no confident reading at all, shattered into 全 + く.
  const rareKanji = !inflected && expression.script !== "kana" && !expression.common
    && (usuallyKana || expression.tags.some((tag) => RARE_KANJI_TAGS.has(tag)));
  if (rareKanji) return false;
  // An inflected reading used to be trusted outright, on the assumption that it
  // could only ever be LONGER than the exact match it competed with. It can be the
  // same length, and then the assumption inverts: 全く (adverb, common, rank 1,119)
  // lost its own span to 全い, a rare adjective it happens to be the ku-form of.
  // Because nobody asked how rare 全い was. So an inflected reading clears the same
  // bar as any other: a word people actually use.
  const frequency = frequencyForHit(hit);
  return expression.common || (frequency !== null && frequency <= CONTEXTUAL_FREQUENCY_LIMIT);
}

function particleCluster(surface: string): boolean {
  const chars = [...surface];
  return chars.length > 1 && CASE_PARTICLES.has(chars[0]!) && chars.every((char) => BARE_PARTICLES.has(char));
}

// A word that conjugates: the deinflector can only have reached it as a form.
const VERBAL_POS = /^(v[0-9a-z-]+|adj-i)$/;
// The rules this promotion trusts, named exactly as `inflectionLabel` renders them.
// A whitelist, not a blacklist, and the blacklist that came first is why: the
// deinflector also has slang and dialect rules, and through those これ is the
// imperative of 凝る, たくさん of 託す and みんな of 見る: all common verbs, so every
// pronoun in the corpus lemma'd to a verb nobody wrote. What belongs here is the
// plain predicate endings, where the verb IS the word and the ending is grammar.
// Not `potential`: できる is listed as its own word and JMdict is right that it is
// one, so promoting there just re-opens 出来る → する. Not `continuative` or the
// noun-forming rules either: 帰り and 読み are the words the sentence means.
const PREDICATE_FORMS = new Set([ "negative", "past", "polite", "te-form", "progressive",
  "passive", "causative", "short causative", "volitional", "imperative",
  "desiderative (-tai)", "polite imperative (-nasai)", "negative (-naide)",
  "negative (-zu)", "negative (-nu)", "negative (-n)", "negative conditional (-neba)" ]);

// Is `rival` the same analysis taken further: the leader's own chain, then more?
// Chains read surface → dictionary form, so "one reading is a continuation of the
// other" is literally a prefix test: 変わっていた is [past] to 変わっている and
// [past, progressive, te-form] to 変わる, which is that same past plus the two steps
// the form entry stops at. Two chains that merely SHARE a length say nothing:
// they can be different readings of the span. So nothing but an extension counts.
const extendsChain = (leader: readonly string[], rival: readonly string[]): boolean =>
  rival.length > leader.length && leader.every((reason, index) => rival[index] === reason);

function firstSensePos(hit: LookupHit): string {
  for (const sense of hit.term.senses) {
    const code = sense.partsOfSpeech[0];
    if (code) return code;
  }
  return "";
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
  // Everything above prices the CUT, and from here the cut is settled: same span,
  // same spelling work, same inflection chain. What is left is which WORD it is,
  // so the rest of this runs the ladder `byLadder` runs, starting at the rung
  // that separates a spelling's own word from one it merely reads as.
  //
  // Without it こと resolved to 琴, the zither, 645 times in a 12,000-sentence
  // sweep: 事 is filed under こと (JMdict lists the kana form, `uk`) and 琴 merely
  // READS こと, they tie on every key above, they share a corpus rank because
  // rank is keyed on spelling, and the comparison fell all the way through to
  // `id.localeCompare`, where jmdict:1241450 sorts before jmdict:1313580.
  const filed = filedRung(a, b);
  if (filed) return filed;
  const common = Number(Boolean(matchingExpression(b)?.common)) - Number(Boolean(matchingExpression(a)?.common));
  if (common) return common;
  const aFrequency = frequencyForHit(a) ?? Number.POSITIVE_INFINITY;
  const bFrequency = frequencyForHit(b) ?? Number.POSITIVE_INFINITY;
  return aFrequency - bFrequency || score(b, b.surface) - score(a, a.surface) || a.term.id.localeCompare(b.term.id);
}

// Corpus rank for this hit: the applicable [text, reading] pair first, with a
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
  const manifestResponse = await fetch(`${base}/api/v1/dictionary-packs/current`, { cache: "no-store", signal });
  if (!manifestResponse.ok) throw new Error(await responseFailure("Dictionary manifest", manifestResponse));
  const manifest = (await manifestResponse.json()) as PackManifest;
  validateManifest(manifest);

  reportInstallProgress(installProgress, "Checking offline dictionary storage");
  // Avoid re-entering snapshot/installing flags via dictionaryStatus during install:
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
    audioRecipeCache = manifest.audio;
    lookupProbeCache.clear();
    candidateCache.clear();
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
  let importedSentences = 0;
  let batch: Array<OfflineTerm | OfflineKanji | OfflineSentence> = [];
  const seenIds = new Set<string>();

  const flush = async () => {
    if (!batch.length) return;
    await writeBatch(db, generation, batch);
    batch = [];
    const expected = Math.max(1, manifest.counts.terms + manifest.counts.kanji + manifest.counts.sentences);
    reportInstallProgress(0.2 + 0.75 * ((importedTerms + importedKanji + importedSentences) / expected));
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
      } else if (raw.type === "sentence") {
        const record = raw as OfflineSentence;
        validateSentence(record);
        if (seenIds.has(record.id)) throw new Error(`Dictionary contains duplicate record id ${record.id}.`);
        seenIds.add(record.id);
        batch.push(record);
        importedSentences += 1;
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
  if (importedTerms !== manifest.counts.terms || importedKanji !== manifest.counts.kanji ||
      importedSentences !== manifest.counts.sentences) {
    throw new Error("Dictionary record counts did not match its manifest.");
  }
}

async function writeBatch(db: IDBDatabase, generation: string, records: Array<OfflineTerm | OfflineKanji | OfflineSentence>): Promise<void> {
  const transaction = db.transaction(["terms", "kanji", "sentences"], "readwrite");
  const terms = transaction.objectStore("terms");
  const kanji = transaction.objectStore("kanji");
  const sentences = transaction.objectStore("sentences");
  for (const record of records) {
    if (record.type === "term") {
      terms.put({ ...record, generation, pk: `${generation}\0${record.id}`, keys: lookupKeysFor(record, generation) });
    } else if (record.type === "kanji") {
      kanji.put({ ...record, generation, pk: `${generation}\0${record.char}` });
    } else {
      sentences.put({ ...record, generation, pk: `${generation}\0${record.id}` });
    }
  }
  await transactionDone(transaction);
}

// The keys a term answers to, for the multiEntry index. Normalized, because
// every probe arrives normalized: a raw key like "Ｔシャツ" would be unreachable
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
        // record. A separate lookups table cost a row per key: 1.9M extra puts
        // on the full pack, ~2 of every 3 writes during install. And forced
        // each probe into two queries (keys → ids → records). multiEntry is the
        // same join, maintained by the engine, and returns the record itself.
        ensureIndex(terms, "lookupKeys", "keys", { multiEntry: true });
        const kanji = ensureStore(db, transaction, "kanji", "pk");
        ensureIndex(kanji, "generation", "generation");
        // Example sentences live in their own store, keyed like everything else by
        // generation, because a term cites them by id: one Tatoeba line is an
        // example for dozens of words, and inlining it would ship it dozens of times.
        const sentences = ensureStore(db, transaction, "sentences", "pk");
        ensureIndex(sentences, "generation", "generation");
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
        audioRecipeCache = undefined;
        lookupProbeCache.clear();
        candidateCache.clear();
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

async function audioRecipe(db: IDBDatabase): Promise<PackManifest["audio"] | null> {
  if (audioRecipeCache !== undefined) return audioRecipeCache;
  const stored = (await meta<PackManifest>(db, "manifest"))?.audio;
  audioRecipeCache = validAudioRecipe(stored) ? stored : null;
  return audioRecipeCache;
}

// The clip for a reading at one accent: the same digest `Audio::Clip#digest`
// computes, so the file both sides name is the same one on the CDN. Cached
// because a page repeats its common words, and hashing is the only work here.
const clipUrlCache = new BoundedCache<string>(2_000);
async function clipUrl(recipe: PackManifest["audio"], reading: string, downstep: number, voice?: string): Promise<string | null> {
  const speaker = recipe.voices[voice ?? recipe.defaultVoice] ?? recipe.voices[recipe.defaultVoice];
  const key = `${reading}\0${downstep}\0${speaker}`;
  const cached = clipUrlCache.get(key);
  if (cached) return cached;
  // Content scripts on an http: page have no SubtleCrypto (it needs a secure
  // context). Lookups run in the worker, which always has one: but a missing
  // digest must read as "no clip", never as a broken URL.
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) return null;
  const input = [reading, String(downstep), String(speaker), String(recipe.engineVersion), recipe.salt].join(recipe.separator);
  const digest = await subtle.digest("SHA-256", new TextEncoder().encode(input));
  const hex = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  const url = `${recipe.baseUrl}/${recipe.path}/${hex}.${recipe.extension}`;
  clipUrlCache.set(key, url);
  return url;
}

// Only a definition on its way to a popup gets clip URLs and example sentences.
// Page parsing builds a definition per token and keeps neither, so doing this
// there would be thousands of digests and reads thrown away per page.
async function forPopup(
  db: IDBDatabase, generation: string, definition: PendingDefinition | null, languages: readonly GlossLanguage[], voice?: string,
): Promise<Definition | null> {
  if (!definition) return null;
  const [pitch, examples] = await Promise.all([
    clipUrlsFor(db, definition, voice),
    examplesFor(db, generation, definition, languages),
  ]);
  const { exampleIds: _ids, ...rest } = definition;
  return { ...rest, pitch, examples };
}

async function clipUrlsFor(db: IDBDatabase, definition: PendingDefinition, voice?: string): Promise<Definition["pitch"]> {
  const reading = definition.reading;
  if (!definition.pitch.length || !reading) return definition.pitch;
  const recipe = await audioRecipe(db);
  if (!recipe) return definition.pitch;
  return Promise.all(definition.pitch.map(async (pattern) => (
    { ...pattern, audioUrl: await clipUrl(recipe, reading, pattern.downstep, voice) }
  )));
}

// The term cites its examples by id: one Tatoeba line illustrates dozens of
// words, so the pack stores each once.
async function examplesFor(
  db: IDBDatabase, generation: string, definition: PendingDefinition, languages: readonly GlossLanguage[],
): Promise<Definition["examples"]> {
  const ids = definition.exampleIds;
  if (!ids?.length) return definition.examples;
  const stored = await Promise.all(ids.map((id) => getByPk<Stored<OfflineSentence>>(db, "sentences", `${generation}\0${id}`)));
  return stored.filter((sentence): sentence is Stored<OfflineSentence> => !!sentence).map((sentence) => ({
    japanese: sentence.japanese,
    translation: withEnglishFallback(languages).map((language) => sentence.translations[language]).find(Boolean) ?? null,
    // Surface and lemma only. The pack also stores a reading and a POS per
    // token, which the popup would have to draw furigana with and does not: the
    // example is one line of context, not a second parse of the page.
    ...(sentence.tokens ? { tokens: sentence.tokens.map((token) =>
      token.lemma ? { surface: token.surface, lemma: token.lemma } : { surface: token.surface }) } : {}),
  }));
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
  for (const store of ["terms", "kanji", "sentences"]) await deleteByIndex(db, store, generation, false);
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
      manifest.sources.some((source) => !plainString(source.name) || !plainString(source.license) || !httpUrl(source.url) || (source.licenseUrl != null && !httpUrl(source.licenseUrl))) ||
      !validAudioRecipe(manifest.audio)) {
    throw new Error("Dictionary manifest is invalid.");
  }
}

// The recipe names files in OUR bucket and nowhere else: `baseUrl` faces the same
// guard the background fetch does (`isR2AudioUrl`), and the rest of the URL is a
// hex digest we compute plus a path segment with no separators: so a tampered
// manifest cannot turn a play button into a request to somebody else's host.
function validAudioRecipe(value: unknown): value is PackManifest["audio"] {
  if (!value || typeof value !== "object" || !exactKeys(value, ["baseUrl", "path", "extension", "separator", "engineVersion", "salt", "defaultVoice", "voices"])) return false;
  const audio = value as Record<string, unknown>;
  const voices = audio.voices;
  return r2AudioUrl(`${audio.baseUrl}/`) &&
    /^[a-z]+$/.test(String(audio.path)) && /^[a-z0-9]+$/.test(String(audio.extension)) &&
    plainString(audio.separator) && audio.separator.length === 1 &&
    Number.isInteger(audio.engineVersion) && plainString(audio.salt) && plainString(audio.defaultVoice) &&
    !!voices && typeof voices === "object" && !Array.isArray(voices) &&
    Object.entries(voices).every(([name, speaker]) => /^[a-z]+$/.test(name) && Number.isInteger(speaker)) &&
    audio.defaultVoice in voices;
}

function validCounts(value: unknown): value is PackManifest["counts"] {
  if (!value || typeof value !== "object" || Array.isArray(value) || !exactKeys(value, ["terms", "kanji", "sentences"])) return false;
  const counts = value as Record<string, unknown>;
  return [counts.terms, counts.kanji, counts.sentences].every((count) => Number.isSafeInteger(count) && Number(count) >= 0);
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
  const allowed = new Set(["type", "id", "dictionary", "headword", "expressions", "readings", "senses", "pitch", "frequencies", "jlpt", "examples"]);
  if (Object.keys(term).some((key) => !allowed.has(key)) || !plainString(term.id) || !plainString(term.dictionary) || !plainString(term.headword) ||
      !Array.isArray(term.expressions) || !term.expressions.length || term.expressions.some((item) => !exactKeys(item, ["text", "script", "common", "tags"]) || !plainString(item.text) || !plainString(item.script) || typeof item.common !== "boolean" || !stringArray(item.tags)) ||
      !Array.isArray(term.readings) || term.readings.some((item) => !exactKeys(item, ["text", "kind", "appliesTo"]) || !plainString(item.text) || !plainString(item.kind) || (item.appliesTo != null && !stringArray(item.appliesTo))) ||
      !Array.isArray(term.senses) || !term.senses.length || term.senses.some((sense) => !validSense(sense)) ||
      (term.pitch != null && (!Array.isArray(term.pitch) || term.pitch.some((item) => !exactKeys(item, ["text", "reading", "downstep"]) || !plainString(item.text) || !plainString(item.reading) || !Number.isInteger(item.downstep)))) ||
      (term.examples != null && !stringArray(term.examples)) ||
      (term.frequencies != null && (!Array.isArray(term.frequencies) || term.frequencies.some((item) => !exactKeys(item, ["source", "text", "reading", "rank"]) || !plainString(item.source) || !plainString(item.text) || (item.reading !== null && !plainString(item.reading)) || !Number.isFinite(item.rank)))) ||
      (term.jlpt != null && (!Number.isInteger(term.jlpt) || term.jlpt < 1 || term.jlpt > 5))) {
    throw new Error("Dictionary term record is invalid.");
  }
  rejectUnsafeStructuredContent(term);
}

// A sense's own keys, checked against a fixed set like the rest of the record.
// `notes` and `xrefs` are optional (schema 5) and absent on most senses, so the
// shape they take when present is what there is to check.
function validSense(sense: OfflineSense): boolean {
  const allowed = new Set(["glosses", "partsOfSpeech", "fields", "misc", "dialects", "restrictions", "notes", "xrefs"]);
  return !Object.keys(sense).some((key) => !allowed.has(key)) &&
    glossMap(sense.glosses, new Set(["eng", "spa"])) &&
    [sense.partsOfSpeech, sense.fields, sense.misc, sense.dialects, sense.restrictions].every(stringArray) &&
    (sense.notes == null || glossMap(sense.notes, new Set(["eng", "spa"]))) &&
    (sense.xrefs == null || (Array.isArray(sense.xrefs) && sense.xrefs.every((xref) =>
      exactKeys(xref, ["kind", "text", "reading"]) && plainString(xref.kind) && plainString(xref.text) &&
      (xref.reading == null || plainString(xref.reading)))));
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

function validateSentence(sentence: OfflineSentence): void {
  if (!exactKeys(sentence, ["type", "id", "japanese", "translations", "tokens"]) ||
      !plainString(sentence.id) || !plainString(sentence.japanese) ||
      !sentence.translations || typeof sentence.translations !== "object" || Array.isArray(sentence.translations) ||
      !Object.entries(sentence.translations).every(([language, text]) => ["eng", "spa"].includes(language) && plainString(text)) ||
      !validSentenceTokens(sentence)) {
    throw new Error("Dictionary sentence record is invalid.");
  }
  rejectUnsafeStructuredContent(sentence);
}

// The shipped cut, if this pack carries one. Surfaces must rejoin to the line
// exactly, or the tokens describe some other sentence and drawing the line
// through them would silently show the learner text that is not there.
function validSentenceTokens(sentence: OfflineSentence): boolean {
  if (sentence.tokens === undefined) return true;
  if (!Array.isArray(sentence.tokens) || sentence.tokens.length === 0) return false;

  return sentence.tokens.every((token) =>
    token && typeof token === "object" && !Array.isArray(token) &&
    exactKeys(token, ["surface", "reading", "lemma", "pos"]) &&
    plainString(token.surface) &&
    (["reading", "lemma", "pos"] as const).every((key) => token[key] === undefined || plainString(token[key]))
  ) && sentence.tokens.map((token) => token.surface).join("") === sentence.japanese;
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
// word boundary they also match ordinary glosses: "to hurl (at)" and "to curl
// (hair)" both contain "url (": which aborted the whole install on four real
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

// The senses ONCE, each carrying its meaning in every language the reader asked
// for. It used to be the whole list per language: an entry with eight senses and
// two languages rendered sixteen, the second eight a repeat of the first with
// different words in them, and the sense picker offered sixteen boxes for eight
// meanings (whose `position` it then read off the array index, so the second
// eight scoped a save to senses the word does not have).
//
// `exampleIds` never leaves this module: `forPopup` trades it for the sentences
// themselves, and everything downstream sees a plain Definition.
type PendingDefinition = Definition & { exampleIds?: string[] };

function termDefinition(hit: LookupHit, languages: readonly GlossLanguage[], apiBase: string): PendingDefinition {
  const term = hit.term;
  const blocks = languages.length ? languages : ["eng" as const];
  const applicable = term.senses.filter((sense) => !sense.restrictions.length || sense.restrictions.includes(hit.surface) || sense.restrictions.includes(term.headword));
  const senses: Sense[] = applicable.flatMap((sense) => {
    const glosses = glossRows(sense, blocks);
    if (!glosses.length) return [];
    return [{
      // Sense's 0-based position in the entry (display-only offline: saving is
      // gated on a connected Pro account, so the picker never appears here).
      position: term.senses.indexOf(sense),
      ...(term.dictionary === "jmdict" ? {} : { dictionary: dictionaryName(term.dictionary) }),
      // Pack stores raw JMdict codes (v5r, vi, uk…); resolve to the same
      // short labels the site chips show so offline popups match the web.
      partsOfSpeech: posChips(sense.partsOfSpeech),
      posCodes: sense.partsOfSpeech,
      tags: tagChips(sense),
      glosses,
      // In ONE language, unlike the glosses: a note is an aside about the word,
      // and printing the same aside twice in two languages under a meaning
      // already said twice buries the meaning. The reader's own language wins,
      // English answers when it has nothing.
      ...(noteRows(sense, blocks).length ? { notes: noteRows(sense, blocks) } : {}),
      ...(sense.xrefs?.length ? { xrefs: crossReferences(sense.xrefs) } : {}),
    }];
  });
  return termCard(hit, term, senses, apiBase);
}

// One row per language the reader asked for, in their order, tagged with the
// language the TEXT is in.
//
// The fallback is the same walk as the web's WordCard#fallback_db_langs_after
// (the languages after this one in the stack, English last), and it now says
// what it did. Filling a Spanish row from English used to print English under
// the heading "Español · JMdict"; here the row is tagged EN, and a sense that
// resolves to the same text twice draws it once. A reader with one language
// sees exactly what they always saw.
function glossRows(sense: OfflineSense, blocks: readonly GlossLanguage[]): GlossRow[] {
  const rows: GlossRow[] = [];
  for (const [index, language] of blocks.entries()) {
    const fallbacks = withEnglishFallback(blocks.slice(index + 1)).filter((code) => code !== language);
    const source = [ language, ...fallbacks ].find((code) => sense.glosses[code]?.length);
    if (!source) continue;
    const text = (sense.glosses[source] ?? []).join("; ");
    if (rows.some((row) => row.text === text)) continue;
    rows.push({ lang: source, tag: GLOSS_TAGS[source], text });
  }
  return rows;
}

// The sense's usage notes in the first language that has any, English last.
function noteRows(sense: OfflineSense, blocks: readonly GlossLanguage[]): string[] {
  const source = withEnglishFallback(blocks).find((code) => sense.notes?.[code]?.length);
  return source ? sense.notes?.[source] ?? [] : [];
}

// The kinds JMdict actually files, and nothing else. `written_as` and
// `compound_of` exist in the schema and are not links a reader follows from a
// meaning; an unknown kind is dropped rather than guessed at, because the label
// on the row is a claim about what the link MEANS.
function crossReferences(xrefs: NonNullable<OfflineSense["xrefs"]>): SenseXref[] {
  return xrefs.filter((xref) => xref.kind === "related" || xref.kind === "antonym")
    .map((xref) => ({
      kind: xref.kind as SenseXref["kind"],
      text: xref.text,
      ...(xref.reading ? { reading: xref.reading } : {}),
    }));
}

function termCard(hit: LookupHit, term: Stored<OfflineTerm>, senses: Sense[], apiBase: string): PendingDefinition {
  const reading = readingFor(term, matchingExpression(hit)?.text);
  const headword = displayHeadword(hit, reading);
  // A pattern is a property of the READING: its clip is literally
  // Audio::Clip.word(reading, accent): so a row filed under a sibling writing of
  // the same reading describes this form too. The row for the exact spelling wins
  // when there is one; otherwise any row for the reading we are DISPLAYING does.
  // Without that fallback every kana-led word went silent offline: the pack files
  // 松's pattern under (松, まつ), the popup leads a usually-kana hit with まつ, and
  // an exact (まつ, まつ) row exists for almost nothing. Rows for the entry's OTHER
  // readings stay excluded: あした's accent must never be shown against あす.
  const pitchRows = term.pitch ?? [];
  const exactPitch = pitchRows.filter((item) => item.text === headword && item.reading === reading);
  // One graph per accent. 温まる and 暖まる both file あったまる at [4]; they are the
  // same pattern and the same clip, so showing the row twice just draws it twice.
  const displayedPitch = (exactPitch.length ? exactPitch : pitchRows.filter((item) => item.reading === reading))
    .filter((item, index, rows) => rows.findIndex((other) => other.downstep === item.downstep) === index);
  // The other spellings, which is the question a reader asks the moment the
  // headword is not the one they just met: 開く is also 空く and 明く, and a card
  // that cannot say so sends them back to the sentence none the wiser. Search-only
  // forms are excluded because JMdict refuses to display them at all: they exist
  // so a query finds the word, not so a reader is shown them.
  const forms = term.expressions
    .filter((item) => !item.tags.some((tag) => SEARCH_ONLY_TAGS.has(tag)))
    .filter((item) => item.text !== headword && item.text !== reading)
    .map((item) => ({ text: item.text, common: item.common, rare: item.tags.some((tag) => RARE_KANJI_TAGS.has(tag)) }));

  return {
    headword,
    reading,
    ...(forms.length ? { forms } : {}),
    entry: term.id,
    url: `${apiBase.replace(/\/$/, "")}/word/${encodeURIComponent(headword)}`,
    common: term.expressions.some((item) => item.common),
    jlpt: term.jlpt ? `N${term.jlpt}` : null,
    frequency: frequencyForHit(hit),
    // `audioUrl` and `examples` are filled in by `forPopup`: the pack stores a
    // pattern rather than a link to its clip, and cites its sentences by id.
    pitch: displayedPitch.map((item) => ({ downstep: item.downstep, audioUrl: null })),
    senses,
    examples: [],
    exampleIds: term.examples,
    sourceForm: hit.surface,
    inflection: hit.candidate.reasons,
    offline: true,
  };
}

// KANJIDIC ships pinyin, Korean and Vietnamese readings alongside the Japanese
// ones, and lists them first. Taking whatever came first showed 猫 as "mao1"
// rather than ビョウ: a Chinese reading on 96% of the pack's kanji. Only on/kun
// are Japanese; kun carries okurigana after a dot (た.べる), which is not part of
// the character's own reading.
function kanjiReading(readings: OfflineKanji["readings"]): string | null {
  return readings.on?.[0] ?? readings.kun?.[0]?.split(".")[0] ?? null;
}

function kanjiDefinition(kanji: Stored<OfflineKanji>, languages: readonly GlossLanguage[], apiBase: string): Definition {
  const order = withEnglishFallback(languages);
  // A kanji is one meaning row: KANJIDIC glosses it in one language at a time
  // and the reader's first language that has one wins, so there is nothing to
  // tag a second row with.
  const language = order.find((code) => kanji.meanings[code]?.length) ?? "eng";
  const glosses = [ { lang: language, tag: GLOSS_TAGS[language], text: (kanji.meanings[language] ?? []).join("; ") } ];
  return {
    headword: kanji.char,
    reading: kanjiReading(kanji.readings),
    // On and kun kept APART, because that distinction is most of what a learner
    // is asking a kanji card: 音 vs 訓 decides which reading a compound takes.
    // The other reading families KANJIDIC ships (pinyin, korean, vietnamese,
    // nanori) stay out: three of them are not Japanese, and nanori is names.
    kanji: {
      on: kanji.readings.on ?? [],
      kun: kanji.readings.kun ?? [],
      ...(kanji.strokes ? { strokes: kanji.strokes } : {}),
      ...(kanji.grade ? { grade: kanji.grade } : {}),
    },
    url: `${apiBase.replace(/\/$/, "")}/kanji/${encodeURIComponent(kanji.char)}`,
    common: false,
    jlpt: kanji.jlpt ? `N${kanji.jlpt}` : null,
    frequency: kanji.frequency ?? null,
    pitch: [],
    senses: [{ position: 0, dictionary: "KANJIDIC2", partsOfSpeech: [], tags: [], glosses }],
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
// is script-neutral) or full-width alphanumerics is reliably a single unit: a
// loanword, name, or number the pack doesn't carry: so `unknownRun` consumes
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
