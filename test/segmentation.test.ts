import "fake-indexeddb/auto";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import { parse as parseYaml } from "yaml";
import type { ParsedToken } from "../src/common/types.js";
import { lookupGroupOffline, parseOffline, resolveParsedSpan, setActiveDictionaryStack } from "../src/common/offline-dictionary.js";
import { corpusPackPath, installTestPack, packPayload, subsetPack } from "./support/pack.js";

// Why a corpus and not more unit tests: the parser's ranking core (text-processor
// variants, part-of-speech gating, tiebreakers) is easy to regress silently, and a
// mis-parse fixed today can return on the next dictionary refresh. A row here can
// never come back without turning this test red.

type StackVariant = { name: string; sources: string[]; languages: Array<"eng" | "spa"> };
const STACKS = parseYaml(readFileSync("test/fixtures/tokenizer_eval/dictionary_stacks.yml", "utf8")) as StackVariant[];

const CORPORA = ["cross_engine", "segmentation", "search_mapping", "contextual_boundaries"] as const;

// The floor a subset has to clear before it counts as one. A shard subsets to a
// few thousand entries, so this only trips when the subsetter itself breaks (a
// pack schema change, a renamed record type).
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
  why?: string;
  divergence?: boolean; // recorded, never asserted
};

/** Every row, tagged with the corpus it came from so failures name their source. */
const allRows: Array<SegmentationCase & { corpus: string }> = CORPORA.flatMap((name) => {
  const rows = parseYaml(readFileSync(`test/fixtures/tokenizer_eval/${name}.yml`, "utf8")) as SegmentationCase[];
  return (name === "contextual_boundaries" ? STACKS : [STACKS[0]!]).flatMap((stack) => rows.map((row) => ({
    ...row, stack: stack.name,
    name: `${stack.name}/${row.name ?? (row.family ? `${row.family}/${row.sentence}` : row.sentence)}`,
    merges: row.merges ?? row.contains, corpus: name,
  })));
});

// `SEGMENTATION_SHARD=i/n` (from test/run.mjs) takes the i-th of n contiguous
// runs of rows, so each process sees one or two stacks. fake-indexeddb keeps
// every transaction a database ever ran and scans that list on each new one,
// so the whole corpus in one process grows quadratically: 150 s, against a few
// seconds per shard.
const [shard, shards] = (process.env.SEGMENTATION_SHARD ?? "0/1").split("/").map(Number) as [number, number];
const asserted = allRows.filter((row) => !row.divergence);
const corpus = asserted.slice(Math.floor(asserted.length * shard / shards), Math.floor(asserted.length * (shard + 1) / shards));
const recorded = allRows.length - asserted.length;

/** `surface[=lemma]`: the lemma half is optional, so a case can pin only the boundary. */
function expected(entry: string): { surface: string; lemma?: string } {
  const [surface, lemma] = entry.split("=");
  return lemma ? { surface, lemma } : { surface };
}

test(`segmentation corpus ${shard + 1}/${shards}`, async (context) => {
  const packPath = corpusPackPath();
  const subset = await subsetPack(packPath, corpus.flatMap((entry) => [entry.sentence, ...(entry.queries ?? [])]));
  // A pack that subsets down to almost nothing is a broken subsetter, not a
  // small corpus: every case would be judged against a field it cannot lose in.
  assert.ok(subset.length - 1 >= MINIMUM_REAL_ENTRIES,
    `the pack subsetted to ${subset.length - 1} entries, under the ${MINIMUM_REAL_ENTRIES} this corpus needs: the subsetter is broken, not the corpus`);
  await installTestPack(packPayload(subset), { contentRevision: "segmentation", terms: subset.length - 1 });
  context.diagnostic(`segmentation corpus: ${packPath} (${subset.length - 1} relevant entries)`);
  const stacks = STACKS.filter((stack) => corpus.some((row) => row.stack === stack.name));

  const webPath = process.env.SHIRABE_WEB_AUDIT ?? "tmp/contextual-boundaries-audit.json";
  const requireWeb = process.env.SHIRABE_REQUIRE_CONTEXTUAL_WEB === "1";
  assert.ok(!requireWeb || existsSync(webPath), "run the backend contextual boundary audit first");
  const webTokens = new Map<string, ParsedToken[]>();
  if (existsSync(webPath)) {
    const report = JSON.parse(readFileSync(webPath, "utf8"));
    const digest = createHash("sha256").update(readFileSync("test/fixtures/tokenizer_eval/contextual_boundaries.yml")).digest("hex");
    if (report.corpusDigest === digest && report.stackDigest === createHash("sha256").update(readFileSync("test/fixtures/tokenizer_eval/dictionary_stacks.yml")).digest("hex")) {
      const expectedCases = asserted.filter((row) => row.corpus === "contextual_boundaries").length;
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
        for (const stack of stacks) {
          const results = report.results.filter((row: { stack: string }) => row.stack === stack.name);
          assert.equal(results.length, report.cases, `backend report must cover ${stack.name}`);
          globalThis.fetch = (async () => {
            return Response.json({
              packRevision: "b".repeat(16), stackFingerprint: "a".repeat(16), sources: stack.sources,
              results: results.map((row: { text: string; tokens: unknown[] }) => ({ text: row.text, tokens: row.tokens })),
            });
          }) as typeof fetch;
          const parsed = await new ShirabeApi({ ...DEFAULTS, languages: stack.languages, apiBase: "https://shirabe.test", accessToken: "access", refreshToken: "refresh",
            accessTokenExpiresAt: "2999-01-01T00:00:00Z", scopes: ["user:dictionary:read"] })
            .parseWithProvenance(results.map((row: { text: string }) => row.text));
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

  let installedStack = "";

  // One subtest per case, so a JMdict refresh that breaks four rows reports all
  // four. Asserting inline in the parent meant the first throw ended the loop and
  // you found the next failure only after fixing this one.
  for (const entry of corpus) {
    // `name` is optional: a corpus whose rows are one sentence each reads better
    // labelled by the sentence than by a slug, so fall back to it the way the web
    // runner does rather than printing `undefined`.
    const label = `${entry.corpus}/${entry.name || entry.sentence}`;

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
  context.diagnostic(`segmentation corpus: ${corpus.length} of ${asserted.length} cases in this shard; ${recorded} known divergences recorded, not asserted`);
  assert.ok(corpus.length > 0, "the segmentation shard ran at least one case");
});
