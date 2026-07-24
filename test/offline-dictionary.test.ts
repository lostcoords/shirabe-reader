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
    // POS are real JMdict class codes so deinflection's part-of-speech gate lets
    // each conjugated form reach its dictionary entry (v1/v5/vs/adj-i…).
    ["2", "日本語", "にほんご", "Japanese language", "idioma japonés", "n", 200],
    ["3", "勉強する", "べんきょうする", "to study", "estudiar", "vs", 300],
    ["4", "書く", "かく", "to write", "escribir", "v5k", 400],
    ["5", "読む", "よむ", "to read", "leer", "v5m", 500],
    ["6", "高い", "たかい", "high", "alto", "adj-i", 600],
    ["7", "猫", "ねこ", "cat", "gato", "n", 700],
    ["8", "見る", "みる", "to see", "ver", "v1", 800],
    // "hurl (" / "curl (" contain the substring "url (" — real JMdict glosses
    // that a careless CSS-injection guard rejects, aborting the whole install.
    ["10", "投げつける", "なげつける", "to hurl (at)", "lanzar", "v1", 1000],
    ["11", "カール", "かーる", "to curl (hair)", "rizar", "vs", 1100],
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
  // JMdict restricts a reading to the writings it actually spells: 良い天気 reads
  // either よいてんき or いいてんき, but いい天気 only ever reads いいてんき. Taking the
  // entry's first kana regardless pairs いい天気 with よいてんき — which cannot be
  // aligned, so the furigana smears over the whole word instead of the kanji.
  {
    type: "term", id: "jmdict:23", dictionary: "jmdict", headword: "良い天気",
    expressions: [
      { text: "良い天気", script: "mixed", common: true, tags: [] },
      { text: "よい天気", script: "mixed", common: false, tags: [] },
      { text: "いい天気", script: "mixed", common: false, tags: [] },
    ],
    readings: [
      { text: "よいてんき", kind: "kana", appliesTo: ["良い天気", "よい天気"] },
      { text: "いいてんき", kind: "kana", appliesTo: ["良い天気", "いい天気"] },
    ],
    senses: [{ glosses: { eng: ["nice weather"], spa: ["buen tiempo"] }, partsOfSpeech: ["exp"], fields: [], misc: [], dialects: [], restrictions: [] }],
    frequencies: [{ source: "jiten-global", text: "良い天気", reading: "よいてんき", rank: 6_510 }],
  },
  // A usually-kana (uk) expression: its only writing forms are rare kanji, and
  // the surface that appears on a page is the kana reading について. The kana is a
  // *reading*, not an expression, so the confidence gate has to accept it.
  {
    type: "term", id: "jmdict:16", dictionary: "jmdict", headword: "について",
    expressions: [
      // Real JMdict lists the kana itself as an expression, not only as a
      // reading — that is the shape that exposed the uk-demotion bug.
      { text: "について", script: "kana", common: true, tags: [] },
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
  // 来る (kuru, vk): the POS gate must still admit it. 来た deinflects to 来る with
  // v1 from the generic ichidan rule AND vk from the kuru rule; the two share a
  // dedup key, so conditions must OR (not first-wins) or the vk entry is rejected.
  {
    type: "term", id: "jmdict:20", dictionary: "jmdict", headword: "来る",
    expressions: [{ text: "来る", script: "mixed", common: true, tags: [] }],
    readings: [{ text: "くる", kind: "kana" }],
    senses: [{ glosses: { eng: ["to come"], spa: ["venir"] }, partsOfSpeech: ["vk"], fields: [], misc: [], dialects: [], restrictions: [] }],
    frequencies: [{ source: "jiten-global", text: "来る", reading: "くる", rank: 50 }],
  },
  // 逸脱 (いつだつ) is a noun/suru-verb. Without the POS gate, the godan past rule
  // った→つ "deinflects" いつだった into いつだつ and matches it here — burying いつ.
  {
    type: "term", id: "jmdict:18", dictionary: "jmdict", headword: "逸脱",
    expressions: [{ text: "逸脱", script: "mixed", common: true, tags: [] }],
    readings: [{ text: "いつだつ", kind: "kana" }],
    senses: [{ glosses: { eng: ["deviation; departure"], spa: ["desviación"] }, partsOfSpeech: ["n", "vs"], fields: [], misc: [], dialects: [], restrictions: [] }],
    frequencies: [{ source: "jiten-global", text: "逸脱", reading: "いつだつ", rank: 15_000 }],
  },
  // いつ (when): usually-kana, so a bare kana surface is a confident exact match —
  // it should win once 逸脱's spurious deinflection is rejected.
  {
    type: "term", id: "jmdict:19", dictionary: "jmdict", headword: "何時",
    expressions: [{ text: "何時", script: "mixed", common: true, tags: ["rK"] }],
    readings: [{ text: "いつ", kind: "kana" }],
    senses: [{ glosses: { eng: ["when; how soon"], spa: ["cuándo"] }, partsOfSpeech: ["pn", "adv"], fields: [], misc: ["uk"], dialects: [], restrictions: [] }],
    frequencies: [{ source: "jiten-global", text: "何時", reading: "いつ", rank: 500 }],
  },
  // 凄い is usually-kana; emphasis katakana (スゴイ) and stretched kana (すっごい,
  // すごーい) are pervasive in captions and must fold/collapse back to it.
  {
    type: "term", id: "jmdict:21", dictionary: "jmdict", headword: "凄い",
    expressions: [{ text: "凄い", script: "mixed", common: false, tags: ["rK"] }],
    readings: [{ text: "すごい", kind: "kana" }],
    senses: [{ glosses: { eng: ["amazing; incredible"], spa: ["increíble"] }, partsOfSpeech: ["adj-i"], fields: [], misc: ["uk"], dialects: [], restrictions: [] }],
    frequencies: [{ source: "jiten-global", text: "凄い", reading: "すごい", rank: 800 }],
  },
  // `uk` on a MINOR later sense must not flip the whole entry to kana: the backend
  // reads `facets.first` (Entry#usually_kana?), so only the primary sense counts.
  // 表 is ordinarily written in kanji; a secondary "front side" sense tagged uk
  // must leave the kanji headword alone.
  {
    type: "term", id: "jmdict:22", dictionary: "jmdict", headword: "表",
    expressions: [{ text: "表", script: "mixed", common: true, tags: [] }],
    readings: [{ text: "ひょう", kind: "kana" }],
    senses: [
      { glosses: { eng: ["table; chart"], spa: ["tabla"] }, partsOfSpeech: ["n"], fields: [], misc: [], dialects: [], restrictions: [] },
      { glosses: { eng: ["front side"], spa: ["anverso"] }, partsOfSpeech: ["n"], fields: [], misc: ["uk"], dialects: [], restrictions: [] },
    ],
    frequencies: [{ source: "jiten-global", text: "表", reading: "ひょう", rank: 900 }],
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
// Derived, not hand-counted: the installer rejects a pack whose record counts
// disagree with its manifest, so adding a fixture term must not mean editing a
// magic number in two places.
const counts = {
  terms: records.filter((record) => record.type === "term").length,
  kanji: records.filter((record) => record.type === "kanji").length,
};

function manifest(revision: string, sha256 = checksum) {
  return {
    schemaVersion: 3, buildRecipeVersion: 5, minimumExtensionVersion: "0.2.0", contentRevision: revision, builtAt: "2026-07-15T00:00:00Z",
    artifact: "dictionary.ndjson.gz", compression: "gzip", mediaType: "application/x-ndjson",
    bytes: compressed.byteLength, sha256, counts, languages: ["eng", "spa"],
    dictionaries: [{ slug: "jmdict", version: "test" }], modifications: [], sources: [], downloadUrl: "https://packs.test/dictionary.gz",
  } as const;
}

test("installs, deinflects, parses, and rolls back a corrupt offline pack", async (context) => {
  await removeDictionary();

  // This test rewires fetch a dozen times; hand it back so the rest of the
  // process doesn't get a stub that answers every URL with a dictionary pack.
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });

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

  // Each written form must answer with the reading JMdict restricts to it, or
  // the furigana can't align and smears over the whole word.
  assert.equal((await lookupOffline("いい天気", ["eng"], "https://shirabe.test"))?.reading, "いいてんき",
    "a form must not borrow a reading restricted to its sibling writings");
  assert.equal((await lookupOffline("良い天気", ["eng"], "https://shirabe.test"))?.reading, "よいてんき");
  assert.equal((await lookupOffline("よい天気", ["eng"], "https://shirabe.test"))?.reading, "よいてんき");
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

  // An out-of-dictionary katakana run (a loanword/name the pack doesn't carry)
  // is one token, not one code point each. It stops at the script boundary, so
  // the following particle still tokenizes on its own.
  assert.deepEqual(
    (await parseOffline("ミュンヘンに", ["eng"], "https://shirabe.test")).map((token) => [token.surface, token.content]),
    [["ミュンヘン", false], ["に", true]],
    "an unknown katakana run coalesces into a single token, split at the script boundary",
  );

  // `uk` is read from the PRIMARY sense only, matching the backend's
  // `facets.first` — a uk tag on a minor later sense must not turn the kanji
  // headword into kana.
  assert.equal((await lookupOffline("表", ["eng"], "https://shirabe.test"))?.headword, "表",
    "uk on a non-primary sense does not flip the headword to kana");

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
  // Deinflection must respect part-of-speech: いつだった must not collapse into the
  // noun/suru-verb 逸脱 via the godan past rule (った→つ). いつ is segmented on its own.
  const itsuTokens = await parseOffline("いつだったか", ["eng"], "https://shirabe.test");
  const itsu = itsuTokens.find((token) => token.content);
  assert.equal(itsu?.surface, "いつ", "いつ is not swallowed into 逸脱");
  assert.ok(!itsuTokens.some((token) => token.lemma === "逸脱"), "逸脱 is never matched for いつだった");
  // A usually-kana word leads with its kana, not its rare kanji (何時), like the site.
  assert.equal(itsu?.lemma, "いつ", "the uk word displays as kana いつ, not 何時");
  assert.equal((await lookupOffline("いつ", ["eng"], "https://shirabe.test"))?.headword, "いつ", "いつ lookup leads with kana");
  assert.equal((await lookupOffline("何時", ["eng"], "https://shirabe.test"))?.headword, "何時", "looking up the kanji spelling still leads with 何時");
  // A usually-kana word's KANA spelling stays confident — only its kanji spellings
  // are demoted. JMdict lists について as a real expression, and demoting every uk
  // spelling shredded it into に + つい + て.
  assert.deepEqual(
    (await parseOffline("猫について", ["eng"], "https://shirabe.test")).filter((token) => token.content).map((token) => token.surface),
    ["猫", "について"],
    "a uk word's kana expression is not demoted",
  );

  // The POS gate must not drop irregular verbs: 来た/来て/来ない all reach 来る (vk).
  for (const form of ["来た", "来て", "来ない", "来ます"]) {
    assert.equal((await lookupOffline(form, ["eng"], "https://shirabe.test"))?.headword, "来る", `${form} deinflects to 来る (vk not rejected)`);
  }

  // Prohibitive 〜な and negative-te 〜ないで have no dedicated Yomitan deinflection
  // rule, yet the reader still resolves them: prefix-longest-first finds the 食べる
  // writing under 食べるな, and deinflects the 食べない / 食べます prefix under 食べないで /
  // 食べませんでしたり. Guards that span-shrinking keeps covering them.
  for (const [form, base] of [["食べるな", "食べる"], ["見るな", "見る"], ["食べないで", "食べる"], ["読まないで", "読む"], ["食べませんでしたり", "食べる"]]) {
    assert.equal((await lookupOffline(form, ["eng"], "https://shirabe.test"))?.headword, base, `${form} resolves to ${base} via span-shrinking`);
  }
  // Polite requests 〜てください / 〜ないでください: the reader deinflects the longest
  // prefix (食べて / 食べないで → the verb) and leaves ください as its own word.
  for (const [form, base] of [["食べてください", "食べる"], ["食べないでください", "食べる"], ["来ないでください", "来る"]]) {
    assert.equal((await lookupOffline(form, ["eng"], "https://shirabe.test"))?.headword, base, `${form} resolves to ${base} (ください is a separate word)`);
  }

  // Text-processor variants (Yomitan-style): emphasis katakana folds to hiragana
  // and stretched kana collapses, so caption/subtitle spellings reach the entry —
  // while the on-page surface is preserved and a lone mora (ミ) is never folded.
  for (const surface of ["スゴイ", "すっごい", "すごーい", "すっっごーい"]) {
    const first = (await parseOffline(surface, ["eng"], "https://shirabe.test")).find((token) => token.content);
    assert.equal(first?.surface, surface, `${surface} keeps its on-page spelling`);
    assert.equal(first?.lemma, "すごい", `${surface} folds/collapses to すごい`);
  }
  // A single mora is never emphasis katakana, so it must not fold: ミ would
  // otherwise become み and deinflect to 見る, shredding an unknown katakana name.
  assert.equal(
    (await parseOffline("ミ", ["eng"], "https://shirabe.test")).find((token) => token.content),
    undefined,
    "a lone katakana mora is never folded into a hiragana word",
  );
  // The verbatim spelling outranks a folded one: 見る stays 見る, not a folded rival.
  assert.equal((await lookupOffline("見る", ["eng"], "https://shirabe.test"))?.headword, "見る");

  const intlWords = [...new Intl.Segmenter("ja", { granularity: "word" }).segment(corpus)]
    .filter((segment) => segment.isWordLike).map((segment) => segment.segment);
  const intlExact = expectedSurfaces.filter((surface) => intlWords.includes(surface)).length;
  context.diagnostic(`segmentation accuracy: dictionary-prefix ${expectedSurfaces.length}/${expectedSurfaces.length} exact inflected forms; Intl.Segmenter ${intlExact}/${expectedSurfaces.length}`);
  const benchmarkStartedAt = performance.now();
  for (let iteration = 0; iteration < 50; iteration += 1) await parseOffline(corpus, ["eng"], "https://shirabe.test");
  const benchmarkMs = performance.now() - benchmarkStartedAt;
  // Diagnostic only. Wall-clock on unknown CI hardware can't be asserted without
  // either flaking or being so loose it passes a 20x regression — which is what
  // the old `< 10_000` bound did for a run that takes a few hundred ms.
  context.diagnostic(`dictionary-prefix benchmark: 50 representative sentences in ${benchmarkMs.toFixed(1)} ms`);

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
