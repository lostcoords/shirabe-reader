import "fake-indexeddb/auto";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { gunzipSync, gzipSync } from "node:zlib";
import { parse as parseYaml } from "yaml";
import { deinflect } from "../src/common/deinflect.js";
import { installDictionary, lookupVariants, parseOffline, removeDictionary } from "../src/common/offline-dictionary.js";

// The extension half of the cross-engine contract. The corpus lives outside the
// extension (test/tokenizer_eval/cross_engine.yml) because the Rails tokenizer
// answers the same file via `bin/rails tokenizer_eval:cross_engine` — one source
// of truth, so a fix on one side cannot silently regress the other.
//
// Needs the real dictionary (the contract is about real JMdict behaviour), so it
// reports as skipped — never as a pass — when no pack is built locally, and fails
// outright when SHIRABE_REQUIRE_PACK demands the real run.

type CrossCase = {
  name: string;
  sentence: string;
  merges?: string[];
  splits?: string[];
  lemmas?: Record<string, string>;
};
type Corpus = { cases: CrossCase[]; divergences?: Array<{ name: string }> };

const CORPUS_PATH = "../test/tokenizer_eval/cross_engine.yml";

function realPackPath(): string | null {
  if (process.env.SHIRABE_PACK) return existsSync(process.env.SHIRABE_PACK) ? process.env.SHIRABE_PACK : null;
  const dir = "../storage/dictionary_packs/current";
  if (!existsSync(dir)) return null;
  const packs = readdirSync(dir)
    .filter((name) => name.endsWith(".ndjson.gz"))
    .map((name) => join(dir, name))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  return packs[0] ?? null;
}

// Same subset trick as the golden corpus: keep every entry that could compete for
// a span, including the dictionary forms the spans deinflect to and the spellings
// the text processors produce — otherwise the parser is starved and looks broken.
function subsetFromRealPack(path: string, sentences: string[]): string[] {
  const keys = new Set<string>();
  for (const sentence of sentences) {
    const chars = [...sentence];
    for (let start = 0; start < chars.length; start += 1) {
      for (let end = start + 1; end <= Math.min(chars.length, start + 24); end += 1) {
        for (const variant of lookupVariants(chars.slice(start, end).join(""))) {
          keys.add(variant.text);
          for (const found of deinflect(variant.text)) keys.add(found.term);
        }
      }
    }
  }
  const kept: string[] = [];
  for (const line of gunzipSync(readFileSync(path)).toString("utf8").split("\n")) {
    if (!line) continue;
    if (line.startsWith('{"type":"header"')) { kept.push(line); continue; }
    const record = JSON.parse(line) as { type: string; headword?: string; expressions?: Array<{ text: string }>; readings?: Array<{ text: string }> };
    if (record.type !== "term") continue;
    const spellings = [record.headword ?? "", ...(record.expressions ?? []).map((item) => item.text), ...(record.readings ?? []).map((item) => item.text)];
    if (spellings.some((spelling) => keys.has(spelling))) kept.push(line);
  }
  return kept;
}

test("cross-engine tokenization contract (extension side)", async (context) => {
  const corpus = parseYaml(readFileSync(CORPUS_PATH, "utf8")) as Corpus;
  const packPath = realPackPath();
  if (!packPath) {
    // A missing pack must never read as a pass: it reports as skipped locally,
    // and CI sets SHIRABE_REQUIRE_PACK=1 to demand the real run.
    assert.ok(
      !process.env.SHIRABE_REQUIRE_PACK,
      "SHIRABE_REQUIRE_PACK is set but no dictionary pack is installed — build one with `npm run prepare:dev-pack`",
    );
    context.skip("no local dictionary pack — build one with `npm run prepare:dev-pack`");
    return;
  }

  await removeDictionary();
  const subset = subsetFromRealPack(packPath, corpus.cases.map((entry) => entry.sentence));
  const payload = gzipSync(subset.join("\n") + "\n");
  const manifest = {
    schemaVersion: 3, buildRecipeVersion: 6, minimumExtensionVersion: "0.2.1", contentRevision: "cross-engine",
    builtAt: "2026-07-15T00:00:00Z", artifact: "dictionary.ndjson.gz", compression: "gzip",
    mediaType: "application/x-ndjson", bytes: payload.byteLength,
    sha256: createHash("sha256").update(payload).digest("hex"),
    counts: { terms: subset.length - 1, kanji: 0 }, languages: ["eng", "spa"],
    dictionaries: [{ slug: "jmdict", version: "cross-engine" }], modifications: [], sources: [],
    downloadUrl: "https://packs.test/dictionary.gz",
  };
  globalThis.fetch = (async (input: string | URL | Request) => (String(input).endsWith("/current")
    ? new Response(JSON.stringify(manifest), { headers: { "Content-Type": "application/json" } })
    : new Response(payload, { headers: { "Content-Type": "application/gzip" } }))) as typeof fetch;
  await installDictionary("https://api.test");

  for (const entry of corpus.cases) {
    const tokens = await parseOffline(entry.sentence, ["eng"], "https://shirabe.test");
    const surfaces = tokens.map((token) => token.surface);
    const shown = surfaces.join(" | ");

    for (const surface of entry.merges ?? []) {
      assert.ok(surfaces.includes(surface), `[${entry.name}] "${surface}" must be ONE token — got ${shown}`);
    }
    for (const surface of entry.splits ?? []) {
      assert.ok(!surfaces.includes(surface), `[${entry.name}] "${surface}" must NOT be one token — got ${shown}`);
    }
    for (const [surface, lemma] of Object.entries(entry.lemmas ?? {})) {
      const token = tokens.find((item) => item.surface === surface);
      assert.ok(token, `[${entry.name}] expected a token "${surface}" to check its lemma — got ${shown}`);
      assert.equal(token.lemma, lemma,
        `[${entry.name}] "${surface}" must resolve to ${lemma} in BOTH engines — a lemma that disagrees with the web forks the SRS card`);
    }
  }

  context.diagnostic(`cross-engine: ${corpus.cases.length} cases checked against the real pack (${subset.length - 1} entries)`);
  context.diagnostic(`cross-engine: ${corpus.divergences?.length ?? 0} known divergences recorded, not asserted`);
});
