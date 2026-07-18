import "fake-indexeddb/auto";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { gzipSync } from "node:zlib";
import { cancelDictionaryInstall, checkDictionaryUpdate, dictionaryStatus, installDictionary, lookupKanjiOffline, lookupOffline, parseOffline, removeDictionary } from "../src/common/offline-dictionary.js";

const records = [
  { type: "header", schemaVersion: 3, languages: ["eng", "spa"], source: "Shirabe open-core" },
  {
    type: "term", id: "jmdict:1", dictionary: "jmdict", headword: "食べる",
    expressions: [{ text: "食べる", script: "mixed", common: true, tags: [] }],
    readings: [{ text: "たべる", kind: "kana" }],
    senses: [{ glosses: { eng: ["to eat"], spa: ["comer"] }, partsOfSpeech: ["v1", "vt"], fields: [], misc: [], dialects: [], restrictions: [] }],
    pitch: [
      { text: "食べる", reading: "たべる", downstep: 2, audioUrl: `https://cdn.shirabe.org/audio/${"a".repeat(64)}.m4a` },
      { text: "たべる", reading: "たべる", downstep: 2, audioUrl: `https://cdn.shirabe.org/audio/${"b".repeat(64)}.m4a` },
      { text: "たべる", reading: "たべる", downstep: 0, audioUrl: `https://cdn.shirabe.org/audio/${"c".repeat(64)}.m4a` },
    ],
    frequencies: [{ source: "jiten-global", text: "食べる", reading: "たべる", rank: 100 }],
  },
  ...[
    ["2", "日本語", "にほんご", "Japanese language", "idioma japonés", "noun", 200],
    ["3", "勉強する", "べんきょうする", "to study", "estudiar", "verb", 300],
    ["4", "書く", "かく", "to write", "escribir", "verb", 400],
    ["5", "読む", "よむ", "to read", "leer", "verb", 500],
    ["6", "高い", "たかい", "high", "alto", "adjective", 600],
    ["7", "猫", "ねこ", "cat", "gato", "noun", 700],
    ["8", "見る", "みる", "to see", "ver", "verb", 800],
    // "hurl (" / "curl (" contain the substring "url (" — real JMdict glosses
    // that a careless CSS-injection guard rejects, aborting the whole install.
    ["10", "投げつける", "なげつける", "to hurl (at)", "lanzar", "verb", 1000],
    ["11", "カール", "かーる", "to curl (hair)", "rizar", "verb", 1100],
  ].map(([id, headword, reading, english, spanish, pos, rank]) => ({
    type: "term", id: `jmdict:${id}`, dictionary: "jmdict", headword,
    expressions: [{ text: headword, script: "mixed", common: true, tags: [] }],
    readings: [{ text: reading, kind: "kana" }],
    senses: [{ glosses: { eng: [english], spa: [spanish] }, partsOfSpeech: [pos], fields: [], misc: [], dialects: [], restrictions: [] }],
    frequencies: [{ source: "jiten-global", text: headword, reading, rank }],
  })),
  {
    type: "term", id: "jmdict:9", dictionary: "jmdict", headword: "Ｔシャツ",
    expressions: [{ text: "Ｔシャツ", script: "mixed", common: true, tags: [] }],
    readings: [{ text: "ティーシャツ", kind: "kana" }],
    senses: [{ glosses: { eng: ["T-shirt"], spa: ["camiseta"] }, partsOfSpeech: ["noun"], fields: [], misc: [], dialects: [], restrictions: [] }],
    frequencies: [{ source: "jiten-global", text: "Ｔシャツ", reading: "ティーシャツ", rank: 900 }],
  },
  {
    type: "term", id: "jmdict:12", dictionary: "jmdict", headword: "一石二鳥",
    expressions: [{ text: "一石二鳥", script: "mixed", common: false, tags: [] }],
    readings: [{ text: "いっせきにちょう", kind: "kana" }],
    senses: [{ glosses: { eng: ["killing two birds with one stone"], spa: ["matar dos pájaros de un tiro"] }, partsOfSpeech: ["exp"], fields: [], misc: ["yoji"], dialects: [], restrictions: [] }],
    frequencies: [{ source: "jiten-global", text: "一石二鳥", reading: "いっせきにちょう", rank: 80_000 }],
  },
  ...[
    ["13", "明日", "あした", "tomorrow", 1_000],
    ["14", "天気", "てんき", "weather", 2_000],
    ["15", "明日天気", "あしたてんき", "children's weather game", 128_981],
  ].map(([id, headword, reading, english, rank]) => ({
    type: "term", id: `jmdict:${id}`, dictionary: "jmdict", headword,
    expressions: [{ text: headword, script: "mixed", common: false, tags: [] }],
    readings: [{ text: reading, kind: "kana" }],
    senses: [{ glosses: { eng: [english], spa: [english] }, partsOfSpeech: ["noun"], fields: [], misc: [], dialects: [], restrictions: [] }],
    frequencies: [
      { source: "jiten-global", text: headword, reading, rank },
      ...(headword === "明日天気" ? [{ source: "jiten-global", text: "明日", reading: "あした", rank: 1 }] : []),
    ],
  })),
  // A usually-kana (uk) expression: its only writing forms are rare kanji, and
  // the surface that appears on a page is the kana reading について. The kana is a
  // *reading*, not an expression, so the confidence gate has to accept it.
  {
    type: "term", id: "jmdict:16", dictionary: "jmdict", headword: "について",
    expressions: [
      { text: "に就いて", script: "mixed", common: false, tags: ["rK"] },
      { text: "に付いて", script: "mixed", common: false, tags: ["rK"] },
    ],
    readings: [{ text: "について", kind: "kana" }],
    senses: [{ glosses: { eng: ["about; concerning; regarding"], spa: ["sobre; acerca de"] }, partsOfSpeech: ["exp"], fields: [], misc: ["uk"], dialects: [], restrictions: [] }],
    frequencies: [{ source: "jiten-global", text: "について", reading: "について", rank: 50 }],
  },
  // The bare particle が/に is common and confident on its own; without the fix a
  // について page splits into this particle + leftover kana one code point at a time.
  {
    type: "term", id: "jmdict:17", dictionary: "jmdict", headword: "に",
    expressions: [{ text: "に", script: "kana", common: true, tags: [] }],
    readings: [{ text: "に", kind: "kana" }],
    senses: [{ glosses: { eng: ["at (place); in; on"], spa: ["en; a"] }, partsOfSpeech: ["prt"], fields: [], misc: [], dialects: [], restrictions: [] }],
    frequencies: [{ source: "jiten-global", text: "に", reading: "に", rank: 1 }],
  },
  { type: "kanji", id: "kanjidic:食", char: "食", readings: { on: ["ショク"], kun: ["た.べる"] }, meanings: { eng: ["eat"], spa: ["comer"] }, strokes: 9 },
  // KANJIDIC lists pinyin/korean/vietnam before the Japanese readings, and 猫 is
  // also a word — both of which the lookup has to see past.
  {
    type: "kanji", id: "kanjidic:猫", char: "猫",
    readings: { pinyin: ["mao1"], korean_r: ["myo"], vietnam: ["Miêu"], on: ["ビョウ"], kun: ["ねこ"] },
    meanings: { eng: ["cat"], spa: ["gato"] }, strokes: 11,
  },
  { type: "kanji", id: "kanjidic:亜", char: "亜", readings: { pinyin: ["ya4"], on: ["ア"], kun: ["つ.ぐ"] }, meanings: { eng: ["sub-"], spa: ["sub-"] }, strokes: 7 },
];

const compressed = gzipSync(records.map((record) => JSON.stringify(record)).join("\n") + "\n");
const checksum = createHash("sha256").update(compressed).digest("hex");

function manifest(revision: string, sha256 = checksum) {
  return {
    schemaVersion: 3, buildRecipeVersion: 5, minimumExtensionVersion: "0.2.0", contentRevision: revision, builtAt: "2026-07-15T00:00:00Z",
    artifact: "dictionary.ndjson.gz", compression: "gzip", mediaType: "application/x-ndjson",
    bytes: compressed.byteLength, sha256, counts: { terms: 17, kanji: 3 }, languages: ["eng", "spa"],
    dictionaries: [{ slug: "jmdict", version: "test" }], modifications: [], sources: [], downloadUrl: "https://packs.test/dictionary.gz",
  } as const;
}

test("installs, deinflects, parses, and rolls back a corrupt offline pack", async (context) => {
  await removeDictionary();

  globalThis.fetch = (async () => new Response(JSON.stringify({
    title: "Dictionary pack unavailable",
    detail: "No local dictionary pack has been built yet.",
  }), { status: 503, headers: { "Content-Type": "application/problem+json" } })) as typeof fetch;
  await assert.rejects(installDictionary("https://api.test"), /No local dictionary pack has been built yet/);

  let current = manifest("v1");
  let archive: Uint8Array = compressed;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    return url.endsWith("/current")
      ? new Response(JSON.stringify(current), { headers: { "Content-Type": "application/json" } })
      : new Response(archive, { headers: { "Content-Type": "application/gzip" } });
  }) as typeof fetch;

  await installDictionary("https://api.test");
  const definition = await lookupOffline("食べました", ["spa"], "https://shirabe.test");
  assert.equal(definition?.headword, "食べる");
  assert.equal(definition?.sourceForm, "食べました");
  assert.deepEqual(definition?.senses[0]?.glosses, ["comer"]);
  assert.deepEqual(definition?.senses[0]?.partsOfSpeech, ["Ichidan verb", "Transitive verb"],
    "offline POS codes resolve to the same short labels as the site");
  assert.equal(definition?.pitch[0]?.audioUrl, `https://cdn.shirabe.org/audio/${"a".repeat(64)}.m4a`);
  assert.deepEqual(definition?.pitch.map((pitch) => pitch.downstep), [2], "alternate-spelling pitch rows do not leak into the displayed headword");

  const tokens = await parseOffline("昨日、食べました。", ["eng"], "https://shirabe.test");
  assert.ok(tokens.some((token) => token.lemma === "食べる" && token.surface === "食べました"));

  // Full-width headwords (Ｔシャツ, ２ちゃんねる, Ｎ響) are ~2% of pack keys. Queries
  // are NFKC-normalized, so the index must be too — and page text stays raw, so
  // the token surface must keep its original width.
  const fullWidth = await lookupOffline("Ｔシャツ", ["eng"], "https://shirabe.test");
  assert.equal(fullWidth?.headword, "Ｔシャツ");
  assert.deepEqual(fullWidth?.senses[0]?.glosses, ["T-shirt"]);
  assert.equal((await lookupOffline("Tシャツ", ["eng"], "https://shirabe.test"))?.headword, "Ｔシャツ");
  const shirtTokens = await parseOffline("Ｔシャツを買った。", ["eng"], "https://shirabe.test");
  assert.ok(shirtTokens.some((token) => token.lemma === "Ｔシャツ" && token.surface === "Ｔシャツ"));

  const expressionTokens = await parseOffline("一石二鳥は便利だ。", ["eng"], "https://shirabe.test");
  assert.deepEqual(expressionTokens.filter((token) => token.content)[0], {
    start: 0, length: 4, surface: "一石二鳥", reading: "いっせきにちょう",
    lemma: "一石二鳥", pos: "Expression", content: true, state: "none", frequency: 80_000,
  });
  const expressionLookup = await lookupOffline("一石二鳥", ["eng"], "https://shirabe.test");
  assert.deepEqual(expressionLookup?.senses[0]?.partsOfSpeech, ["Expression"]);
  assert.deepEqual(expressionLookup?.senses[0]?.tags, ["Yojijukugo"]);
  assert.equal((await lookupOffline("明日天気", ["eng"], "https://shirabe.test"))?.headword, "明日天気",
    "an explicit lookup must preserve an obscure exact dictionary entry");
  assert.deepEqual(
    (await parseOffline("明日天気になる。", ["eng"], "https://shirabe.test")).filter((token) => token.content).slice(0, 2).map((token) => token.surface),
    ["明日", "天気"],
    "contextual parsing must not blindly consume an uncommon untagged headword",
  );

  // A usually-kana expression appears on the page as its kana reading, which is a
  // *reading*, not a writing form — so contextual confidence must accept a reading
  // match, or について loses to the bare particle に and is split into に + つい + て.
  assert.deepEqual(
    (await parseOffline("猫について", ["eng"], "https://shirabe.test")).filter((token) => token.content).map((token) => token.surface),
    ["猫", "について"],
    "a usually-kana expression parses as one token, not split into に + つい + て",
  );

  // Language ORDER is the contract: the reader's stack decides which meaning
  // block renders first, exactly as the web walks Locales.source_stack_for in
  // WordCard#build_meanings. One block per language, preferred first.
  const spanishFirst = await lookupOffline("食べる", ["spa", "eng"], "https://shirabe.test");
  assert.deepEqual(spanishFirst?.senses.map((sense) => [sense.source, sense.glosses]), [
    ["Español · JMdict", ["comer"]],
    ["English · JMdict", ["to eat"]],
  ]);
  const englishFirst = await lookupOffline("食べる", ["eng", "spa"], "https://shirabe.test");
  assert.deepEqual(englishFirst?.senses.map((sense) => [sense.source, sense.glosses]), [
    ["English · JMdict", ["to eat"]],
    ["Español · JMdict", ["comer"]],
  ]);
  // A single language does not mix in the other — the server's default is one
  // language, and English is only a per-sense fallback when a gloss is missing.
  assert.deepEqual((await lookupOffline("食べる", ["spa"], "https://shirabe.test"))?.senses.map((sense) => sense.source), ["Español · JMdict"]);
  assert.deepEqual((await lookupOffline("食べる", ["eng"], "https://shirabe.test"))?.senses.map((sense) => sense.source), ["English · JMdict"]);

  // Words and kanji are separate corpora, as on the web: a word search answers
  // with the word 猫/ねこ, and never with a kanji — 亜 has a KANJIDIC entry but no
  // term here, so the word search finds nothing rather than falling back.
  const cat = await lookupOffline("猫", ["eng"], "https://shirabe.test");
  assert.equal(cat?.headword, "猫");
  assert.equal(cat?.reading, "ねこ", "a single kanji that is also a word must answer with the word");
  assert.deepEqual(cat?.senses[0]?.glosses, ["cat"]);
  assert.equal(await lookupOffline("亜", ["eng"], "https://shirabe.test"), null, "word search must never answer with a kanji entry");

  // The kanji breakdown is the explicit path, and KANJIDIC lists pinyin/korean/
  // vietnam first — only on/kun are Japanese.
  const sub = await lookupKanjiOffline("亜", ["eng"], "https://shirabe.test");
  assert.equal(sub?.headword, "亜");
  assert.equal(sub?.reading, "ア", "kanji readings must be Japanese, never pinyin/korean/vietnamese");
  assert.deepEqual(sub?.senses[0]?.glosses, ["sub-"]);
  assert.equal((await lookupKanjiOffline("猫", ["eng"], "https://shirabe.test"))?.reading, "ビョウ");
  assert.equal(await lookupKanjiOffline("食べる", ["eng"], "https://shirabe.test"), null, "the kanji path takes a single character");

  const corpus = "日本語を勉強していた。猫を見ました。高くなかった本を読みませんでした。書いている。";
  const corpusTokens = await parseOffline(corpus, ["eng"], "https://shirabe.test");
  const expectedSurfaces = ["日本語", "勉強していた", "猫", "見ました", "高くなかった", "読みませんでした", "書いている"];
  assert.deepEqual(
    corpusTokens.filter((token) => token.content).map((token) => [token.surface, token.lemma]),
    [["日本語", "日本語"], ["勉強していた", "勉強する"], ["猫", "猫"], ["見ました", "見る"], ["高くなかった", "高い"], ["読みませんでした", "読む"], ["書いている", "書く"]],
  );
  const intlWords = [...new Intl.Segmenter("ja", { granularity: "word" }).segment(corpus)]
    .filter((segment) => segment.isWordLike).map((segment) => segment.segment);
  const intlExact = expectedSurfaces.filter((surface) => intlWords.includes(surface)).length;
  context.diagnostic(`segmentation accuracy: dictionary-prefix ${expectedSurfaces.length}/${expectedSurfaces.length} exact inflected forms; Intl.Segmenter ${intlExact}/${expectedSurfaces.length}`);
  const benchmarkStartedAt = performance.now();
  for (let iteration = 0; iteration < 50; iteration += 1) await parseOffline(corpus, ["eng"], "https://shirabe.test");
  const benchmarkMs = performance.now() - benchmarkStartedAt;
  context.diagnostic(`dictionary-prefix benchmark: 50 representative sentences in ${benchmarkMs.toFixed(1)} ms`);
  assert.ok(benchmarkMs < 10_000, `representative local segmentation took ${benchmarkMs.toFixed(1)} ms for 50 sentences`);

  let routineRequests = 0;
  globalThis.fetch = (async () => {
    routineRequests += 1;
    throw new Error("Offline lookup must not use the network.");
  }) as typeof fetch;
  await lookupOffline("食べました", ["spa"], "https://shirabe.test");
  await parseOffline("食べました", ["eng"], "https://shirabe.test");
  assert.equal(routineRequests, 0);

  current = manifest("v2", "0".repeat(64));
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    return url.endsWith("/current")
      ? new Response(JSON.stringify(current), { headers: { "Content-Type": "application/json" } })
      : new Response(archive, { headers: { "Content-Type": "application/gzip" } });
  }) as typeof fetch;
  await assert.rejects(installDictionary("https://api.test"), /checksum/i);
  assert.equal((await dictionaryStatus()).revision, "v1");

  current = manifest("v-quota");
  const originalPut = IDBObjectStore.prototype.put;
  IDBObjectStore.prototype.put = function (value: unknown, key?: IDBValidKey): IDBRequest<IDBValidKey> {
    if ((value as { generation?: string })?.generation === "v-quota") throw new DOMException("Storage quota exceeded.", "QuotaExceededError");
    return originalPut.call(this, value, key as IDBValidKey);
  };
  try {
    await assert.rejects(installDictionary("https://api.test"), /quota/i);
  } finally {
    IDBObjectStore.prototype.put = originalPut;
  }
  assert.equal((await dictionaryStatus()).revision, "v1");

  const unsafeRecords = structuredClone(records);
  (unsafeRecords[1] as typeof records[1]).senses[0].glosses.eng = ["<script>alert(1)</script>"];
  archive = gzipSync(unsafeRecords.map((record) => JSON.stringify(record)).join("\n") + "\n");
  const unsafeChecksum = createHash("sha256").update(archive).digest("hex");
  current = { ...manifest("v-unsafe", unsafeChecksum), bytes: archive.byteLength };
  await assert.rejects(installDictionary("https://api.test"), /executable/i);
  assert.equal((await dictionaryStatus()).revision, "v1");

  const externalAudioRecords = structuredClone(records);
  (externalAudioRecords[1] as typeof records[1]).pitch[0].audioUrl = "https://example.com/local-tts.mp3";
  archive = gzipSync(externalAudioRecords.map((record) => JSON.stringify(record)).join("\n") + "\n");
  const externalAudioChecksum = createHash("sha256").update(archive).digest("hex");
  current = { ...manifest("v-external-audio", externalAudioChecksum), bytes: archive.byteLength };
  await assert.rejects(installDictionary("https://api.test"), /term record is invalid/i);
  assert.equal((await dictionaryStatus()).revision, "v1");

  archive = compressed;
  current = { ...manifest("v-future"), minimumExtensionVersion: "9.0.0" };
  await assert.rejects(installDictionary("https://api.test"), /9\.0\.0 or newer/i);
  assert.equal((await dictionaryStatus()).revision, "v1");

  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(new DOMException("cancelled", "AbortError")), { once: true });
  })) as typeof fetch;
  const pending = installDictionary("https://api.test");
  cancelDictionaryInstall();
  await assert.rejects(pending, /cancel|abort/i);
  assert.equal((await dictionaryStatus()).revision, "v1");

  await removeDictionary();
  assert.equal((await dictionaryStatus()).installed, false);
  current = manifest("v3");
  archive = compressed;
  globalThis.fetch = (async (input: string | URL | Request) => String(input).endsWith("/current")
    ? new Response(JSON.stringify(current), { headers: { "Content-Type": "application/json" } })
    : new Response(archive, { headers: { "Content-Type": "application/gzip" } })) as typeof fetch;
  await checkDictionaryUpdate("https://api.test");
  assert.equal((await dictionaryStatus()).revision, "v3");
});
