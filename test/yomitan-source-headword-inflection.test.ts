import "fake-indexeddb/auto";
import assert from "node:assert/strict";
import test from "node:test";
import { lookupOffline, installDictionary, removeDictionary } from "../src/common/offline-dictionary.js";
import { packPayload, testPackManifest } from "./support/pack.js";

const HOST = "https://shirabe.test";

function term(
  id: string,
  headword: string,
  readings: string[],
  partsOfSpeech: string[],
  sourceHeadwords: Array<{ text: string; reading: string; rules: string[] }>,
  expressions = readings.map((text) => ({ text, script: "mixed", common: false, tags: [] })),
): string {
  return JSON.stringify({
    type: "term", id, dictionary: "yomitan-test", headword, expressions,
    readings: readings.map((text) => ({ text, kind: "kana" })),
    senses: [{ glosses: { jpn: [id] }, partsOfSpeech, fields: [], misc: [], dialects: [], restrictions: [] }],
    sourceHeadwords: sourceHeadwords.map((headword) => ({ ...headword, tags: [], score: 0 })),
  });
}

async function installPrivateTerms(records: string[]): Promise<void> {
  const publicPayload = packPayload([
    JSON.stringify({ type: "header", schemaVersion: 7, languages: ["eng"], source: "Public test dictionary" }),
  ]);
  const privatePayload = packPayload([
    JSON.stringify({ type: "header", schemaVersion: 7, languages: ["jpn"], source: "Private Yomitan test dictionary" }),
    ...records,
  ]);
  const publicManifest = testPackManifest(publicPayload, { contentRevision: "source-headword-public", terms: 0 }, {
    downloadUrl: "https://packs.test/source-headword-public.gz",
  });
  const privateManifest = testPackManifest(privatePayload, { contentRevision: "source-headword-private", terms: records.length }, {
    artifact: "source-headword-private.ndjson.gz",
    languages: ["jpn"],
    dictionaries: [{ slug: "yomitan-test", version: "1" }],
    downloadUrl: "https://packs.test/source-headword-private.gz",
  });
  const stack = {
    stackFingerprint: "f".repeat(16),
    dictionaries: ["yomitan-test:jpn"],
    dictionaryReveal: { "yomitan-test": "show" as const },
    dictionaryNames: { "yomitan-test": "Private Yomitan" },
    publicPack: publicManifest,
    personalPacks: [privateManifest],
  };
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith("/stack")) return new Response(JSON.stringify(stack), { headers: { "Content-Type": "application/json" } });
    if (url === publicManifest.downloadUrl) return new Response(new Uint8Array(publicPayload));
    if (url === privateManifest.downloadUrl) return new Response(new Uint8Array(privatePayload));
    return new Response(null, { status: 404 });
  }) as typeof fetch;
  await installDictionary("https://api.test", "Bearer test-token");
}

test("source headword rules deinflect private entries without leaking across spelling pairs", async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(async () => {
    globalThis.fetch = originalFetch;
    await removeDictionary();
  });

  await removeDictionary();
  await installPrivateTerms([
    term("yomitan-test:no-pos", "食べる", ["たべる"], [], [
      { text: "食べる", reading: "たべる", rules: ["v1"] },
    ]),
    term("yomitan-test:publisher-pos", "見る", ["みる"], ["他下一"], [
      { text: "見る", reading: "みる", rules: ["v1"] },
    ]),
    term("yomitan-test:v5", "歩く", ["あるく"], [], [
      { text: "歩く", reading: "あるく", rules: ["v5"] },
    ]),
    term("yomitan-test:vs", "勉強する", ["べんきょうする"], [], [
      { text: "勉強する", reading: "べんきょうする", rules: ["vs"] },
    ]),
    term("yomitan-test:vk", "来る", ["くる"], [], [
      { text: "来る", reading: "くる", rules: ["vk"] },
    ]),
    term("yomitan-test:adj-i", "高い", ["たかい"], [], [
      { text: "高い", reading: "たかい", rules: ["adj-i"] },
    ]),
    term("yomitan-test:pairs", "起きる", ["おきる", "かく"], [], [
      { text: "起きる", reading: "おきる", rules: ["v1"] },
      { text: "書く", reading: "かく", rules: [] },
    ], [
      { text: "起きる", script: "mixed", common: false, tags: [] },
      { text: "書く", script: "mixed", common: false, tags: [] },
    ]),
  ]);

  const exact = await lookupOffline("食べる", ["jpn"], HOST);
  assert.equal(exact?.entry, "yomitan-test:no-pos");
  assert.deepEqual(exact?.sourceHeadwordsByEntry?.["yomitan-test:no-pos"]?.[0]?.rules, ["v1"]);

  for (const [surface, entry, inflection] of [
    ["食べた", "yomitan-test:no-pos", ["past"]],
    ["食べない", "yomitan-test:no-pos", ["negative"]],
    ["見た", "yomitan-test:publisher-pos", ["past"]],
    ["見ない", "yomitan-test:publisher-pos", ["negative"]],
    ["歩いた", "yomitan-test:v5", ["past"]],
    ["勉強した", "yomitan-test:vs", ["past"]],
    ["来た", "yomitan-test:vk", ["past"]],
    ["高かった", "yomitan-test:adj-i", ["past"]],
    ["起きた", "yomitan-test:pairs", ["past"]],
  ] as const) {
    const definition = await lookupOffline(surface, ["jpn"], HOST);
    assert.equal(definition?.entry, entry, surface);
    assert.deepEqual(definition?.inflection, inflection, surface);
  }

  assert.equal((await lookupOffline("書く", ["jpn"], HOST))?.entry, "yomitan-test:pairs");
  assert.equal(await lookupOffline("書いた", ["jpn"], HOST), null);
});
