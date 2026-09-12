import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { deinflect } from "../../src/common/deinflect.js";
import { installDictionary, lookupVariants, removeDictionary, type PackManifest } from "../../src/common/offline-dictionary.js";

// Dictionary-pack plumbing shared by every corpus harness: the segmentation
// suites and the divergence sweep. All three used to carry their own copy of
// this, which is how the sweep ended up subsetting at a different span cap than
// the suites without anyone noticing.
//
// Every path here assumes `extension/` is the cwd, the way the test runners are
// invoked (test/run.mjs, test/divergence-sweep.mjs).

const PACK_DIR = "../storage/dictionary_packs/current";

// The span cap the asserting corpora subset at. Long enough for the longest
// grammar expressions a case can pin.
export const CORPUS_MAX_SPAN = 24;

/**
 * The newest locally-built dictionary pack, or null when none is built.
 * SHIRABE_PACK overrides the search; otherwise it is the dev pack that
 * `npm run prepare:dev-pack` writes.
 */
export function realPackPath(): string | null {
  if (process.env.SHIRABE_PACK) return existsSync(process.env.SHIRABE_PACK) ? process.env.SHIRABE_PACK : null;
  if (!existsSync(PACK_DIR)) return null;
  const packs = readdirSync(PACK_DIR)
    .filter((name) => name.endsWith(".ndjson.gz"))
    .map((name) => join(PACK_DIR, name))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  return packs[0] ?? null;
}

/**
 * A full pack gunzips past Node's maximum string length, so decoding the whole
 * thing at once throws ERR_STRING_TOO_LONG on exactly the real dictionary the
 * corpus cases need. Walk the buffer and decode a line at a time.
 */
export function* packLines(path: string): Generator<string> {
  const raw = gunzipSync(readFileSync(path));
  let start = 0;
  for (let at = 0; at < raw.length; at += 1) {
    if (raw[at] !== 0x0a) continue;
    if (at > start) yield raw.toString("utf8", start, at);
    start = at + 1;
  }
  if (start < raw.length) yield raw.toString("utf8", start);
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

        for (const variant of lookupVariants(span)) {
          keys.add(variant.text);
          for (const found of deinflect(variant.text)) keys.add(found.term);
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
export function subsetPack(path: string, sentences: string[], { maxSpan = CORPUS_MAX_SPAN } = {}): string[] {
  const keys = lookupKeys(sentences, maxSpan);
  const kept: string[] = [];
  for (const line of packLines(path)) {
    if (!line) continue;
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
    schemaVersion: 7, buildRecipeVersion: 15, minimumExtensionVersion: "0.2.6", contentRevision,
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
  globalThis.fetch = (async (input: string | URL | Request) => (String(input).endsWith("/current")
    ? new Response(JSON.stringify(manifest), { headers: { "Content-Type": "application/json" } })
    : new Response(body, { headers: { "Content-Type": "application/gzip" } }))) as typeof fetch;
  await installDictionary("https://api.test");
}
