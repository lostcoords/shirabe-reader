import "fake-indexeddb/auto";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { lookupGroupOffline, resolveParsedSpan, setActiveDictionaryStack } from "../src/common/offline-dictionary.js";
import { installTestPack, packPayload, subsetPack } from "./support/pack.js";
import { studyIdentityErrors, type StudyIdentity } from "./support/search-intent.js";

type WebToken = {
  start: number; length: number; surface: string; lemma: string; reading: string | null; pos: string; kind: string;
  inflection: string[];
  groups: string[][];
  card: Array<{ entry: string; senses: Array<{ position: number; glosses: string[] }> }>;
  heading: { headword: string; reading: string | null } | null;
  siteHeading: { headword: string; reading: string | null } | null;
  siteMetadata?: { common: boolean; frequency: number | null; forms: string[] } | null;
};
type Input = {
  pack: { path: string; revision: string; sha256: string };
  dictionaries: string[];
  study_identities: Record<string, StudyIdentity>;
  contexts: Array<{ text: string; web: WebToken[] }>;
};

async function main(): Promise<void> {
  const input = JSON.parse(readFileSync(process.argv[2]!, "utf8")) as Input;
  const digest = createHash("sha256").update(readFileSync(input.pack.path)).digest("hex");
  if (digest !== input.pack.sha256) throw new Error("Pack changed after web export");
  const lines = subsetPack(input.pack.path, input.contexts.map((row) => row.text), { maxSpan: 32 });
  const count = lines.filter((line) => line.includes('"type":"term"')).length;
  const visibleForms = new Map<string, Set<string>>();
  for (const line of lines) {
    const item = JSON.parse(line) as { type: string; id?: string; expressions?: Array<{ text: string; tags: string[] }> };
    if (item.type !== "term" || !item.id) continue;
    visibleForms.set(item.id, new Set(item.expressions?.filter((expression) =>
      !expression.tags.some((tag) => tag === "sK" || tag === "sk")).map((expression) => expression.text)));
  }
  console.log(`Installing ${count} corpus-relevant terms from ${input.pack.revision}`);
  await installTestPack(packPayload(lines), { contentRevision: input.pack.revision, terms: count });
  await setActiveDictionaryStack(input.dictionaries.map((dictionary) => `${dictionary}:en`), {}, {}, input.pack.revision);

  let compared = 0;
  let failed = 0;
  let comparedCards = 0;
  let cardFailures = 0;
  let identityFailures = 0;
  let headingDifferences = 0;
  let siteHeadingDifferences = 0;
  let metadataDifferences = 0;
  for (const row of input.contexts) {
    for (const [index, token] of row.web.entries()) {
      const before = row.web[index - 1];
      const local = await resolveParsedSpan(row.text, {
        start: token.start, length: token.length, surface: token.surface, lemma: token.lemma,
        reading: token.reading, pos: token.pos, kind: token.kind, inflection: token.inflection, content: true, state: "none",
      }, before && {
        start: before.start, length: before.length, surface: before.surface, lemma: before.lemma,
        reading: before.reading, pos: before.pos, kind: before.kind, content: true, state: "none",
      });
      compared += 1;
      if (JSON.stringify(local.groups) !== JSON.stringify(token.groups)) {
        failed += 1;
        console.log(JSON.stringify({ text: row.text, surface: token.surface,
          span: [token.start, token.start + token.length], web: token.groups, local: local.groups }));
      }
      if (!token.card.length) continue;
      comparedCards += 1;
      const definition = await lookupGroupOffline(local.groups[0] ?? [], token.surface, ["eng"], "https://shirabe.test");
      const errors = studyIdentityErrors(definition?.baseForm ?? definition?.inflectionBase ?? definition?.headword,
        definition?.baseReading ?? definition?.reading, input.study_identities[token.card[0]!.entry]);
      if (errors.length) {
        identityFailures += 1;
        console.log(JSON.stringify({ text: row.text, surface: token.surface, identityErrors: errors }));
      }
      const heading = { headword: definition?.headword, reading: definition?.reading };
      if (JSON.stringify(heading) !== JSON.stringify(token.heading)) headingDifferences += 1;
      if (JSON.stringify(heading) !== JSON.stringify(token.siteHeading)) {
        siteHeadingDifferences += 1;
        console.log(JSON.stringify({ text: row.text, surface: token.surface, siteHeading: token.siteHeading, heading }));
      }
      if (token.siteMetadata) {
        const formsForEntry = visibleForms.get(definition?.entry ?? "") ?? new Set<string>();
        const metadata = { common: definition?.common ?? false, frequency: definition?.frequency ?? null,
          forms: [...new Set([definition?.headword, definition?.reading, ...(definition?.forms?.map((form) => form.text) ?? [])]
            .filter((form): form is string => !!form && formsForEntry.has(form)))].sort() };
        if (JSON.stringify(metadata) !== JSON.stringify(token.siteMetadata)) {
          metadataDifferences += 1;
          console.log(JSON.stringify({ text: row.text, surface: token.surface, siteMetadata: token.siteMetadata, metadata }));
        }
      }
      const card = definition?.senses.map((sense) => ({ entry: sense.sourceEntry, position: sense.position,
        glosses: sense.glosses.map((gloss) => gloss.text) })) ?? [];
      const webCard = token.card.flatMap(({ entry, senses }) => senses.map((sense) => ({ entry, ...sense })));
      if (JSON.stringify(card) === JSON.stringify(webCard)) continue;
      cardFailures += 1;
      console.log(JSON.stringify({ text: row.text, surface: token.surface,
        span: [token.start, token.start + token.length], webCard, card }));
    }
  }
  console.log(`${compared} fixed spans, ${failed} group mismatches; ${comparedCards} cards, ${cardFailures} sense mismatches, ${identityFailures} study identity mismatches, ${metadataDifferences} metadata differences, ${headingDifferences} API heading differences, ${siteHeadingDifferences} site heading differences`);
  if (failed || cardFailures || identityFailures || metadataDifferences || siteHeadingDifferences) process.exitCode = 1;
}

void main().catch((error) => { console.error(error); process.exitCode = 1; });
