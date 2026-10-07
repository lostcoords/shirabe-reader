import "fake-indexeddb/auto";
import { readFileSync, writeFileSync } from "node:fs";
import { parseOffline } from "../src/common/offline-dictionary.js";
import { installTestPack, packPayload, realPackPath, subsetPack } from "./support/pack.js";

// Runner for divergence-sweep.mjs: see that file for what this is and how to run it.

type WebToken = { surface: string; lemma: string | null; content: boolean; entry?: string | null };
type WebRow = { text: string; tokens?: WebToken[]; error?: string };

// `limit shardIndex shardCount`. Sharding exists because the cost here is
// `parseOffline` (~800ms a sentence against fake-indexeddb, ~100x what the
// extension does warm in a browser) and it is embarrassingly parallel: the
// subset and install are seconds. A shard takes every Nth row so each gets the
// same mix of easy and hard lines, writes its counters to SHARD_OUT, and the
// driver sums them.
const limit = Number(process.argv[2] ?? Infinity);
const shard = Number(process.argv[3] ?? -1);
const shardCount = Number(process.argv[4] ?? 0);
const shardOut = process.env.SHARD_OUT;

const rows = (JSON.parse(readFileSync("../tmp/tokenizer_web.json", "utf8")) as WebRow[])
  .filter((row) => row.tokens?.length)
  .slice(0, Number.isFinite(limit) ? limit : undefined)
  .filter((_row, index) => shardCount <= 0 || index % shardCount === shard);

const bump = (map: Map<string, { count: number; example: string }>, key: string, example: string): void => {
  const current = map.get(key);
  if (current) current.count += 1;
  else map.set(key, { count: 1, example });
};

(async () => {
  // The driver imports this bundle to reuse `printReport` when merging shards,
  // and an import EXECUTES this. Without the gate the parent quietly starts a
  // second full sweep of its own on every sharded run.
  if (!process.env.SWEEP_RUN) return;

  const pack = realPackPath();
  if (!pack) throw new Error("no dictionary pack: run `bin/rails dictionary_packs:ensure`");
  process.stdout.write(`Subsetting ${pack} for ${rows.length} sentences…\n`);
  // Subsets at the same span cap as the asserting corpora. The sweep used to cap
  // at 16, which put every longer expression out of reach of its own subset and
  // reported those sentences as divergences the corpora structurally could not see.
  //
  // Measured, this is NOT the slow half, whatever it looks like from the pause
  // before the first output: subsetting 500 sentences is ~7s (key expansion plus
  // one scan of the million-record pack) and installing them ~1s. `parseOffline`
  // is ~800ms per sentence here and is essentially the entire run, which is what
  // makes this a background job. It is also 100x what the extension does warm in
  // a browser, so the cost is the fake-indexeddb underneath rather than the
  // lookup algorithm: sharding sentences across processes is what buys a bigger
  // corpus, not trimming the span cap.
  const kept = subsetPack(pack, rows.map((row) => row.text));
  await installTestPack(packPayload(kept), { contentRevision: "sweep", terms: kept.length - 1 });
  process.stdout.write(`Installed ${kept.length - 1} entries. Sweeping…\n\n`);

  // Boundary alignment: where a mined span would fall against the web's chips.
  // A card records the span the learner mined; the sentence page highlights it
  // against the SERVER's token stream. A span that lands on a chip boundary can
  // be highlighted as-is; one that falls inside a chip needs a sub-chip renderer,
  // and one inside a chip carrying kanji needs it to survive ruby alignment.
  let aligned = 0, inside = 0, insideKanji = 0, straddle = 0, alignableRows = 0;
  // What the misaligned spans actually ARE. The rate alone cannot say whether a
  // sub-chip highlight is worth building; the shapes can.
  const insideCases = new Map<string, { count: number; example: string }>();
  const straddleCases = new Map<string, { count: number; example: string }>();
  const KANJI = /[一-龯㐀-䶿]/;
  // Offsets by accumulation: both streams tokenize the same text, so a stream
  // whose surfaces don't rejoin to it can't be measured (skip, don't guess).
  const spans = (surfaces: string[]): Array<[number, number]> => {
    let at = 0;
    return surfaces.map((s) => { const start = at; at += [...s].length; return [start, at] as [number, number]; });
  };

  // Entry identity: the axis that actually decides whether a card forks, and the
  // one `cross_engine.yml` says survives the two designs. A lemma disagreement
  // can be two spellings of one word (一つ against ひとつ) or two ways of writing
  // a digit; an entry disagreement is two different words.
  const entryConflicts = new Map<string, { count: number; example: string }>();
  let entryShared = 0;
  let entryAgreed = 0;

  // A lemma disagreement is the one that costs users a duplicate SRS card.
  const lemmaConflicts = new Map<string, { count: number; example: string }>();
  // A content word the web found whole that is not one of our tokens. Two
  // OPPOSITE failures hide behind that one test and this used to report them as
  // one number: we either cut the span finer (SHATTERED: ズオンガー as ズ · オン ·
  // ガーが, the case a confidence floor is for) or we swallowed it into something
  // bigger (SWALLOWED: 本当 inside our 本当に, where the web is the one that cut).
  // Counting them together made the shatter problem look three times its size.
  const shattered = new Map<string, { count: number; example: string }>();
  const swallowed = new Map<string, { count: number; example: string }>();
  let identical = 0;
  // Identical token streams is the strictest possible measure, and the engines
  // differ in granularity BY DESIGN (読みませんでした is one token here, two chips
  // there), so it understates agreement badly. What actually matters is whether
  // both engines resolve the same WORDS: that is what a lookup shows and what an
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

    const text = [...row.text];
    const mineSurfaces = mine.map((t) => t.surface);
    const theirSurfaces = theirs.map((t) => t.surface);
    if (mineSurfaces.join("") === row.text && theirSurfaces.join("") === row.text) {
      alignableRows += 1;
      const theirSpans = spans(theirSurfaces);
      const edges = new Set(theirSpans.flatMap(([s, e]) => [s, e]));
      spans(mineSurfaces).forEach(([start, end], i) => {
        if (!mine[i].content) return;
        if (edges.has(start) && edges.has(end)) { aligned += 1; return; }
        const host = theirSpans.findIndex(([s, e]) => s <= start && end <= e);
        if (host === -1) {
          straddle += 1;
          bump(straddleCases, `${mine[i].surface}  spans a web boundary`, row.text);
          return;
        }
        inside += 1;
        const chip = text.slice(...theirSpans[host]).join("");
        const kanji = KANJI.test(chip);
        if (kanji) insideKanji += 1;
        bump(insideCases, `${mine[i].surface} inside ${chip}${kanji ? "  [kanji chip]" : ""}`, row.text);
      });
    }

    const mineEntries = new Map(mine.filter((t) => t.content).map((t) => [t.surface, t.entry ?? null]));
    for (const token of theirs) {
      if (!token.content || !token.entry) continue;
      if (!mineEntries.has(token.surface)) continue;

      const ours = mineEntries.get(token.surface) ?? null;
      entryShared += 1;
      if (ours === token.entry) entryAgreed += 1;
      else bump(entryConflicts, `${token.surface}  web=${token.entry}  ext=${ours ?? "nil"}`, row.text);
    }

    const mineBySurface = new Map(mine.filter((t) => t.content).map((t) => [t.surface, t.lemma]));
    for (const token of theirs) {
      if (!token.content || !token.lemma) continue;
      const myLemma = mineBySurface.get(token.surface);
      if (myLemma && myLemma !== token.lemma) {
        bump(lemmaConflicts, `${token.surface}  web=${token.lemma}  ext=${myLemma}`, row.text);
      }
      // The web found this content word whole and we did not. Which way?
      if (!myLemma && token.surface.length > 1 && row.text.includes(token.surface)
          && !mine.some((t) => t.surface === token.surface)) {
        // A token of ours that strictly CONTAINS the web's surface means we
        // merged where they cut, so the word is swallowed rather than shattered.
        const host = mine.find((t) => t.surface.length > token.surface.length && t.surface.includes(token.surface));
        bump(host ? swallowed : shattered,
          host ? `${token.surface} inside our ${host.surface}` : `${token.surface} (web lemma ${token.lemma})`,
          row.text);
      }
    }
  }

  const counters = {
    swept: rows.length, identical, lemmaOverlapSum, lemmaSentences, bothAgreeFully,
    aligned, inside, insideKanji, straddle, alignableRows, spanTotal: aligned + inside + straddle,
    entryShared, entryAgreed, entryConflicts: [...entryConflicts],
    lemmaConflicts: [...lemmaConflicts], shattered: [...shattered], swallowed: [...swallowed],
    insideCases: [...insideCases], straddleCases: [...straddleCases],
  };

  if (shardOut) {
    writeFileSync(shardOut, JSON.stringify(counters));
    return;
  }

  const report = (title: string, entries: Array<[string, { count: number; example: string }]>, top: number): void => {
    const sorted = [...entries].sort((a, b) => b[1].count - a[1].count);
    process.stdout.write(`\n${title}: ${entries.length} distinct, showing top ${Math.min(top, sorted.length)}\n`);
    for (const [key, { count, example }] of sorted.slice(0, top)) {
      process.stdout.write(`  ${String(count).padStart(4)}\u00d7  ${key}\n          e.g. ${example}\n`);
    }
  };

  printReport(counters, report);
})();

// Shared by a single run and by the driver merging shards, so both read alike.
export function printReport(
  c: {
    swept: number; identical: number; lemmaOverlapSum: number; lemmaSentences: number; bothAgreeFully: number;
    aligned: number; inside: number; insideKanji: number; straddle: number; alignableRows: number; spanTotal: number;
    entryShared: number; entryAgreed: number;
    entryConflicts: Array<[string, { count: number; example: string }]>;
    lemmaConflicts: Array<[string, { count: number; example: string }]>;
    shattered: Array<[string, { count: number; example: string }]>;
    swallowed: Array<[string, { count: number; example: string }]>;
    insideCases: Array<[string, { count: number; example: string }]>;
    straddleCases: Array<[string, { count: number; example: string }]>;
  },
  report: (title: string, entries: Array<[string, { count: number; example: string }]>, top: number) => void,
): void {
  const pct = (n: number, of: number): string => `${Math.round((n / (of || 1)) * 100)}%`;
  const overlap = c.lemmaSentences ? Math.round((c.lemmaOverlapSum / c.lemmaSentences) * 100) : 0;
  process.stdout.write(`Swept ${c.swept} sentences\n`);
  process.stdout.write(`  identical token streams: ${c.identical} (${pct(c.identical, c.swept)})  : strictest, granularity differs by design\n`);
  process.stdout.write(`  web lemmas we also find: ${overlap}% (mean per sentence)  : the number that matters for lookup + SRS\n`);
  process.stdout.write(`  sentences where we find EVERY web lemma : ${c.bothAgreeFully} (${pct(c.bothAgreeFully, c.lemmaSentences)})\n`);
  process.stdout.write(`  SAME ENTRY where both cut the same word : ${c.entryAgreed}/${c.entryShared} (${pct(c.entryAgreed, c.entryShared)})  : the axis a card forks on\n`);
  process.stdout.write(`\nSPAN ALIGNMENT (${c.alignableRows}/${c.swept} sentences measurable, ${c.spanTotal} content spans)\n`);
  process.stdout.write(`  on a server chip boundary : ${c.aligned} (${pct(c.aligned, c.spanTotal)})  : highlights as-is\n`);
  process.stdout.write(`  strictly inside one chip  : ${c.inside} (${pct(c.inside, c.spanTotal)})  : needs sub-chip rendering\n`);
  process.stdout.write(`    ...of those, chip has kanji: ${c.insideKanji}  : split must survive ruby\n`);
  process.stdout.write(`  straddling two chips      : ${c.straddle} (${pct(c.straddle, c.spanTotal)})\n`);
  report("INSIDE A CHIP (the extension's word sits within one web chip: a chip highlight lights too much)", c.insideCases, 25);
  report("STRADDLING (the extension's word crosses a web chip boundary)", c.straddleCases, 10);
  report("ENTRY CONFLICTS (same surface, DIFFERENT dictionary entry: two different words)", c.entryConflicts, 20);
  report("LEMMA CONFLICTS (same surface, different spelling of the answer: often the same word)", c.lemmaConflicts, 15);
  // The shatter list is what phase M2 is designed on, so it prints deeper than
  // the others and says how much of it is one shape. A katakana run cut into
  // pieces is the case the orthographic rule already knows about and declines to
  // act on when no candidate covers the whole run.
  const katakanaOnly = c.shattered.filter(([key]) => /^[ァ-ヶー]+ /.test(key));
  process.stdout.write(`\n  of the shattered, all-katakana surfaces: ${katakanaOnly.length} distinct, `
    + `${katakanaOnly.reduce((sum, [ , row ]) => sum + row.count, 0)} occurrences\n`);
  report("SHATTERED (web found one content word, extension cut it finer: what a confidence floor is for)", c.shattered, 40);
  report("SWALLOWED (web found one content word, extension merged it into a bigger one: the opposite failure)", c.swallowed, 20);
}
