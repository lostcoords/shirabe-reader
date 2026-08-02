import "fake-indexeddb/auto";
import { readFileSync } from "node:fs";
import { parseOffline } from "../src/common/offline-dictionary.js";
import { installTestPack, packPayload, realPackPath, subsetPack } from "./support/pack.js";

// Runner for divergence-sweep.mjs: see that file for what this is and how to run it.

type WebToken = { surface: string; lemma: string | null; content: boolean };
type WebRow = { text: string; tokens?: WebToken[]; error?: string };

const limit = Number(process.argv[2] ?? Infinity);
const rows = (JSON.parse(readFileSync("../tmp/tokenizer_web.json", "utf8")) as WebRow[])
  .filter((row) => row.tokens?.length)
  .slice(0, Number.isFinite(limit) ? limit : undefined);

const bump = (map: Map<string, { count: number; example: string }>, key: string, example: string): void => {
  const current = map.get(key);
  if (current) current.count += 1;
  else map.set(key, { count: 1, example });
};

(async () => {
  const pack = realPackPath();
  if (!pack) throw new Error("no dictionary pack: run `npm run prepare:dev-pack`");
  process.stdout.write(`Subsetting ${pack} for ${rows.length} sentences…\n`);
  // Subsets at the same span cap as the asserting corpora. The sweep used to cap
  // at 16, which put every longer expression out of reach of its own subset and
  // reported those sentences as divergences the corpora structurally could not see.
  //
  // It is the slow half by far: every span of every sentence goes through
  // lookupVariants + deinflect, so a 1,500-sentence sweep subsets for tens of
  // minutes before it parses anything. That is the price of not lying, and this is
  // a discovery tool run occasionally: start it in the background rather than
  // trimming the cap back and reading manufactured divergences as real ones.
  const kept = subsetPack(pack, rows.map((row) => row.text));
  await installTestPack(packPayload(kept), { contentRevision: "sweep", terms: kept.length - 1 });
  process.stdout.write(`Installed ${kept.length - 1} entries. Sweeping…\n\n`);

  // A lemma disagreement is the one that costs users a duplicate SRS card.
  const lemmaConflicts = new Map<string, { count: number; example: string }>();
  // A content word one engine finds whole and the other shatters.
  const shattered = new Map<string, { count: number; example: string }>();
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
    process.stdout.write(`\n${title}: ${map.size} distinct, showing top ${Math.min(top, sorted.length)}\n`);
    for (const [key, { count, example }] of sorted.slice(0, top)) {
      process.stdout.write(`  ${String(count).padStart(4)}×  ${key}\n          e.g. ${example}\n`);
    }
  };

  const overlap = lemmaSentences ? Math.round(lemmaOverlapSum / lemmaSentences * 100) : 0;
  process.stdout.write(`Swept ${rows.length} sentences\n`);
  process.stdout.write(`  identical token streams: ${identical} (${Math.round(identical / rows.length * 100)}%)  : strictest, granularity differs by design\n`);
  process.stdout.write(`  web lemmas we also find: ${overlap}% (mean per sentence)  : the number that matters for lookup + SRS\n`);
  process.stdout.write(`  sentences where we find EVERY web lemma : ${bothAgreeFully} (${Math.round(bothAgreeFully / (lemmaSentences || 1) * 100)}%)\n`);
  report("LEMMA CONFLICTS (same surface, different dictionary form: forks the SRS card)", lemmaConflicts, 15);
  report("SHATTERED (web found one content word, extension split it)", shattered, 20);
})();
