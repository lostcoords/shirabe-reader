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

// The segmentation ratchet. `segmentation-golden.yml` pins the content words each
// sentence must produce; this runs every case that the bundled fixture pack can
// answer. Cases tagged `pack: full` need the real dictionary and are reported as
// skipped — run them with a real pack installed (see the corpus header).
//
// Why a corpus and not more unit tests: the parser's ranking core (text-processor
// variants, part-of-speech gating, tiebreakers) is easy to regress silently, and a
// mis-parse fixed today can return on the next dictionary refresh. A row here can
// never come back without turning this test red.

type GoldenCase = {
  name: string;
  text: string;
  expect?: string[];   // full content-word list — exact, but brittle to unrelated dictionary changes
  merges?: string[];   // these surfaces must each be ONE token (robust: pins only the boundary at issue)
  splits?: string[];   // these surfaces must NOT be a single token
  tokens?: string[];
  todo?: string[];
  pack?: string;
  why?: string;
};

const corpus = parseYaml(readFileSync("test/segmentation-golden.yml", "utf8")) as GoldenCase[];

/** Compact term record: only the fields segmentation actually depends on. */
function term(
  id: number,
  headword: string,
  reading: string,
  partsOfSpeech: string[],
  rank: number,
  { misc = [] as string[], tags = [] as string[], common = true } = {},
) {
  return {
    type: "term", id: `jmdict:${id}`, dictionary: "jmdict", headword,
    expressions: [{ text: headword, script: "mixed", common, tags }],
    readings: [{ text: reading, kind: "kana" }],
    senses: [{ glosses: { eng: [headword], spa: [headword] }, partsOfSpeech, fields: [], misc, dialects: [], restrictions: [] }],
    frequencies: [{ source: "jiten-global", text: headword, reading, rank }],
  };
}

const records = [
  { type: "header", schemaVersion: 3, languages: ["eng", "spa"], source: "Shirabe golden corpus" },
  // The 逸脱 trap: a noun/suru-verb that the godan った→つ rule would otherwise
  // reach from いつだった, burying the usually-kana いつ.
  term(1, "逸脱", "いつだつ", ["n", "vs"], 15_000),
  term(2, "何時", "いつ", ["pn", "adv"], 500, { misc: ["uk"], tags: ["rK"] }),
  // Emphasis katakana / stretched kana all have to reach this usually-kana entry.
  term(3, "凄い", "すごい", ["adj-i"], 800, { misc: ["uk"], tags: ["rK"], common: false }),
  // 見る exists so a lone katakana ミ folding to み would be caught, not silent.
  term(4, "見る", "みる", ["v1"], 800),
  term(5, "来る", "くる", ["vk"], 50),
  term(6, "猫", "ねこ", ["n"], 700),
  term(7, "に", "に", ["prt"], 1),
  term(8, "読む", "よむ", ["v5m"], 500),
  term(9, "高い", "たかい", ["adj-i"], 600),
  term(10, "Ｔシャツ", "ティーシャツ", ["n"], 900),
  {
    type: "term", id: "jmdict:11", dictionary: "jmdict", headword: "について",
    expressions: [
      { text: "に就いて", script: "mixed", common: false, tags: ["rK"] },
      { text: "に付いて", script: "mixed", common: false, tags: ["rK"] },
    ],
    readings: [{ text: "について", kind: "kana" }],
    senses: [{ glosses: { eng: ["about"], spa: ["sobre"] }, partsOfSpeech: ["exp"], fields: [], misc: ["uk"], dialects: [], restrictions: [] }],
    frequencies: [{ source: "jiten-global", text: "について", reading: "について", rank: 50 }],
  },
  {
    type: "term", id: "jmdict:12", dictionary: "jmdict", headword: "一石二鳥",
    expressions: [{ text: "一石二鳥", script: "mixed", common: false, tags: [] }],
    readings: [{ text: "いっせきにちょう", kind: "kana" }],
    senses: [{ glosses: { eng: ["two birds one stone"], spa: ["dos pájaros"] }, partsOfSpeech: ["exp"], fields: [], misc: ["yoji"], dialects: [], restrictions: [] }],
    frequencies: [{ source: "jiten-global", text: "一石二鳥", reading: "いっせきにちょう", rank: 80_000 }],
  },
];

const archive = gzipSync(records.map((record) => JSON.stringify(record)).join("\n") + "\n");
const checksum = createHash("sha256").update(archive).digest("hex");
const manifest = {
  schemaVersion: 3, buildRecipeVersion: 5, minimumExtensionVersion: "0.2.0", contentRevision: "golden",
  builtAt: "2026-07-15T00:00:00Z", artifact: "dictionary.ndjson.gz", compression: "gzip",
  mediaType: "application/x-ndjson", bytes: archive.byteLength, sha256: checksum,
  counts: { terms: records.length - 1, kanji: 0 }, languages: ["eng", "spa"],
  dictionaries: [{ slug: "jmdict", version: "golden" }], modifications: [], sources: [],
  downloadUrl: "https://packs.test/dictionary.gz",
};

/** `surface[=lemma]` — the lemma half is optional, so a case can pin only the boundary. */
function expected(entry: string): { surface: string; lemma?: string } {
  const [surface, lemma] = entry.split("=");
  return lemma ? { surface, lemma } : { surface };
}

// The newest locally-built dictionary pack, if there is one. SHIRABE_PACK
// overrides it; otherwise the dev pack that `npm run prepare:dev-pack` writes.
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

// Build a pack from the REAL dictionary, keeping every entry that could compete
// for a span in the corpus — not just the expected answers, or the test would be
// rigged: 逸脱 has to be present for the いつだった case to mean anything. An entry
// qualifies when any of its spellings/readings appears as a substring of a case's
// text (and vice versa, so a longer dictionary form covering the text is kept too).
// Every spelling the corpus could look up: each substring of each case, PLUS the
// dictionary forms those substrings deinflect to. The deinflected forms are easy to
// forget and essential — 読む never appears inside 読みませんでした, so a substring-only
// filter starves the parser of the entry it needs and makes a healthy parser look broken.
function lookupKeysForCorpus(cases: GoldenCase[]): Set<string> {
  const keys = new Set<string>();
  for (const entry of cases) {
    const chars = [...entry.text];
    for (let start = 0; start < chars.length; start += 1) {
      for (let end = start + 1; end <= Math.min(chars.length, start + 24); end += 1) {
        const span = chars.slice(start, end).join("");
        // Substring, its text-processor variants (katakana fold, emphatic
        // collapse, kanji standardisation), and everything those deinflect to —
        // the same spellings the parser will probe, so the subset can answer them.
        for (const variant of lookupVariants(span)) {
          keys.add(variant.text);
          for (const found of deinflect(variant.text)) keys.add(found.term);
        }
      }
    }
  }
  return keys;
}

function subsetFromRealPack(path: string, cases: GoldenCase[]): string[] {
  const keys = lookupKeysForCorpus(cases);
  const lines = gunzipSync(readFileSync(path)).toString("utf8").split("\n");
  const kept: string[] = [];
  for (const line of lines) {
    if (!line) continue;
    if (line.startsWith('{"type":"header"')) { kept.push(line); continue; }
    const record = JSON.parse(line) as { type: string; headword?: string; expressions?: Array<{ text: string }>; readings?: Array<{ text: string }> };
    if (record.type !== "term") continue;
    const spellings = [record.headword ?? "", ...(record.expressions ?? []).map((item) => item.text), ...(record.readings ?? []).map((item) => item.text)];
    if (spellings.some((spelling) => keys.has(spelling))) kept.push(line);
  }
  return kept;
}

test("golden segmentation corpus", async (context) => {
  await removeDictionary();

  // Prefer the real dictionary when one is built locally: it runs every case
  // (including `pack: full`) against real JMdict data — real POS, frequencies and
  // uk flags — which is the only way a dictionary refresh can be caught. The
  // bundled fixture is the fallback so the ratchet still runs on a clean checkout.
  const packPath = realPackPath();
  const realSubset = packPath ? subsetFromRealPack(packPath, corpus) : null;
  const usingRealPack = !!realSubset && realSubset.length > 1;

  let payload = archive;
  let packManifest: typeof manifest = manifest;
  if (usingRealPack && realSubset) {
    payload = gzipSync(realSubset.join("\n") + "\n");
    const digest = createHash("sha256").update(payload).digest("hex");
    packManifest = {
      ...manifest, contentRevision: "golden-real", bytes: payload.byteLength, sha256: digest,
      counts: { terms: realSubset.length - 1, kanji: 0 },
    };
    context.diagnostic(`golden corpus: using real pack ${packPath} (${realSubset.length - 1} relevant entries)`);
  } else {
    // CI demands the real run; locally the `pack: full` rows report as skipped
    // subtests below rather than quietly counting as passes.
    assert.ok(
      !process.env.SHIRABE_REQUIRE_PACK,
      "SHIRABE_REQUIRE_PACK is set but no dictionary pack is installed — build one with `npm run prepare:dev-pack`",
    );
    context.diagnostic("golden corpus: no local dictionary pack — running fixture cases only");
  }

  globalThis.fetch = (async (input: string | URL | Request) => (String(input).endsWith("/current")
    ? new Response(JSON.stringify(packManifest), { headers: { "Content-Type": "application/json" } })
    : new Response(payload, { headers: { "Content-Type": "application/gzip" } }))) as typeof fetch;
  await installDictionary("https://api.test");

  const skipped: string[] = [];
  let checked = 0;

  for (const entry of corpus) {
    if (entry.pack === "full" && !usingRealPack) {
      skipped.push(entry.name);
      // A real subtest, so the runner counts it as skipped instead of leaving the
      // parent green with a case that never ran.
      await context.test(entry.name, { skip: "needs a real dictionary pack" }, () => {});
      continue;
    }
    const tokens = await parseOffline(entry.text, ["eng"], "https://shirabe.test");
    const content = tokens.filter((token) => token.content);
    const surfaces = tokens.map((token) => token.surface);
    const why = entry.why ? `\n  why: ${entry.why.trim()}` : "";

    // `merges`/`splits` pin only the boundary a case is about, so an unrelated
    // dictionary change cannot fail it — the shape the Rails eval already uses.
    for (const surface of entry.merges ?? []) {
      assert.ok(surfaces.includes(surface), `[${entry.name}] "${surface}" must be ONE token — got ${surfaces.join(" | ")}${why}`);
    }
    for (const surface of entry.splits ?? []) {
      assert.ok(!surfaces.includes(surface), `[${entry.name}] "${surface}" must NOT be one token — got ${surfaces.join(" | ")}${why}`);
    }

    if (entry.expect) {
      const want = entry.expect.map(expected);
      assert.deepEqual(
        content.map((token) => token.surface),
        want.map((item) => item.surface),
        `[${entry.name}] ${entry.text} — content-word boundaries${why}`,
      );
      want.forEach((item, index) => {
        if (item.lemma) assert.equal(content[index]?.lemma, item.lemma, `[${entry.name}] ${item.surface} → ${item.lemma}`);
      });
    }
    if (entry.tokens) {
      assert.deepEqual(
        tokens.map((token) => token.surface),
        entry.tokens,
        `[${entry.name}] ${entry.text} — every token boundary${entry.why ? `\n  why: ${entry.why.trim()}` : ""}`,
      );
    }
    checked += 1;
  }

  context.diagnostic(`golden corpus: ${checked}/${corpus.length} cases checked against the fixture pack`);
  if (skipped.length) {
    context.diagnostic(`golden corpus: ${skipped.length} real-pack cases skipped (${skipped.join(", ")})`);
  }
  assert.ok(checked > 0, "the golden corpus ran at least one case");
});
