import "fake-indexeddb/auto";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { lookupEntryOffline, parseOffline } from "../src/common/offline-dictionary.js";
import { installTestPack, packPayload } from "./support/pack.js";

// The offline half of `POST /api/v1/words/identify`.
//
// One answer is a claim we often cannot support: きみ is 君, 黄身 or 黍, and only
// the reader knows which they meant. The parser has always ranked this list to
// pick its winner and then thrown the runners-up away at the last step, which is
// exactly the bug the server had before candidates, on the other side.
//
// It matters more offline than online: the extension resolves against the pack
// and never calls the API for a lookup, so nothing the server learned reaches it
// unless it is ported.

const HOST = "https://shirabe.test";

function term(id: string, headword: string, kanji: string | null, kana: string, gloss: string, common = true) {
  return JSON.stringify({
    type: "term", id, dictionary: "jmdict", headword,
    expressions: kanji
      ? [ { text: kanji, script: "kanji", common, tags: [] } ]
      : [ { text: kana, script: "kana", common, tags: [] } ],
    readings: [ { text: kana, kind: "kana" } ],
    senses: [ { glosses: { eng: [ gloss ] }, partsOfSpeech: [ "n" ], fields: [], misc: [], dialects: [], restrictions: [] } ],
  });
}

const HEADER = JSON.stringify({ type: "header", schemaVersion: 4, languages: [ "eng", "spa" ], source: "Shirabe candidates" });

// The revision has to differ per pack: the installer treats a repeated one as
// "already have this" and keeps whatever is installed, so two tests sharing a
// revision silently run against each other's dictionary.
async function install(lines: string[]): Promise<void> {
  const revision = createHash("sha256").update(lines.join("\n")).digest("hex").slice(0, 12);
  await installTestPack(packPayload([ HEADER, ...lines ]), { contentRevision: revision, terms: lines.length });
}

test("a span several words claim offers them all, the chosen one first", async () => {
  await install([
    term("jmdict:1247250", "君", "君", "きみ", "you"),
    term("jmdict:1182060", "黄身", "黄身", "きみ", "egg yolk", false),
  ]);

  const [ token ] = await parseOffline("きみ", [ "eng" ], HOST);

  assert.ok(token.candidates, "a span two words claim is a question, not an answer");
  assert.equal(token.candidates[0].entry, token.entry,
    "the head is the word this token resolved to, so a caller reading only the first gets `entry`");
  assert.deepEqual(new Set(token.candidates.map((candidate) => candidate.entry)),
    new Set([ "jmdict:1247250", "jmdict:1182060" ]),
    "both are reachable: ranked, never filtered");
});

// Absence means "nothing to choose between", so a client tests for the key
// rather than counting a list that is usually one long.
test("a span only one word claims offers no choice at all", async () => {
  await install([ term("jmdict:1522150", "本", "本", "ほん", "book") ]);

  const [ token ] = await parseOffline("本", [ "eng" ], HOST);

  assert.equal(token.entry, "jmdict:1522150");
  assert.ok(!("candidates" in token), "one word is not a question");
});

// A picker offers other readings of the word in front of the reader, never a
// different cut of the sentence. Re-segmenting is the parser's job and it has
// already done it.
test("a longer word sharing a prefix is not offered as a choice", async () => {
  await install([
    term("jmdict:1000001", "日", "日", "ひ", "day"),
    term("jmdict:1000002", "日本", "日本", "にほん", "Japan"),
  ]);

  const [ token ] = await parseOffline("日本", [ "eng" ], HOST);

  assert.equal(token.surface, "日本", "the parser cut the longer word");
  assert.ok(!token.candidates?.some((candidate) => candidate.entry === "jmdict:1000001"),
    "日 covers a different span, so it is a different question");
});

// The reachability half, and the one that took a second list to fix. This was
// the extension's version of the bug the server had before candidates: a word
// the spelling merely CARRIES never entered the list at all, so there was
// nothing for the ladder to rank. `contextuallyConfident` gates the parser's
// candidate set, and a kanji word matched by its kana READING only clears that
// gate when the entry is `uk`. 君 is not.
//
// The gate is right for the PARSER: dropping it shatters 全く into 全 + く. So
// `contextualCandidates` answers with both sets out of one gather, and the cut
// still comes from the gated one. Only the list reads the other.
test("a word the spelling merely reads is reachable, behind the word it names", async () => {
  await install([
    term("jmdict:1226580", "きみ", null, "きみ", "millet"),
    term("jmdict:1247250", "君", "君", "きみ", "you"),
  ]);

  const [ token ] = await parseOffline("きみ", [ "eng" ], HOST);

  assert.equal(token.entry, "jmdict:1226580", "the filed word still answers, which is the cut the gate makes");
  assert.deepEqual(token.candidates?.map((candidate) => candidate.entry),
    [ "jmdict:1226580", "jmdict:1247250" ],
    "and 君 is there to be picked: rung 2, filed before carried, never a filter");
});

// The parity check E1 exists for: same inputs in, same order out. This is the
// exact list `POST /api/v1/words/identify` answers for `{lemma: "きみ"}` with no
// pos and no reading, recorded in docs/plans/word-resolution.md:
//
//   {lemma: "きみ"} -> きみ, 君, 黄身
//
// One ranking function with optional inputs, not two algorithms. Rung 1
// (DECISIVE_POS) needs a morphological analyser and stays out of reach offline,
// so the two engines agree on every rung the offline half can stand on.
test("the offline order is the order identify answers with the same inputs", async () => {
  await install([
    term("jmdict:1182060", "黄身", "黄身", "きみ", "egg yolk", false),
    term("jmdict:1247250", "君", "君", "きみ", "you"),
    term("jmdict:1226580", "きみ", null, "きみ", "millet"),
  ]);

  const [ token ] = await parseOffline("きみ", [ "eng" ], HOST);

  assert.deepEqual(token.candidates?.map((candidate) => candidate.headword),
    [ "きみ", "君", "黄身" ],
    "filed first, then common, then rank: the server's ladder minus the rung that needs a POS");
});

// Rung 4, reached only when nothing above separates the field. Both are carried
// kanji words read きみ, so rank breaks the tie and the commoner word wins.
test("where nothing else separates them, the commoner word leads", async () => {
  await install([
    term("jmdict:1182060", "黄身", "黄身", "きみ", "egg yolk", false),
    term("jmdict:1247250", "君", "君", "きみ", "you", true),
  ]);

  const [ token ] = await parseOffline("きみ", [ "eng" ], HOST);

  assert.equal(token.candidates?.[0].entry, "jmdict:1247250",
    "neither is filed under きみ and neither reading discriminates, so common decides");
});

// ── the pick, and what makes it worth offering ──────────────────────────────
// A picker that cannot show you what you picked is a picker nobody uses, and
// re-looking-up the spelling would hand back the word the reader just rejected.
// So the chosen word is fetched by its HANDLE: the terms store is keyed on the
// entry id, so choosing costs one primary-key read rather than a re-parse.
test("a picked word is fetched by its handle, not looked up again", async () => {
  await install([
    term("jmdict:1226580", "きみ", null, "きみ", "millet"),
    term("jmdict:1247250", "君", "君", "きみ", "you"),
  ]);

  const [ token ] = await parseOffline("きみ", [ "eng" ], HOST);
  assert.equal(token.entry, "jmdict:1226580", "the parser still answers the filed word");

  const picked = await lookupEntryOffline("jmdict:1247250", "きみ", [ "eng" ], HOST);

  assert.equal(picked?.entry, "jmdict:1247250");
  assert.equal(picked?.headword, "君");
  assert.deepEqual(picked?.senses.map((sense) => sense.glosses).flat(), [ "you" ],
    "the definition comes back whole, so the popup renders a pick like any other word");
});

// An entry the pack does not carry answers nothing rather than falling back to
// the spelling: a stale handle must not quietly show a different word.
test("a handle the pack does not carry answers nothing", async () => {
  await install([ term("jmdict:1522150", "本", "本", "ほん", "book") ]);

  assert.equal(await lookupEntryOffline("jmdict:9999999", "本", [ "eng" ], HOST), null);
});
