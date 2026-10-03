import "fake-indexeddb/auto";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import { gzipSync } from "node:zlib";
import { parse as parseYaml } from "yaml";
import type { ParsedToken } from "../src/common/types.js";
import { lookupGroupOffline, parseOffline, resolveParsedSpan, setActiveDictionaryStack } from "../src/common/offline-dictionary.js";
import { installTestPack, packPayload, realPackPath, subsetPack } from "./support/pack.js";

// The extension's segmentation ratchet: every corpus in test/tokenizer_eval/ that
// this engine answers, in one suite. The corpora live outside the extension so one
// directory holds every case either engine answers, and the web reads the same
// files from lib/tasks/tokenizer_eval.rake with its own corpus list. Two lists,
// one shape, one directory: a case is never hidden inside the engine reading it.
//
// One suite rather than one per corpus, because each installs a pack and a pack
// install owns the offline-dictionary module singleton and fake-indexeddb: two
// suites in two processes meant scanning the 58 MB pack twice to build subsets
// that are then thrown away. One subset covers both.
//
// Why a corpus and not more unit tests: the parser's ranking core (text-processor
// variants, part-of-speech gating, tiebreakers) is easy to regress silently, and a
// mis-parse fixed today can return on the next dictionary refresh. A row here can
// never come back without turning this test red.

type StackVariant = { name: string; sources: string[]; languages: Array<"eng" | "spa"> };
const STACKS = parseYaml(readFileSync("../test/tokenizer_eval/dictionary_stacks.yml", "utf8")) as StackVariant[];

const CORPORA = ["cross_engine", "segmentation", "search_mapping", "contextual_boundaries"] as const;

// The floor a real-pack subset has to clear before it counts as one. The corpora
// currently subset to a few thousand entries, so this only trips when the
// subsetter itself breaks (a pack schema change, a renamed record type).
const MINIMUM_REAL_ENTRIES = 500;

type SegmentationCase = {
  name: string;
  stack?: string;
  sentence: string;
  family?: string;
  target?: { start: number; end: number };
  queries?: string[];
  targetEntries?: string[];
  contains?: string[];
  labels?: string[];
  alternatives?: string[];
  // The words the parser resolves against the dictionary: exact, but brittle to
  // unrelated dictionary changes. Named for what this engine means by it, because
  // the web tokenizer's "content word" is a narrower thing (see the corpus header).
  dictionary_words?: string[];
  merges?: string[];   // these surfaces must each be ONE token (robust: pins only the boundary at issue)
  splits?: string[];   // these surfaces must NOT be a single token
  lemmas?: Record<string, string>; // surface → lemma BOTH engines must resolve to
  // surface → the dictionary entry BOTH engines must land on ("jmdict:1009470").
  // Stronger than `lemmas` and the only cross-engine claim that survives the two
  // designs: a lemma is what a form reduces to and the engines disagree about
  // that on purpose, while an entry id means the same thing here, on the web,
  // and in the API's `sourceId`.
  entries?: Record<string, string>;
  clickable?: string[];
  tokens?: string[];
  // Absent means the row needs the real dictionary; `fixture` means it is still
  // meaningful against the bundled 12-entry pack. Safe direction: a row that
  // forgets the marker is skipped, never judged against a field it cannot lose in.
  pack?: string;
  why?: string;
  divergence?: boolean; // recorded, never asserted
};

/** Every row, tagged with the corpus it came from so failures name their source. */
const allRows: Array<SegmentationCase & { corpus: string }> = CORPORA.flatMap((name) => {
  const rows = parseYaml(readFileSync(`../test/tokenizer_eval/${name}.yml`, "utf8")) as SegmentationCase[];
  return (name === "contextual_boundaries" ? STACKS : [STACKS[0]!]).flatMap((stack) => rows.map((row) => ({
    ...row, stack: stack.name,
    name: `${stack.name}/${row.name ?? (row.family ? `${row.family}/${row.sentence}` : row.sentence)}`,
    merges: row.merges ?? row.contains, corpus: name,
  })));
});

const corpus = allRows.filter((row) => !row.divergence);
const recorded = allRows.length - corpus.length;

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
  { type: "header", schemaVersion: 7, languages: ["eng", "spa"], source: "Shirabe golden corpus" },
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

/** `surface[=lemma]`: the lemma half is optional, so a case can pin only the boundary. */
function expected(entry: string): { surface: string; lemma?: string } {
  const [surface, lemma] = entry.split("=");
  return lemma ? { surface, lemma } : { surface };
}

test("segmentation corpus", async (context) => {
  // Prefer the real dictionary when one is built locally: it runs every row
  // against real JMdict data (real POS, frequencies, uk flags), which is the only
  // way a dictionary refresh can be caught. The bundled fixture is the fallback so
  // the `pack: fixture` rows still ratchet on a clean checkout.
  const packPath = realPackPath();
  const realSubset = packPath ? subsetPack(packPath, corpus.flatMap((entry) => [entry.sentence, ...(entry.queries ?? [])])) : null;
  // A pack that subsets down to almost nothing is a broken subsetter, not a small
  // corpus, and it must not quietly become a fixture run: every case would then be
  // judged against a 12-entry field it cannot lose in, and report green. Only the
  // absence of a pack is a legitimate reason to fall back.
  const entryCount = realSubset ? realSubset.length - 1 : 0;
  const usingRealPack = entryCount >= MINIMUM_REAL_ENTRIES;
  assert.ok(
    !realSubset || usingRealPack,
    `the real pack subsetted to ${entryCount} entries, under the ${MINIMUM_REAL_ENTRIES} this corpus needs: the subsetter is broken, not the corpus`,
  );

  if (usingRealPack && realSubset) {
    await installTestPack(packPayload(realSubset), { contentRevision: "segmentation-real", terms: realSubset.length - 1 });
    context.diagnostic(`segmentation corpus: using real pack ${packPath} (${realSubset.length - 1} relevant entries)`);
  } else {
    await installTestPack(archive, { contentRevision: "segmentation", terms: records.length - 1 });
    context.diagnostic("segmentation corpus: no local dictionary pack: running fixture cases only");
  }

  const webPath = "../tmp/contextual-boundaries-audit.json";
  const requireWeb = process.env.SHIRABE_REQUIRE_CONTEXTUAL_WEB === "1";
  assert.ok(!requireWeb || usingRealPack, "combined audit requires a real dictionary pack");
  assert.ok(!requireWeb || existsSync(webPath), "run the backend contextual boundary audit first");
  const webTokens = new Map<string, ParsedToken[]>();
  if (existsSync(webPath)) {
    const report = JSON.parse(readFileSync(webPath, "utf8"));
    const digest = createHash("sha256").update(readFileSync("../test/tokenizer_eval/contextual_boundaries.yml")).digest("hex");
    if (report.corpusDigest === digest && report.stackDigest === createHash("sha256").update(readFileSync("../test/tokenizer_eval/dictionary_stacks.yml")).digest("hex")) {
      const expectedCases = corpus.filter((row) => row.corpus === "contextual_boundaries").length;
      assert.equal(report.cases * STACKS.length, expectedCases, "backend report must cover the whole shared corpus");
      assert.equal(report.results.length, expectedCases, "backend report must retain every case");
      assert.ok(report.results.every((row: { problems: string[] }) => !row.problems.length), "backend audit must pass before extension parity");
      const originalFetch = globalThis.fetch;
      const originalChrome = globalThis.chrome;
      Object.assign(globalThis, { chrome: originalChrome ?? {
        runtime: { id: "reader-test" },
        storage: { local: { get: async () => ({}) }, onChanged: { addListener() {} } },
      } });
      try {
        const { ShirabeApi } = await import("../src/common/api.js");
        const { DEFAULTS } = await import("../src/common/config.js");
        for (const stack of STACKS) {
          const results = report.results.filter((row: { stack: string }) => row.stack === stack.name);
          assert.equal(results.length, report.cases, `backend report must cover ${stack.name}`);
          globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
            assert.deepEqual((await new Request(_input, init).json()).sources, stack.sources, "online extension must request the active stack");
            return Response.json({
              packRevision: "b".repeat(16), stackFingerprint: "a".repeat(16), sources: stack.sources,
              results: results.map((row: { text: string; tokens: unknown[] }) => ({ text: row.text, tokens: row.tokens })),
            });
          }) as typeof fetch;
          const parsed = await new ShirabeApi({ ...DEFAULTS, languages: stack.languages, apiBase: "https://shirabe.test" })
            .parseWithProvenance(results.map((row: { text: string }) => row.text), stack.sources);
          results.forEach((row: { text: string }, index: number) => webTokens.set(`${stack.name}\0${row.text}`, parsed.tokens[index]!));
        }
      } finally {
        globalThis.fetch = originalFetch;
        Object.assign(globalThis, { chrome: originalChrome });
      }
    } else {
      assert.ok(!requireWeb, "backend report is stale; rerun bin/tokenizer-audit");
      context.diagnostic("backend report is stale: online parity skipped; use bin/tokenizer-audit for both engines");
    }
  }

  const skipped: string[] = [];
  let checked = 0;
  let installedStack = "";

  // One subtest per case, so a JMdict refresh that breaks four rows reports all
  // four. Asserting inline in the parent meant the first throw ended the loop and
  // you found the next failure only after fixing this one.
  for (const entry of corpus) {
    // `name` is optional: a corpus whose rows are one sentence each reads better
    // labelled by the sentence than by a slug, so fall back to it the way the web
    // runner does rather than printing `undefined`.
    const label = `${entry.corpus}/${entry.name || entry.sentence}`;
    if (entry.pack !== "fixture" && !usingRealPack) {
      skipped.push(label);
      await context.test(label, { skip: "needs a real dictionary pack" }, () => {});
      continue;
    }
    checked += 1;

    await context.test(label, async () => {
      const stack = STACKS.find((variant) => variant.name === entry.stack)!;
      if (installedStack !== stack.name) {
        await setActiveDictionaryStack(stack.sources, {}, {}, createHash("sha256").update(stack.sources.join(",")).digest("hex").slice(0, 16));
        installedStack = stack.name;
      }
      const tokens = await parseOffline(entry.sentence, stack.languages, "https://shirabe.test");
      const resolved = tokens.filter((token) => token.content);
      const surfaces = tokens.map((token) => token.surface);
      const shown = surfaces.join(" | ");
      const why = entry.why ? `\n  why: ${entry.why.trim()}` : "";
      assert.equal(surfaces.join(""), entry.sentence, `[${label}] preserves source text`);
      for (const token of tokens) {
        assert.equal(entry.sentence.slice(token.start, token.start + token.length), token.surface,
          `[${label}] UTF-16 offsets for ${token.surface}`);
      }
      if (entry.target && entry.queries) {
        const start = [...entry.sentence].slice(0, entry.target.start).join("").length;
        const selected = tokens.find((token) => token.start === start);
        assert.ok(selected?.entry, `[${label}] target must have a dictionary identity: ${shown}`);
        assert.ok(entry.targetEntries?.includes(selected.entry),
          `[${label}] ${selected.surface} → ${selected.lemma} (${selected.entry}); expected ${entry.targetEntries}`);
        const resolved = await resolveParsedSpan(entry.sentence, selected, tokens[tokens.indexOf(selected) - 1]);
        assert.ok(resolved.entry && entry.targetEntries?.includes(resolved.entry),
          `[${label}] resolving parsed span chose ${resolved.entry}; expected ${entry.targetEntries}`);
        const enabledDictionaries = new Set(stack.sources.map((source) => source.split(":")[0]));
        assert.ok(resolved.groups.flat().every((id) => enabledDictionaries.has(id.split(":")[0]!)),
          `[${label}] disabled dictionaries must not appear in candidates`);
        if (entry.sentence === "猫っていう動物" && enabledDictionaries.has("jmnedict")) {
          assert.ok(resolved.groups.flat().some((id) => id.startsWith("jmnedict:")),
            `[${label}] valid name alternatives must remain available`);
        }
        if (entry.sentence === "食べちゃったって言った") {
          const definition = await lookupGroupOffline(resolved.groups[0]!, selected.surface, stack.languages, "https://shirabe.test");
          assert.ok(definition);
          const glosses = definition.senses.find((sense) => sense.glosses.length)?.glosses ?? [];
          assert.deepEqual(glosses.map((gloss) => gloss.lang), stack.sources.filter((source) => source.startsWith("jmdict:")).map((source) => source.endsWith(":es") ? "spa" : "eng"),
            `[${label}] definition languages must follow the configured stack order`);
        }
        if (entry.alternatives) {
          const candidates = new Set(resolved.groups.flat());
          for (const id of entry.targetEntries ?? []) {
            assert.ok(candidates.has(id), `[${label}] offline resolver lost valid alternative ${id}`);
          }
        }
        const online = webTokens.get(`${entry.stack}\0${entry.sentence}`);
        if (entry.corpus === "contextual_boundaries" && online) {
          assert.equal(online.map((token) => token.surface).join(""), entry.sentence, `[${label}] online source text`);
          for (const token of online) {
            assert.equal(entry.sentence.slice(token.start, token.start + token.length), token.surface, `[${label}] online UTF-16 offsets`);
          }
          const webSelected = online.find((token) => token.start === start);
          assert.ok(webSelected, `[${label}] backend must expose the target boundary`);
          const webResolved = await resolveParsedSpan(entry.sentence, webSelected, online[online.indexOf(webSelected) - 1]);
          assert.ok(webResolved.entry && entry.targetEntries?.includes(webResolved.entry),
            `[${label}] online extension resolved ${webSelected.surface} → ${webResolved.entry}; expected ${entry.targetEntries}`);
          if (entry.alternatives) {
            const candidates = new Set(webResolved.groups.flat());
            for (const id of entry.targetEntries ?? []) {
              assert.ok(candidates.has(id), `[${label}] online resolver lost valid alternative ${id}`);
            }
          }
        }
        for (const label of entry.labels ?? []) {
          assert.ok(selected.inflection?.includes(label), `[${entry.sentence}] missing inflection ${label}: ${selected.inflection}`);
        }
      }
      for (const surface of entry.clickable ?? []) {
        const token = tokens.find((item) => item.surface === surface);
        assert.ok(token?.content && token.entry, `${surface} must be clickable with a dictionary identity`);
        assert.equal(token.state, "none");
      }

      // `merges`/`splits` pin only the boundary a case is about, so an unrelated
      // dictionary change cannot fail it: the shape the Rails eval already uses.
      for (const surface of entry.merges ?? []) {
        assert.ok(surfaces.includes(surface), `[${label}] "${surface}" must be ONE token: got ${shown}${why}`);
      }
      for (const surface of entry.splits ?? []) {
        assert.ok(!surfaces.includes(surface), `[${label}] "${surface}" must NOT be one token: got ${shown}${why}`);
      }
      // The one that costs a user a duplicate card: the extension sends `lemma`
      // when saving, so a lemma that disagrees with the web forks the SRS card.
      for (const [surface, lemma] of Object.entries(entry.lemmas ?? {})) {
        const token = tokens.find((item) => item.surface === surface);
        assert.ok(token, `[${label}] expected a token "${surface}" to check its lemma: got ${shown}${why}`);
        assert.equal(token.lemma, lemma,
          `[${label}] "${surface}" must resolve to ${lemma} in BOTH engines: a lemma that disagrees with the web forks the SRS card${why}`);
      }
      // The entry, which is the claim that actually holds across two tokenizers
      // and the server: `jmdict:1009470` means one thing everywhere, where a
      // lemma means whichever thing each engine decided.
      for (const [surface, id] of Object.entries(entry.entries ?? {})) {
        const token = tokens.find((item) => item.surface === surface);
        assert.ok(token, `[${label}] expected a token "${surface}" to check its entry: got ${shown}${why}`);
        assert.equal(token.entry, id,
          `[${label}] "${surface}" must resolve to entry ${id} in BOTH engines and the API${why}`);
      }

      if (entry.dictionary_words) {
        const want = entry.dictionary_words.map(expected);
        assert.deepEqual(
          resolved.map((token) => token.surface),
          want.map((item) => item.surface),
          `[${label}] ${entry.sentence}: dictionary-word boundaries${why}`,
        );
        want.forEach((item, index) => {
          if (item.lemma) assert.equal(resolved[index]?.lemma, item.lemma, `[${label}] ${item.surface} → ${item.lemma}`);
        });
      }
      if (entry.tokens) {
        assert.deepEqual(
          tokens.map((token) => token.surface),
          entry.tokens,
          `[${label}] ${entry.sentence} : every token boundary${why}`,
        );
      }
    });
  }

  context.diagnostic(`online extension parity: ${webTokens.size} backend cases available`);
  context.diagnostic(
    `segmentation corpus: ${checked}/${corpus.length} cases checked against the ${usingRealPack ? "real" : "fixture"} pack`,
  );
  if (skipped.length) {
    context.diagnostic(`segmentation corpus: ${skipped.length} real-pack cases skipped (${skipped.join(", ")})`);
  }
  context.diagnostic(`segmentation corpus: ${recorded} known divergences recorded, not asserted`);
  assert.ok(checked > 0, "the segmentation corpus ran at least one case");
});
