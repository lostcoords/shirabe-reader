import "fake-indexeddb/auto";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { GlossLanguage } from "shirabe-sdk/word-card/languages.js";
import { lookupOffline, lookupEntryOffline, parseOffline } from "../src/common/offline-dictionary.js";
import { installTestPack, packLines, packPayload } from "./support/pack.js";
import { browserDictionary } from "./support/parity-browser.js";
import { inflectionsAgree, intentErrors, readingsAgree, studyIdentityErrors, type StudyIdentity, type IntentExpectation, type IntentToken } from "./support/search-intent.js";

type Row = {
  query: string; languages: string[]; area: string; leaders: string[];
  leader_entries?: string[];
  offlineError?: string;
  web: Array<{ entry: string; headword: string }>;
};
type Input = {
  study_identities: Record<string, StudyIdentity>;
  pack: { path: string; revision: string; sha256: string };
  dictionaries: string[]; daidai: string; daidai_source: string; term_ids_sha256: string; rows: Row[];
  contexts: Array<{ text: string; expect: IntentExpectation[]; search_bar: IntentToken[]; web: Array<{ start: number; length: number; surface: string; lemma: string; reading: string | null; inflection: string[]; inflectionBase: string | null; entry: string | null; candidates: string[] }> }>;
};

async function main(): Promise<void> {
  const input = JSON.parse(readFileSync(process.argv[2]!, "utf8")) as Input;
  console.log(`Daidai ${input.daidai}: ${input.daidai_source}`);
  console.log(`Dictionary scope: ${input.dictionaries.join(", ")}`);
  const digest = createHash("sha256").update(readFileSync(input.pack.path)).digest("hex");
  if (digest !== input.pack.sha256) throw new Error("Pack changed after web export");
  const ids = new Set<string>();
  const lines: string[] = [];
  for (const line of packLines(input.pack.path)) {
    const record = JSON.parse(line) as { type: string; id?: string; dictionary?: string };
    if (record.type === "header") lines.push(line);
    if (record.type === "term" && input.dictionaries.includes(record.dictionary!)) {
      lines.push(line);
      ids.add(record.id!);
    }
  }
  if (ids.size < 100_000) throw new Error("Expected the complete JMdict corpus");
  const idsDigest = createHash("sha256").update([...ids].sort().join("\n")).digest("hex");
  if (idsDigest !== input.term_ids_sha256) throw new Error("Pack and web do not contain the same dictionary entries");
  for (const row of input.rows) {
    for (const entry of row.leader_entries ?? []) {
      if (!ids.has(entry)) throw new Error(`Expected lookup entry absent from pack: ${entry}`);
    }
    for (const card of row.web) {
      if (!ids.has(card.entry)) throw new Error(`Web entry absent from pack: ${card.entry}`);
    }
  }
  for (const row of input.contexts) {
    if (!row.expect.length) throw new Error(`Missing intent expectations: ${row.text}`);
    for (const card of row.search_bar) {
      if (!card.entry || !ids.has(card.entry)) throw new Error(`Search-bar entry absent from pack: ${card.entry}`);
    }
    for (const expected of row.expect) {
      if (!expected.leaders.length) throw new Error(`Missing expected leaders: ${row.text}`);
      for (const entry of [...expected.leaders, ...expected.offers ?? [], ...expected.excludes ?? []]) {
        if (!ids.has(entry)) throw new Error(`Expected entry absent from pack: ${entry}`);
      }
    }
  }
  console.log(`Installing all ${ids.size} terms from ${input.pack.revision}; no winner-based subsetting`);
  const payload = packPayload(lines);
  const generation = `${input.pack.revision}-${idsDigest.slice(0, 16)}`;
  const browser = process.env.PARITY_BROWSER_BUNDLE
    ? await browserDictionary(payload, generation, ids.size, process.env.PARITY_BROWSER_BUNDLE, input.dictionaries)
    : null;
  if (!browser) await installTestPack(payload, { contentRevision: generation, terms: ids.size });
  try {
  let failures = 0;
  for (const row of input.rows) {
    let offline: { entry?: string | null; headword: string } | null = null;
    let error: string | null = null;
    let errorReason: string | null = null;
    try {
      const languages = row.languages.map((language) => language === "es" ? "spa" : "eng") as GlossLanguage[];
      const started = performance.now();
      offline = browser ? await browser.lookup(row.query, languages) : await lookupOffline(row.query, languages, "https://shirabe.test");
      console.log(`Lookup ${JSON.stringify(row.query)}: ${Math.round(performance.now() - started)} ms`);
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught);
      errorReason = caught && typeof caught === "object" && "reason" in caught ? String(caught.reason) : null;
    }
    const web = row.web[0] ?? null;
    const expected = row.leaders.length ? web !== null && row.leaders.includes(web.headword) : web === null;
    const expectedEntries = !row.leader_entries || (web !== null && row.leader_entries.includes(web.entry)
      && Boolean(offline?.entry && row.leader_entries.includes(offline.entry)));
    const same = (offline?.entry ?? null) === (web?.entry ?? null);
    const pass = expected && expectedEntries && same && (row.offlineError ? errorReason === row.offlineError : error === null);
    if (!pass) failures += 1;
    console.log(JSON.stringify({ query: row.query, area: row.area, pass, expectedEntries, web, offline: offline && { entry: offline.entry, headword: offline.headword }, error }));
  }
  console.log(`${input.rows.length} paired lookups, ${failures} failures`);
  let contextFailures = 0;
  let intentFailures = 0;
  let searchBarFailures = 0;
  for (const row of input.contexts) {
    const tokens = browser ? await browser.parse(row.text) : await parseOffline(row.text, ["eng"], "https://shirabe.test");
    const offline = tokens.map((token) => ({ start: token.start, length: token.length, surface: token.surface, lemma: token.lemma,
      inflection: [] as string[],
      inflectionBase: undefined as string | undefined,
      pos: token.pos, reading: token.reading,
      entry: token.entry ?? null, candidates: token.candidates?.map((candidate) => candidate.entry) ?? (token.entry ? [token.entry] : []) }));
    const popupErrors: string[] = [];
    for (const token of offline) {
      const expected = row.expect.find((expected) => expected.surface === token.surface);
      if (!token.entry) continue;
      const definition = browser ? await browser.entry(token.entry, token.surface)
        : await lookupEntryOffline(token.entry, token.surface, ["eng"], "https://shirabe.test");
      token.inflection = definition?.inflection ?? [];
      popupErrors.push(...studyIdentityErrors(definition?.baseForm ?? definition?.inflectionBase ?? definition?.headword,
        definition?.baseReading ?? definition?.reading, input.study_identities[token.entry]).map((error) => `${token.surface}: ${error}`));
      token.inflectionBase = definition?.inflectionBase ?? (definition?.inflection?.length ? definition.headword : undefined);
      if (definition?.inflection?.length && expected?.lemma !== undefined && (definition.inflectionBase ?? definition.headword) !== expected.lemma) {
        popupErrors.push(`${token.surface}: unexpected popup base ${definition.inflectionBase ?? definition.headword}`);
      }
    }
    const boundaries = JSON.stringify(offline.map(({ start, length }) => [start, length])) === JSON.stringify(row.web.map(({ start, length }) => [start, length]));
    const identities = boundaries && offline.every((token, index) => token.entry === row.web[index]?.entry);
    const lemmas = boundaries && offline.every((token, index) => token.lemma === row.web[index]?.lemma);
    const readings = boundaries && readingsAgree(offline, row.web);
    const candidates = boundaries && offline.every((token, index) => JSON.stringify(token.candidates) === JSON.stringify(row.web[index]?.candidates));
    const inflections = boundaries && inflectionsAgree(offline, row.web);
    const pass = boundaries && identities && lemmas && readings && candidates && inflections;
    const webIntent = intentErrors(row.web, row.expect);
    const searchBarIntent = intentErrors(row.search_bar, row.expect.map(({ surface, leaders }) => ({ surface, leaders })));
    if (searchBarIntent.length) searchBarFailures += 1;
    const offlineIntent = intentErrors(offline, row.expect).concat(popupErrors);
    if (webIntent.length || offlineIntent.length) intentFailures += 1;
    if (!pass) contextFailures += 1;
    console.log(JSON.stringify({ text: row.text, pass, boundaries, identities, lemmas, readings, candidates, inflections, webIntent, offlineIntent,
      searchBarIntent, searchBar: row.search_bar, web: row.web, offline }));
  }
  console.log(`${input.contexts.length} paired API/offline parses, ${contextFailures} failures`);
  console.log(`${input.contexts.length} shared intent cases, ${intentFailures} failures`);
  console.log(`${input.contexts.length} search-bar preview cases, ${searchBarFailures} failures`);
  if (failures || contextFailures || intentFailures || searchBarFailures) process.exitCode = 1;
  } finally {
    await browser?.close();
  }
}

void main().catch((error) => { console.error(error); process.exitCode = 1; });
