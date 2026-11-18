import { createHash } from "node:crypto";
import { createReadStream, existsSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { createGunzip, gzipSync } from "node:zlib";
import { parse as parseYaml } from "yaml";
import { deinflect } from "../../src/common/deinflect.js";
import { searchReadings } from "../../src/common/romaji.js";
import { installDictionary, lookupVariants, removeDictionary, type PackManifest } from "../../src/common/offline-dictionary.js";

// Dictionary-pack plumbing shared by every corpus harness: the segmentation
// suites and the divergence sweep. All three used to carry their own copy of
// this, which is how the sweep ended up subsetting at a different span cap than
// the suites without anyone noticing.

// A slice of the real pack holding every entry the corpora below could look up,
// so a clean checkout runs every corpus row against real JMdict data.
// `npm run fixture-pack -- <full pack>` cuts it again.
export const FIXTURE_PACK = "test/fixtures/dictionary-pack/slice.ndjson.gz";
export const FIXTURE_PACK_RECORD = "test/fixtures/dictionary-pack/slice.json";

export type FixturePackRecord = {
  cutFrom: { contentRevision: string; builtAt: string; sha256: string; sources: Array<{ name: string; license: string; url: string }> };
  texts: string[];
};

const CORPORA = ["cross_engine", "segmentation", "search_mapping", "contextual_boundaries", "click_positions"];

// The span cap the asserting corpora subset at. Long enough for the longest
// grammar expressions a case can pin.
export const CORPUS_MAX_SPAN = 24;

/** The dictionary pack the corpus suites run against: `$SHIRABE_PACK`, or the committed slice. */
export function corpusPackPath(): string {
  const override = process.env.SHIRABE_PACK;
  if (override && !existsSync(override)) throw new Error(`SHIRABE_PACK points at ${override}, which does not exist`);
  return override || FIXTURE_PACK;
}

/** Every sentence and query in the shared tokenizer corpora. */
export function corpusTexts(): string[] {
  return CORPORA.flatMap((name) =>
    (parseYaml(readFileSync(`test/fixtures/tokenizer_eval/${name}.yml`, "utf8")) as Array<{ sentence: string; queries?: string[] }>)
      .flatMap((row) => [row.sentence, ...(row.queries ?? [])]));
}

let fixtureKeys: Set<string> | undefined;

/**
 * Throw unless the committed slice was cut for these texts. The slice holds only
 * the entries its recorded texts could reach, so a text it was not cut for would
 * be judged against a dictionary missing the very entries that compete for it.
 */
export function assertFixtureCovers(texts: string[]): void {
  const record = JSON.parse(readFileSync(FIXTURE_PACK_RECORD, "utf8")) as FixturePackRecord;
  const recorded = new Set(record.texts);
  const unknown = texts.filter((text) => !recorded.has(text));
  if (!unknown.length) return;
  fixtureKeys ??= lookupKeys(record.texts);
  const uncovered = unknown.filter((text) => [...lookupKeys([text])].some((key) => !fixtureKeys!.has(key)));
  if (uncovered.length) {
    throw new Error(`the fixture pack was not cut for ${JSON.stringify(uncovered)}: run \`npm run fixture-pack -- <full pack> ${uncovered.map((text) => JSON.stringify(text)).join(" ")}\``);
  }
}

/**
 * Stream a pack a line at a time. A full pack gunzips to about 750 MB, past
 * Node's maximum string length, and several suites scan it at once.
 */
export async function* packLines(path: string): AsyncGenerator<string> {
  for await (const line of createInterface({ input: createReadStream(path).pipe(createGunzip()), crlfDelay: Infinity })) {
    if (line) yield line;
  }
}

/**
 * Every spelling the given sentences could look up: each substring, the
 * text-processor variants of each (katakana fold, emphatic collapse, kanji
 * standardisation), and the dictionary forms those deinflect to.
 *
 * The deinflected forms are easy to forget and essential: 読む never appears
 * inside 読みませんでした, so a substring-only filter starves the parser of the
 * entry it needs and makes a healthy parser look broken.
 */
export function lookupKeys(sentences: string[], maxSpan = CORPUS_MAX_SPAN): Set<string> {
  const keys = new Set<string>();
  // Expand each distinct span ONCE. A span's keys depend on its text alone, and
  // Japanese repeats itself relentlessly: every particle, every common word, and
  // every prefix of every common phrase recurs across a corpus. Total spans grow
  // linearly with the corpus while distinct spans grow far slower, so this is
  // what decides whether a sweep can be more than a sample.
  const expanded = new Set<string>();
  for (const sentence of sentences) {
    const chars = [...sentence];
    for (let start = 0; start < chars.length; start += 1) {
      for (let end = start + 1; end <= Math.min(chars.length, start + maxSpan); end += 1) {
        const span = chars.slice(start, end).join("");
        if (expanded.has(span)) continue;
        expanded.add(span);

        for (const source of /\p{Script=Latin}/u.test(span) ? [span, ...searchReadings(span)] : [span]) {
          for (const variant of lookupVariants(source)) {
            keys.add(variant.text);
            for (const found of deinflect(variant.text)) keys.add(found.term);
          }
        }
      }
    }
  }
  return keys;
}

/**
 * Build a pack from the REAL dictionary, keeping every entry that could compete
 * for a span in these sentences: not just the expected answers, or the corpus
 * would be rigged. 逸脱 has to be present for the いつだった case to mean anything.
 */
export async function subsetPack(path: string, sentences: string[], { maxSpan = CORPUS_MAX_SPAN } = {}): Promise<string[]> {
  if (path === FIXTURE_PACK) assertFixtureCovers(sentences);
  const keys = lookupKeys(sentences, maxSpan);
  const kept: string[] = [];
  for await (const line of packLines(path)) {
    if (line.startsWith('{"type":"header"')) { kept.push(line); continue; }
    const record = JSON.parse(line) as {
      type: string;
      headword?: string;
      expressions?: Array<{ text: string }>;
      readings?: Array<{ text: string }>;
    };
    if (record.type !== "term") continue;
    const spellings = [
      record.headword ?? "",
      ...(record.expressions ?? []).map((item) => item.text),
      ...(record.readings ?? []).map((item) => item.text),
    ];
    if (spellings.some((spelling) => keys.has(spelling))) kept.push(line);
  }
  return kept;
}

// The pack format every hand-built test pack is written in.
const SCHEMA_VERSION = 7;

/** The first line of a pack. */
export function packHeader(languages: string[] = ["eng", "spa"], source = "Shirabe test") {
  return { type: "header", schemaVersion: SCHEMA_VERSION, languages, source };
}

/** A JMdict-shaped term with one sense, as an ndjson line. `kanji` null writes the word in kana. */
export function term(id: string, headword: string, kanji: string | null, kana: string, gloss: string, common = true, pos = "n",
  dictionary = id.split(":")[0]!): string {
  return JSON.stringify({
    type: "term", id, dictionary, headword,
    expressions: kanji
      ? [ { text: kanji, script: "kanji", common, tags: [] } ]
      : [ { text: kana, script: "kana", common, tags: [] } ],
    readings: [ { text: kana, kind: "kana" } ],
    senses: [ { glosses: { eng: [ gloss ] }, partsOfSpeech: [ pos ], fields: [], misc: [], dialects: [], restrictions: [] } ],
  });
}

/**
 * Install these term lines as the only pack. The revision follows the content:
 * the installer treats a repeated revision as "already have this" and keeps
 * whatever is installed, so two tests sharing one would run against each
 * other's dictionary.
 */
export async function installTerms(lines: string[], languages?: string[]): Promise<void> {
  const contentRevision = createHash("sha256").update(lines.join("\n")).digest("hex").slice(0, 12);
  await installTestPack(packPayload([JSON.stringify(packHeader(languages)), ...lines]), { contentRevision, terms: lines.length });
}

/** Gzip a set of ndjson lines into the payload an install serves. */
export function packPayload(lines: string[]): Buffer {
  return gzipSync(lines.join("\n") + "\n");
}

export function testPackManifest(
  payload: Uint8Array,
  { contentRevision, terms }: { contentRevision: string; terms: number },
  overrides: Partial<PackManifest> = {},
): PackManifest {
  return {
    schemaVersion: SCHEMA_VERSION, buildRecipeVersion: 15, minimumExtensionVersion: "0.2.6", contentRevision,
    audio: {
      baseUrl: "https://cdn.shirabe.org/audio", path: "words", extension: "m4a", separator: "\x1f",
      engineVersion: 1, salt: "test-salt", defaultVoice: "male",
      voices: { male: 1_628_969_216, female: 345_585_728 },
    },
    builtAt: "2026-07-15T00:00:00Z", artifact: "dictionary.ndjson.gz", compression: "gzip",
    mediaType: "application/x-ndjson", bytes: payload.byteLength,
    sha256: createHash("sha256").update(payload).digest("hex"),
    counts: { terms, kanji: 0, sentences: 0 }, languages: ["eng", "spa"],
    dictionaries: [
      { slug: "jmdict", version: contentRevision },
      { slug: "jmnedict", version: contentRevision },
    ],
    modifications: [], sources: [], downloadUrl: "https://packs.test/dictionary.gz",
    ...overrides,
  };
}

/**
 * Serve `payload` as the current pack and install it, replacing whatever was
 * installed before.
 */
export async function installTestPack(
  payload: Buffer,
  { contentRevision, terms }: { contentRevision: string; terms: number },
): Promise<void> {
  const manifest = testPackManifest(payload, { contentRevision, terms });

  await removeDictionary();
  // A Buffer is a Uint8Array, but over `ArrayBufferLike`, which `BodyInit` does
  // not accept (it could be shared). Copy into a plain ArrayBuffer rather than
  // asserting the type away.
  const body = new Uint8Array(payload);
  globalThis.fetch = (async (input: string | URL | Request) => ((input instanceof Request ? input.url : String(input)).endsWith("/current")
    ? new Response(JSON.stringify(manifest), { headers: { "Content-Type": "application/json" } })
    : new Response(body, { headers: { "Content-Type": "application/gzip" } }))) as typeof fetch;
  await installDictionary("https://api.test");
}
