import "fake-indexeddb/auto";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { deinflect } from "../src/common/deinflect.js";
import { installDictionary, lookupVariants, parseOffline, removeDictionary } from "../src/common/offline-dictionary.js";

// Runner for divergence-sweep.mjs — see that file for what this is and how to run it.

type WebToken = { surface: string; lemma: string | null; content: boolean };
type WebRow = { text: string; tokens?: WebToken[]; error?: string };

const limit = Number(process.argv[2] ?? Infinity);
const rows = (JSON.parse(readFileSync("../tmp/tokenizer_web.json", "utf8")) as WebRow[])
  .filter((row) => row.tokens?.length)
  .slice(0, Number.isFinite(limit) ? limit : undefined);

function realPackPath(): string {
  if (process.env.SHIRABE_PACK && existsSync(process.env.SHIRABE_PACK)) return process.env.SHIRABE_PACK;
  const dir = "../storage/dictionary_packs/current";
  const packs = readdirSync(dir).filter((name) => name.endsWith(".ndjson.gz")).map((name) => join(dir, name))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  if (!packs[0]) throw new Error("no dictionary pack — run `npm run prepare:dev-pack`");
  return packs[0];
}

// A full pack gunzips past Node's maximum string length, so it has to be decoded
// a line at a time (same as the golden and cross-engine corpora).
function* packLines(path: string): Generator<string> {
  const raw = gunzipSync(readFileSync(path));
  let start = 0;
  for (let at = 0; at < raw.length; at += 1) {
    if (raw[at] !== 0x0a) continue;
    if (at > start) yield raw.toString("utf8", start, at);
    start = at + 1;
  }
  if (start < raw.length) yield raw.toString("utf8", start);
}

// A sweep is broad, so subset the pack to what these sentences can reach —
// substrings, their deinflections, and their text-processor variants. Missing any
// of those starves the parser and manufactures divergences that do not exist.
function subset(path: string, sentences: string[]): string[] {
  const keys = new Set<string>();
  for (const sentence of sentences) {
    const chars = [...sentence];
    for (let start = 0; start < chars.length; start += 1) {
      for (let end = start + 1; end <= Math.min(chars.length, start + 16); end += 1) {
        for (const variant of lookupVariants(chars.slice(start, end).join(""))) {
          keys.add(variant.text);
          for (const found of deinflect(variant.text)) keys.add(found.term);
        }
      }
    }
  }
  const kept: string[] = [];
  for (const line of packLines(path)) {
    if (!line) continue;
    if (line.startsWith('{"type":"header"')) { kept.push(line); continue; }
    const record = JSON.parse(line) as { type: string; headword?: string; expressions?: Array<{ text: string }>; readings?: Array<{ text: string }> };
    if (record.type !== "term") continue;
    const spellings = [record.headword ?? "", ...(record.expressions ?? []).map((i) => i.text), ...(record.readings ?? []).map((i) => i.text)];
    if (spellings.some((spelling) => keys.has(spelling))) kept.push(line);
  }
  return kept;
}

const bump = (map: Map<string, { count: number; example: string }>, key: string, example: string): void => {
  const current = map.get(key);
  if (current) current.count += 1;
  else map.set(key, { count: 1, example });
};

(async () => {
  const pack = realPackPath();
  process.stdout.write(`Subsetting ${pack} for ${rows.length} sentences…\n`);
  const kept = subset(pack, rows.map((row) => row.text));
  const payload = gzipSync(kept.join("\n") + "\n");
  const manifest = {
    schemaVersion: 3, buildRecipeVersion: 6, minimumExtensionVersion: "0.2.1", contentRevision: "sweep",
    builtAt: "2026-07-15T00:00:00Z", artifact: "dictionary.ndjson.gz", compression: "gzip",
    mediaType: "application/x-ndjson", bytes: payload.byteLength,
    sha256: createHash("sha256").update(payload).digest("hex"),
    counts: { terms: kept.length - 1, kanji: 0 }, languages: ["eng", "spa"],
    dictionaries: [{ slug: "jmdict", version: "sweep" }], modifications: [], sources: [],
    downloadUrl: "https://packs.test/dictionary.gz",
  };
  await removeDictionary();
  globalThis.fetch = (async (input: string | URL | Request) => (String(input).endsWith("/current")
    ? new Response(JSON.stringify(manifest), { headers: { "Content-Type": "application/json" } })
    : new Response(payload, { headers: { "Content-Type": "application/gzip" } }))) as typeof fetch;
  await installDictionary("https://api.test");
  process.stdout.write(`Installed ${kept.length - 1} entries. Sweeping…\n\n`);

  // A lemma disagreement is the one that costs users a duplicate SRS card.
  const lemmaConflicts = new Map<string, { count: number; example: string }>();
  // A content word one engine finds whole and the other shatters.
  const shattered = new Map<string, { count: number; example: string }>();
  let identical = 0;
  // Identical token streams is the strictest possible measure, and the engines
  // differ in granularity BY DESIGN (読みませんでした is one token here, two chips
  // there), so it understates agreement badly. What actually matters is whether
  // both engines resolve the same WORDS — that is what a lookup shows and what an
  // SRS card is keyed on. Measure lemma overlap per sentence too.
  let lemmaOverlapSum = 0;
  let lemmaSentences = 0;
  let bothAgreeFully = 0;

  for (const row of rows) {
    const mine = await parseOffline(row.text, ["eng"], "https://shirabe.test");
    const theirs = row.tokens ?? [];
    if (mine.map((t) => t.surface).join("|") === theirs.map((t) => t.surface).join("|")) identical += 1;

    const mineLemmas = new Set(mine.filter((t) => t.content).map((t) => t.lemma));
    const theirLemmas = new Set(theirs.filter((t) => t.content && t.lemma).map((t) => t.lemma as string));
    if (theirLemmas.size) {
      const shared = [...theirLemmas].filter((lemma) => mineLemmas.has(lemma)).length;
      lemmaOverlapSum += shared / theirLemmas.size;
      lemmaSentences += 1;
      if (shared === theirLemmas.size) bothAgreeFully += 1;
    }

    const mineBySurface = new Map(mine.filter((t) => t.content).map((t) => [t.surface, t.lemma]));
    for (const token of theirs) {
      if (!token.content || !token.lemma) continue;
      const myLemma = mineBySurface.get(token.surface);
      if (myLemma && myLemma !== token.lemma) {
        bump(lemmaConflicts, `${token.surface}  web=${token.lemma}  ext=${myLemma}`, row.text);
      }
      // The web found this content word whole; did we split it?
      if (!myLemma && token.surface.length > 1 && row.text.includes(token.surface)
          && !mine.some((t) => t.surface === token.surface)) {
        bump(shattered, `${token.surface} (web lemma ${token.lemma})`, row.text);
      }
    }
  }

  const report = (title: string, map: Map<string, { count: number; example: string }>, top: number): void => {
    const sorted = [...map.entries()].sort((a, b) => b[1].count - a[1].count);
    process.stdout.write(`\n${title} — ${map.size} distinct, showing top ${Math.min(top, sorted.length)}\n`);
    for (const [key, { count, example }] of sorted.slice(0, top)) {
      process.stdout.write(`  ${String(count).padStart(4)}×  ${key}\n          e.g. ${example}\n`);
    }
  };

  const overlap = lemmaSentences ? Math.round(lemmaOverlapSum / lemmaSentences * 100) : 0;
  process.stdout.write(`Swept ${rows.length} sentences\n`);
  process.stdout.write(`  identical token streams : ${identical} (${Math.round(identical / rows.length * 100)}%)  — strictest, granularity differs by design\n`);
  process.stdout.write(`  web lemmas we also find : ${overlap}% (mean per sentence)  — the number that matters for lookup + SRS\n`);
  process.stdout.write(`  sentences where we find EVERY web lemma : ${bothAgreeFully} (${Math.round(bothAgreeFully / (lemmaSentences || 1) * 100)}%)\n`);
  report("LEMMA CONFLICTS (same surface, different dictionary form — forks the SRS card)", lemmaConflicts, 15);
  report("SHATTERED (web found one content word, extension split it)", shattered, 20);
})();
