import "fake-indexeddb/auto";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { gzipSync } from "node:zlib";
import { cancelDictionaryInstall, checkDictionaryUpdate, deactivatePrivateDictionaries, dictionaryStatus, installDictionary, lookupEntryOffline, lookupKanjiOffline, lookupOffline, lookupVariants, parseOffline, removeDictionary, resolveParsedSpan, type PackManifest } from "../src/common/offline-dictionary.js";

const records = [
  { type: "header", schemaVersion: 7, languages: ["eng", "spa"], source: "Shirabe open-core" },
  {
    type: "term", id: "jmdict:1", dictionary: "jmdict", headword: "食べる",
    expressions: [{ text: "食べる", script: "mixed", common: true, tags: [] }],
    readings: [{ text: "たべる", kind: "kana" }],
    senses: [{ glosses: { eng: ["to eat"], spa: ["comer"] }, partsOfSpeech: ["v1", "vt"], fields: [], misc: [], dialects: [], restrictions: [] }],
    pitch: [
      { text: "食べる", reading: "たべる", downstep: 2 },
      { text: "たべる", reading: "たべる", downstep: 2 },
      { text: "たべる", reading: "たべる", downstep: 0 },
    ],
    frequencies: [{ source: "jiten-global", text: "食べる", reading: "たべる", rank: 100 }],
  },
  {
    type: "term", id: "jmdict:hierarchy", dictionary: "jmdict", headword: "階層",
    expressions: [{ text: "階層", script: "mixed", common: true, tags: [] }],
    readings: [{ text: "かいそう", kind: "kana" }],
    senses: [{
      glosses: { eng: ["hierarchy"], spa: ["jerarquía"] },
      partsOfSpeech: ["n", "v5k", "v5r"], fields: [], misc: [], dialects: [], restrictions: [],
      scopedTags: [
        { category: "part_of_speech", code: "n", scope: "entry" },
        { category: "part_of_speech", code: "v1", scope: "group" },
        { category: "part_of_speech", code: "n", scope: "sense" },
        { category: "part_of_speech", code: "v5k", scope: "sense" },
        { category: "part_of_speech", code: "v5r", scope: "sense" },
      ],
    }],
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
    // "hurl (" / "curl (" contain the substring "url (": real JMdict glosses
    // that a careless CSS-injection guard rejects, aborting the whole install.
    ["10", "投げつける", "なげつける", "to hurl (at)", "lanzar", "v1", 1000],
    ["11", "カール", "かーる", "to curl (hair)", "rizar", "vs", 1100],
    ["99998", "API", "えーぴーあい", "application programming interface", "interfaz de programación", "n", 1200],
  ].map(([id, headword, reading, english, spanish, pos, rank]) => ({
    type: "term", id: `jmdict:${id}`, dictionary: "jmdict", headword,
    expressions: [{ text: headword, script: "mixed", common: true, tags: [] }],
    readings: [{ text: reading, kind: "kana" }],
    senses: [{ glosses: { eng: [english], spa: [spanish] }, partsOfSpeech: [pos], fields: [], misc: [], dialects: [], restrictions: [] }],
    frequencies: [{ source: "jiten-global", text: headword, reading, rank }],
    // Cited by id: the sentence record itself is further down, stored once.
    ...(headword === "猫" ? { examples: ["tatoeba:tatoeba_1"] } : {}),
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
  // entry's first kana regardless pairs いい天気 with よいてんき: which cannot be
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
      // reading: that is the shape that exposed the uk-demotion bug.
      { text: "について", script: "kana", common: true, tags: [] },
      { text: "に就いて", script: "mixed", common: false, tags: ["rK"] },
      { text: "に付いて", script: "mixed", common: false, tags: ["rK"] },
    ],
    readings: [{ text: "について", kind: "kana" }],
    senses: [{ glosses: { eng: ["about; concerning; regarding"], spa: ["sobre; acerca de"] }, partsOfSpeech: ["exp"], fields: [], misc: ["uk"], dialects: [], restrictions: [] }],
    frequencies: [{ source: "jiten-global", text: "について", reading: "について", rank: 50 }],
  },
  // Pitch is filed under a WRITING (綺麗, きれい), but a usually-kana word leads with
  // its kana: and the corpus has an exact (きれい, きれい) row for almost nothing. So
  // the popup has to accept the sibling row for the same reading, or every kana-led
  // word (まつ, はな, こと) goes silent offline while the site shows its accent.
  {
    type: "term", id: "jmdict:25", dictionary: "jmdict", headword: "綺麗",
    expressions: [{ text: "綺麗", script: "mixed", common: true, tags: [] }],
    readings: [{ text: "きれい", kind: "kana" }],
    senses: [{ glosses: { eng: ["pretty; beautiful"], spa: ["bonito"] }, partsOfSpeech: ["adj-na"], fields: [], misc: ["uk"], dialects: [], restrictions: [] }],
    pitch: [{ text: "綺麗", reading: "きれい", downstep: 1 }],
    frequencies: [{ source: "jiten-global", text: "綺麗", reading: "きれい", rank: 1_500 }],
  },
  // An example sentence is stored ONCE and cited by id: the same Tatoeba line
  // illustrates dozens of words, so inlining it would ship it dozens of times.
  {
    type: "sentence", id: "tatoeba:tatoeba_1", japanese: "猫が好きです。",
    translations: { eng: "I like cats.", spa: "Me gustan los gatos." },
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
  // った→つ "deinflects" いつだった into いつだつ and matches it here: burying いつ.
  {
    type: "term", id: "jmdict:18", dictionary: "jmdict", headword: "逸脱",
    expressions: [{ text: "逸脱", script: "mixed", common: true, tags: [] }],
    readings: [{ text: "いつだつ", kind: "kana" }],
    senses: [{ glosses: { eng: ["deviation; departure"], spa: ["desviación"] }, partsOfSpeech: ["n", "vs"], fields: [], misc: [], dialects: [], restrictions: [] }],
    frequencies: [{ source: "jiten-global", text: "逸脱", reading: "いつだつ", rank: 15_000 }],
  },
  // いつ (when): usually-kana, so a bare kana surface is a confident exact match :
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
  // reads `senses.first` (Entry#usually_kana?), so only the primary sense counts.
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
  ...[
    ["debt-idiom", "首が回らない", "くびがまわらない", "adj-i"],
    ["verb-expression", "男を知る", "おとこをしる", "v5r"],
    ["dialect-expression", "どない", "どない", "adj-na"],
  ].map(([id, text, reading, inflectionClass]) => ({
    type: "term", id: `jmdict:${id}`, dictionary: "jmdict", headword: text,
    expressions: [{ text, script: "kanji", common: true, tags: [], inflectionClass }],
    readings: [{ text: reading, kind: "kana" }],
    senses: [{ glosses: { eng: ["expression"] }, partsOfSpeech: ["exp"], fields: [], misc: [], dialects: [], restrictions: [] }],
  })),
  {
    type: "term", id: "jmdict:restricted-sense", dictionary: "jmdict", headword: "一語",
    expressions: [{ text: "一語", script: "kanji", common: true, tags: [] },
      { text: "いちご", script: "kana", common: false, tags: [] }],
    readings: [{ text: "いちご", kind: "kana" }],
    senses: [
      { glosses: { eng: ["one word"] }, partsOfSpeech: ["n"], fields: [], misc: [], dialects: [], restrictions: [] },
      { glosses: { eng: ["one phrase"] }, partsOfSpeech: ["n"], fields: [], misc: [], dialects: [], restrictions: ["いちご"] },
    ],
  },
  {
    type: "term", id: "jmdict:contraction", dictionary: "jmdict", headword: "なのだ",
    expressions: [{ text: "なのだ", script: "kana", common: true, tags: [] },
      { text: "なんだ", script: "kana", common: false, tags: [] }],
    readings: [{ text: "なのだ", kind: "kana" }, { text: "なんだ", kind: "kana" }],
    senses: [{ glosses: { eng: ["it is"] }, partsOfSpeech: ["exp"], fields: [], misc: [], dialects: [], restrictions: [] }],
  },
  {
    type: "term", id: "jmdict:counted-three", dictionary: "jmdict", headword: "三つ",
    expressions: [{ text: "三つ", script: "kanji", common: true, tags: [] },
      { text: "３つ", script: "kanji", common: false, tags: [] }],
    readings: [{ text: "みっつ", kind: "kana" }],
    senses: [{ glosses: { eng: ["three things"] }, partsOfSpeech: ["n"], fields: [], misc: [], dialects: [], restrictions: [] }],
  },
  { type: "kanji", id: "kanjidic:食", char: "食", readings: { on: ["ショク"], kun: ["た.べる"] }, meanings: { eng: ["eat"], spa: ["comer"] }, strokes: 9 },
  // KANJIDIC lists pinyin/korean/vietnam before the Japanese readings, and 猫 is
  // also a word: both of which the lookup has to see past.
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
  sentences: records.filter((record) => record.type === "sentence").length,
};

function manifest(revision: string, sha256 = checksum) {
  return {
  schemaVersion: 7, buildRecipeVersion: 15, minimumExtensionVersion: "0.2.6", contentRevision: revision, builtAt: "2026-07-15T00:00:00Z",
    audio: { baseUrl: "https://cdn.shirabe.org/audio", path: "words", extension: "m4a", separator: "\x1f", engineVersion: 1, salt: "test-salt", defaultVoice: "male", voices: { male: 1_628_969_216, female: 345_585_728 } },
    artifact: "dictionary.ndjson.gz", compression: "gzip", mediaType: "application/x-ndjson",
    bytes: compressed.byteLength, sha256, counts, languages: ["eng", "spa"],
    dictionaries: [{ slug: "jmdict", version: "test" }], modifications: [], sources: [], downloadUrl: "https://packs.test/dictionary.gz",
  } as const;
}

async function dictionaryTermCount(database: string, dictionary: string): Promise<number> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(database);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  try {
    return await new Promise<number>((resolve, reject) => {
      const request = db.transaction("terms").objectStore("terms").index("dictionary").count(dictionary);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  } finally {
    db.close();
  }
}

test("an outdated stored pack is unavailable and updates without the daily delay", async (context) => {
  await removeDictionary();
  await dictionaryStatus();
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("shirabe-offline-dictionary-public-v1", 2);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  const transaction = db.transaction("meta", "readwrite");
  const metadata = transaction.objectStore("meta");
  metadata.put({ key: "activeGeneration", value: "old-installed" });
  metadata.put({ key: "manifest", value: { ...manifest("old-installed"), buildRecipeVersion: 12 } });
  metadata.put({ key: "lastUpdateCheck", value: new Date().toISOString() });
  await new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error);
  });
  db.close();
  const originalFetch = globalThis.fetch;
  context.after(async () => { globalThis.fetch = originalFetch; await removeDictionary(); });

  assert.equal((await dictionaryStatus()).installed, false);
  await assert.rejects(lookupOffline("食べる", ["eng"], "https://shirabe.test"), /Install the Shirabe dictionary/);
  await assert.rejects(parseOffline("食べる", ["eng"], "https://shirabe.test"), /Install the Shirabe dictionary/);

  let replacement = manifest("replacement");
  globalThis.fetch = (async (input: string | URL | Request) => (input instanceof Request ? input.url : String(input)).endsWith("/current")
    ? new Response(JSON.stringify(replacement), { headers: { "Content-Type": "application/json" } })
    : new Response(new Uint8Array(compressed), { headers: { "Content-Type": "application/gzip" } })) as typeof fetch;
  await checkDictionaryUpdate("https://api.test");
  assert.equal((await dictionaryStatus()).revision, "replacement");
  assert.equal((await dictionaryStatus()).installed, true);
  assert.equal((await lookupOffline("食べる", ["eng"], "https://shirabe.test"))?.entry, "jmdict:1");

  replacement = manifest("replacement-2");
  await installDictionary("https://api.test");
  replacement = manifest("replacement-3");
  await installDictionary("https://api.test");
  const installed = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("shirabe-offline-dictionary-public-v1");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  const oldSentences = await new Promise<number>((resolve, reject) => {
    const request = installed.transaction("sentences").objectStore("sentences").index("generation").count("replacement");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  installed.close();
  assert.equal(oldSentences, 0, "cleanup removes sentences outside the retained generations");
});

test("an authenticated stack installs personal overlays and applies source changes before refreshing bytes", async (context) => {
  await removeDictionary();
  const originalFetch = globalThis.fetch;
  context.after(async () => { globalThis.fetch = originalFetch; await removeDictionary(); });

  const personalRecords = [
    { type: "header", schemaVersion: 7, languages: ["jpn"], source: "Shirabe private dictionary" },
    {
      type: "term", id: "yomitan-test:1", dictionary: "yomitan-test", headword: "言葉",
      expressions: [{ text: "言葉", script: "kanji", common: false, tags: [] }],
      readings: [{ text: "ことば", kind: "kana" }],
      senses: [{ glosses: { jpn: ["意味"] }, partsOfSpeech: ["n"], fields: [], misc: [], dialects: [], restrictions: [] }],
    },
    {
      type: "term", id: "yomitan-test:2", dictionary: "yomitan-test", headword: "食べる",
      expressions: [{ text: "食べる", script: "mixed", common: false, tags: [] }],
      readings: [{ text: "たべる", kind: "kana" }],
      senses: [{ glosses: { jpn: ["食物を口に入れる"] }, partsOfSpeech: ["v1"], fields: [], misc: [], dialects: [], restrictions: [] }],
    },
  ];
  const personalArchive = gzipSync(personalRecords.map((record) => JSON.stringify(record)).join("\n") + "\n");
  const personal = {
    ...manifest("personal-v1"), artifact: "dictionary-personal.ndjson.gz", bytes: personalArchive.byteLength,
    sha256: createHash("sha256").update(personalArchive).digest("hex"),
    counts: { terms: 2, kanji: 0, sentences: 0 }, languages: ["jpn"],
    dictionaries: [{ slug: "yomitan-test", version: "1" }], sources: [],
    downloadUrl: "https://api.test/api/v1/dictionary-packs/yomitan-test/personal-v1",
  } as unknown as PackManifest;
  let stack = {
    stackFingerprint: "a".repeat(16), dictionaries: ["yomitan-test:ja", "jmdict:en"],
    dictionaryReveal: { "yomitan-test": "hover", jmdict: "show" },
    dictionaryNames: { "yomitan-test": "私の国語辞典", jmdict: "Shirabe" },
    publicPack: structuredClone(manifest("public-v1")) as unknown as PackManifest, personalPacks: [personal],
  };
  let downloads = 0;
  let privateAvailable = true;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    const authorization = input instanceof Request
      ? input.headers.get("Authorization")
      : new Headers(init?.headers).get("Authorization");
    if (url.endsWith("/dictionary-packs")) {
      assert.equal(authorization, "Bearer secret");
      const sources = stack.dictionaries.reduce<Array<{ dictionary: string; languages: string[]; reveal: "show" | "hover" }>>((all, reference) => {
        const [dictionary, language] = reference.split(":");
        const source = all.find((item) => item.dictionary === dictionary);
        if (source) source.languages.push(language!);
        else all.push({ dictionary: dictionary!, languages: [language!], reveal: stack.dictionaryReveal[dictionary as keyof typeof stack.dictionaryReveal] as "show" | "hover" });
        return all;
      }, []);
      return new Response(JSON.stringify({
        dictionaryStack: { fingerprint: stack.stackFingerprint, sources },
        packs: [{ ...stack.publicPack, kind: "base" }, ...stack.personalPacks.map((pack) => ({ ...pack, kind: "overlay" }))],
        pendingPacks: [],
      }), { headers: { "Content-Type": "application/json" } });
    }
    downloads += 1;
    if (url.includes("yomitan-test")) {
      assert.equal(authorization, "Bearer secret");
      if (!privateAvailable) return new Response(null, { status: 503 });
      return new Response(Uint8Array.from(personalArchive), { headers: { "Content-Type": "application/gzip" } });
    }
    return new Response(Uint8Array.from(compressed), { headers: { "Content-Type": "application/gzip" } });
  }) as typeof fetch;

  await installDictionary("https://api.test", "Bearer secret");
  assert.deepEqual(
    (await indexedDB.databases()).map(({ name }) => name).filter((name) => name?.startsWith("shirabe-offline-dictionary")).sort(),
    ["shirabe-offline-dictionary-private-v1", "shirabe-offline-dictionary-public-v1"],
    "published and account-private records have separate deletion boundaries",
  );
  assert.equal(await dictionaryTermCount("shirabe-offline-dictionary-public-v1", "yomitan-test"), 0);
  assert.equal(await dictionaryTermCount("shirabe-offline-dictionary-private-v1", "jmdict"), 0);
  assert.equal(await dictionaryTermCount("shirabe-offline-dictionary-private-v1", "yomitan-test"), 2);
  assert.equal((await dictionaryStatus()).stackFingerprint, "a".repeat(16));
  const definition = await lookupOffline("言葉", ["jpn"], "https://shirabe.test");
  assert.equal(definition?.entry, "yomitan-test:1");
  const personalSpan = await resolveParsedSpan("言葉", {
    start: 0, length: 2, surface: "言葉", lemma: "言葉", reading: "ことば", pos: "noun", kind: "word", content: true, state: "none",
  });
  assert.deepEqual(personalSpan.groups, [["yomitan-test:1"]]);
  const sharedSpan = await resolveParsedSpan("食べる", {
    start: 0, length: 3, surface: "食べる", lemma: "食べる", reading: "たべる", pos: "verb", kind: "word", content: true, state: "none",
  });
  assert.deepEqual(sharedSpan.groups, [["yomitan-test:2", "jmdict:1"]]);
  assert.equal(definition?.senses[0]?.dictionary, "yomitan-test");
  assert.equal(definition?.senses[0]?.covered, true);
  assert.deepEqual(definition?.senses[0]?.glosses, [{ lang: "jpn", tag: "JA", text: "意味" }]);
  const japaneseFirst = await lookupOffline("食べる", ["jpn", "eng"], "https://shirabe.test");
  assert.equal(japaneseFirst?.entry, "yomitan-test:2");
  assert.deepEqual(japaneseFirst?.senses.flatMap((sense) => sense.glosses.map((gloss) => gloss.text)),
    ["食物を口に入れる", "to eat"], "each enabled dictionary contributes its result in stack order");
  assert.equal(downloads, 2);

  await deactivatePrivateDictionaries();
  assert.equal((await dictionaryStatus()).terms, counts.terms, "status reports only the records that remain after disconnect");
  assert.equal(await lookupOffline("言葉", ["jpn"], "https://shirabe.test"), null,
    "disconnect makes private entries unreachable without waiting for a public-pack download");
  assert.equal((await lookupOffline("食べる", ["eng"], "https://shirabe.test"))?.entry, "jmdict:1",
    "the already-installed public dictionary remains available offline after disconnect");
  assert.deepEqual(
    (await indexedDB.databases()).map(({ name }) => name).filter((name) => name?.startsWith("shirabe-offline-dictionary")).sort(),
    ["shirabe-offline-dictionary-public-v1"],
    "disconnect deletes the account-private database",
  );
  privateAvailable = false;
  await assert.rejects(installDictionary("https://api.test", "Bearer secret"), /Dictionary download failed \(503\)/);
  assert.equal((await lookupOffline("食べる", ["eng"], "https://shirabe.test"))?.entry, "jmdict:1",
    "a failed reconnect keeps the public dictionary active");
  privateAvailable = true;
  await installDictionary("https://api.test", "Bearer secret");
  assert.equal(downloads, 4, "reconnecting downloads the private records that disconnect purged");
  assert.equal((await lookupOffline("言葉", ["jpn"], "https://shirabe.test"))?.entry, "yomitan-test:1");

  stack = { ...stack, stackFingerprint: "b".repeat(16), personalPacks: [{ ...personal, contentRevision: "personal-v2" }] };
  await installDictionary("https://api.test", "Bearer secret");
  assert.equal(downloads, 5, "a personal dictionary revision downloads only the private overlay");

  stack = { ...stack, stackFingerprint: "c".repeat(16), dictionaries: ["jmdict:en", "yomitan-test:ja"],
    dictionaryReveal: { jmdict: "show", "yomitan-test": "show" } };
  await installDictionary("https://api.test", "Bearer secret");
  assert.equal((await dictionaryStatus()).stackFingerprint, "c".repeat(16));
  assert.equal(downloads, 5, "order and reveal metadata reuse unchanged dictionary bytes");
  const publicFirst = await lookupOffline("食べる", ["eng", "jpn"], "https://shirabe.test");
  assert.equal(publicFirst?.entry, "jmdict:1");
  assert.deepEqual(publicFirst?.senses.flatMap((sense) => sense.glosses.map((gloss) => gloss.text)),
    ["to eat", "食物を口に入れる"]);
  assert.equal(publicFirst?.senses[publicFirst.senses.length - 1]?.covered, undefined);

  privateAvailable = false;
  stack = { ...stack, stackFingerprint: "d".repeat(16), dictionaries: ["jmdict:en"],
    personalPacks: [{ ...personal, contentRevision: "personal-v3" }] };
  await assert.rejects(installDictionary("https://api.test", "Bearer secret"), /Dictionary download failed \(503\)/);
  assert.equal(await lookupOffline("言葉", ["jpn"], "https://shirabe.test"), null,
    "disabling a private source takes effect even when refreshing its stored bytes fails");
  await assert.rejects(lookupEntryOffline("yomitan-test:1", "言葉", ["jpn"], "https://shirabe.test"),
    /Not available in this dictionary/, "a stale page handle cannot reopen the disabled source after a failed refresh");
  assert.equal((await dictionaryStatus()).stackFingerprint, "c".repeat(16));

  privateAvailable = true;
  stack = { ...stack, stackFingerprint: "d".repeat(16), dictionaries: ["jmdict:en"],
    personalPacks: [{ ...personal, contentRevision: "personal-v2" }] };
  await installDictionary("https://api.test", "Bearer secret");
  assert.equal(downloads, 6, "disabling a source only changes active stack metadata after the failed refresh");
  await assert.rejects(lookupEntryOffline("yomitan-test:2", "食べる", ["jpn"], "https://shirabe.test"),
    /Not available in this dictionary/, "a stale page handle cannot reopen a disabled dictionary entry");

  stack = { ...stack, stackFingerprint: "e".repeat(16), personalPacks: [] };
  await installDictionary("https://api.test", "Bearer secret");
  assert.equal(await lookupOffline("言葉", ["jpn"], "https://shirabe.test"), null,
    "losing personal dictionary access removes its installed records");
  await deactivatePrivateDictionaries();
  assert.deepEqual(
    (await indexedDB.databases()).map(({ name }) => name).filter((name) => name?.startsWith("shirabe-offline-dictionary")).sort(),
    ["shirabe-offline-dictionary-public-v1"],
  );
});

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
    const url = input instanceof Request ? input.url : String(input);
    return url.endsWith("/current")
      ? new Response(JSON.stringify(current), { headers: { "Content-Type": "application/json" } })
      : new Response(new Uint8Array(archive), { headers: { "Content-Type": "application/gzip" } });
  }) as typeof fetch;

  await installDictionary("https://api.test");
  for (const query of ["首が回らなく", "首が回らなかった", "首が回らなければ"]) {
    assert.equal((await lookupOffline(query, ["eng"], "https://shirabe.test"))?.entry, "jmdict:debt-idiom", query);
    assert.equal((await parseOffline(query, ["eng"], "https://shirabe.test"))[0]?.surface, query);
  }
  assert.equal((await lookupOffline("男を知った", ["eng"], "https://shirabe.test"))?.entry, "jmdict:verb-expression");
  assert.notEqual((await lookupOffline("男を知いた", ["eng"], "https://shirabe.test"))?.entry, "jmdict:verb-expression");
  assert.notEqual((await lookupOffline("どなかった", ["eng"], "https://shirabe.test"))?.entry, "jmdict:dialect-expression");
  for (const query of ["arm hair", "eat", "comer", "application programming interface"]) {
    await assert.rejects(lookupOffline(query, ["eng", "spa"], "https://shirabe.test"), /Meaning search is available online/);
  }
  assert.equal((await lookupOffline("API", ["eng"], "https://shirabe.test"))?.headword, "API");
  for (const query of ["taberu", "tabemashita", "ＴＡＢＥＭＡＳＨＩＴＡ", "  tabemashita  "]) {
    assert.equal((await lookupOffline(query, ["eng"], "https://shirabe.test"))?.entry, "jmdict:1", query);
  }
  for (const query of ["benkyoushimashita", "benkyou  shimashita", "benkyou\tshimashita", "benkyou　shimashita"]) {
    assert.equal((await lookupOffline(query, ["eng"], "https://shirabe.test"))?.entry, "jmdict:3", query);
  }
  await assert.rejects(lookupOffline("API hair", ["eng"], "https://shirabe.test"), /Meaning search is available online/);
  await assert.rejects(lookupEntryOffline("personal:1", "食べる", ["eng"], "https://shirabe.test"), /Not available in this dictionary/);
  const definition = await lookupOffline("食べました", ["spa"], "https://shirabe.test");
  assert.equal(definition?.headword, "食べる");
  assert.equal(definition?.sourceForm, "食べました");
  assert.equal(definition?.entry, "jmdict:1",
    "a hit names the entry it came from, so a card saved off it links instead of landing an orphan");
  assert.deepEqual(definition?.senses[0]?.glosses, [{ lang: "spa", tag: "ES", text: "comer" }]);
  assert.deepEqual(definition?.senses[0]?.partsOfSpeech.map((chip) => chip.label), ["Ichidan verb", "Transitive verb"],
    "offline POS codes resolve to the same short labels as the site");
  const hierarchy = await lookupOffline("階層", ["eng"], "https://shirabe.test");
  assert.deepEqual(hierarchy?.entryTagsByEntry, {
    "jmdict:hierarchy": [{ label: "Noun", code: "n", category: "pos", scope: "entry" }],
  });
  assert.deepEqual(hierarchy?.senses[0]?.groupTags, [
    { label: "Ichidan verb", code: "v1", category: "pos", scope: "group" },
  ]);
  assert.deepEqual(hierarchy?.senses[0]?.posCodes, ["n", "v5k", "v5r"]);
  assert.deepEqual(
    (await parseOffline("階層", ["eng"], "https://shirabe.test")).filter((token) => token.content).map((token) => token.lemma),
    ["階層"],
  );
  assert.deepEqual(definition?.pitch.map((pitch) => pitch.downstep), [2], "alternate-spelling pitch rows do not leak into the displayed headword");
  // The clip URL is no longer shipped per row (that was 40% of the pack): it is
  // hashed from the manifest's recipe. Recomputed here the way Audio::Clip#digest
  // does it server-side: if either side ever drifts, both stop naming the same
  // file on the CDN and every play button silently 404s.
  const expectedDigest = createHash("sha256")
    .update(["たべる", "2", "1628969216", "1", "test-salt"].join("\x1f")).digest("hex");
  assert.equal(definition?.pitch[0]?.audioUrl, `https://cdn.shirabe.org/audio/words/${expectedDigest}.m4a`);

  const kanaLed = await lookupOffline("きれい", ["eng"], "https://shirabe.test");
  assert.equal(kanaLed?.headword, "きれい", "a usually-kana word leads with its kana");
  assert.deepEqual(kanaLed?.pitch.map((pitch) => pitch.downstep), [1],
    "a kana-led headword still shows the pattern filed under its writing: the accent, and its clip, belong to the reading");
  assert.equal(kanaLed?.pitch[0]?.audioUrl, `https://cdn.shirabe.org/audio/words/${
    createHash("sha256").update(["きれい", "1", "1628969216", "1", "test-salt"].join("\x1f")).digest("hex")}.m4a`,
    "the clip is named after the reading being displayed, not the spelling the row was filed under");

  const withExample = await lookupOffline("猫", ["spa"], "https://shirabe.test");
  assert.deepEqual(withExample?.examples, [{ japanese: "猫が好きです。", translation: "Me gustan los gatos." }],
    "a term cites its example by id and the popup gets the sentence itself, in the reader's language");
  assert.equal((await lookupOffline("猫", ["eng"], "https://shirabe.test"))?.examples[0]?.translation, "I like cats.");

  const tokens = await parseOffline("昨日、食べました。", ["eng"], "https://shirabe.test");
  assert.ok(tokens.some((token) => token.lemma === "食べる" && token.surface === "食べました"));

  // Full-width headwords (Ｔシャツ, ２ちゃんねる, Ｎ響) are ~2% of pack keys. Queries
  // are NFKC-normalized, so the index must be too: and page text stays raw, so
  // the token surface must keep its original width.
  const fullWidth = await lookupOffline("Ｔシャツ", ["eng"], "https://shirabe.test");
  assert.equal(fullWidth?.headword, "Ｔシャツ");
  assert.deepEqual(fullWidth?.senses[0]?.glosses, [{ lang: "eng", tag: "EN", text: "T-shirt" }]);
  assert.equal((await lookupOffline("Tシャツ", ["eng"], "https://shirabe.test"))?.headword, "Ｔシャツ");
  const shirtTokens = await parseOffline("Ｔシャツを買った。", ["eng"], "https://shirabe.test");
  assert.ok(shirtTokens.some((token) => token.lemma === "Ｔシャツ" && token.surface === "Ｔシャツ"));

  const expressionTokens = await parseOffline("一石二鳥は便利だ。", ["eng"], "https://shirabe.test");
  assert.deepEqual(expressionTokens.filter((token) => token.content)[0], {
    start: 0, length: 4, surface: "一石二鳥", reading: "いっせきにちょう",
    // The code, not the label: `exp` is what content.css and the i+1
    // function-word test match on. The label belongs to the popup, which reads
    // it from the sense (asserted below).
    // `entry` is the pack's stable slug:sourceId handle, and the reason a token
    // carries one: it means the same thing here, on the web, and in the API,
    // where the lemma beside it means whichever thing each tokenizer decided.
    lemma: "一石二鳥", inflection: [], kind: "expression", entry: "jmdict:12", pos: "exp", content: true, state: "none", frequency: 80_000,
  });
  const expressionLookup = await lookupOffline("一石二鳥", ["eng"], "https://shirabe.test");
  assert.deepEqual(expressionLookup?.senses[0]?.partsOfSpeech.map((chip) => chip.label), ["Expression"]);
  const restrictedSense = await lookupEntryOffline("jmdict:restricted-sense", "一語", ["eng"], "https://shirabe.test");
  assert.deepEqual(restrictedSense?.senses.map((sense) => sense.glosses.map((gloss) => gloss.text)),
    [["one word"], ["one phrase"]]);
  assert.equal((await lookupEntryOffline("jmdict:restricted-sense", "いちご", ["eng"], "https://shirabe.test"))?.headword,
    "一語", "the card keeps its dictionary heading when the clicked form is kana");
  const contraction = await lookupEntryOffline("jmdict:contraction", "なんだ", ["eng"], "https://shirabe.test");
  assert.deepEqual([contraction?.headword, contraction?.reading, contraction?.sourceForm], ["なのだ", "なのだ", "なんだ"]);
  const parsedContraction = (await parseOffline("なんだ。", ["eng"], "https://shirabe.test"))[0];
  assert.deepEqual([parsedContraction?.lemma, parsedContraction?.reading], ["なんだ", "なんだ"]);
  assert.equal((await lookupEntryOffline("jmdict:counted-three", "3つ", ["eng"], "https://shirabe.test"))?.headword, "三つ");
  assert.deepEqual(expressionLookup?.senses[0]?.tags, [{ label: "Yojijukugo", code: "yoji", category: "misc" }],
    "a qualifier keeps its family, which is what colours it apart from the part of speech");
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
  // *reading*, not a writing form: so contextual confidence must accept a reading
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
  // `senses.first`: a uk tag on a minor later sense must not turn the kanji
  // headword into kana.
  assert.equal((await lookupOffline("表", ["eng"], "https://shirabe.test"))?.headword, "表",
    "uk on a non-primary sense does not flip the headword to kana");

  // Language ORDER is the contract: the reader's stack decides which meaning
  // reads first, exactly as the web walks Locales.source_stack_for in
  // WordCard#build_meanings. The senses appear ONCE, each carrying its meaning
  // in every language asked for, preferred first: this used to be the whole
  // list of senses per language, so an eight-sense word rendered sixteen.
  const spanishFirst = await lookupOffline("食べる", ["spa", "eng"], "https://shirabe.test");
  assert.deepEqual(spanishFirst?.senses.map((sense) => sense.glosses), [
    [{ lang: "spa", tag: "ES", text: "comer" }, { lang: "eng", tag: "EN", text: "to eat" }],
  ]);
  const englishFirst = await lookupOffline("食べる", ["eng", "spa"], "https://shirabe.test");
  assert.deepEqual(englishFirst?.senses.map((sense) => sense.glosses), [
    [{ lang: "eng", tag: "EN", text: "to eat" }, { lang: "spa", tag: "ES", text: "comer" }],
  ]);
  // A single language does not mix in the other: the server's default is one
  // language, and English is only a per-sense fallback when a gloss is missing.
  assert.deepEqual((await lookupOffline("食べる", ["spa"], "https://shirabe.test"))?.senses.flatMap((sense) => sense.glosses.map((row) => row.lang)), ["spa"]);
  assert.deepEqual((await lookupOffline("食べる", ["eng"], "https://shirabe.test"))?.senses.flatMap((sense) => sense.glosses.map((row) => row.lang)), ["eng"]);

  // Words and kanji are separate corpora, as on the web: a word search answers
  // with the word 猫/ねこ, and never with a kanji: 亜 has a KANJIDIC entry but no
  // term here, so the word search finds nothing rather than falling back.
  const cat = await lookupOffline("猫", ["eng"], "https://shirabe.test");
  assert.equal(cat?.headword, "猫");
  assert.equal(cat?.reading, "ねこ", "a single kanji that is also a word must answer with the word");
  assert.deepEqual(cat?.senses[0]?.glosses, [{ lang: "eng", tag: "EN", text: "cat" }]);
  assert.equal(await lookupOffline("亜", ["eng"], "https://shirabe.test"), null, "word search must never answer with a kanji entry");

  // The kanji breakdown is the explicit path, and KANJIDIC lists pinyin/korean/
  // vietnam first: only on/kun are Japanese.
  const sub = await lookupKanjiOffline("亜", ["eng"], "https://shirabe.test");
  assert.equal(sub?.headword, "亜");
  assert.equal(sub?.reading, "ア", "kanji readings must be Japanese, never pinyin/korean/vietnamese");
  assert.deepEqual(sub?.senses[0]?.glosses, [{ lang: "eng", tag: "EN", text: "sub-" }]);
  // On and kun stay APART on a kanji card: which family a reading belongs to is
  // most of what a learner is asking it. The other families KANJIDIC ships
  // (pinyin, korean, vietnamese) are not Japanese and never appear.
  assert.deepEqual(sub?.kanji, { on: ["ア"], kun: ["つ.ぐ"], strokes: 7 });
  assert.deepEqual((await lookupKanjiOffline("猫", ["eng"], "https://shirabe.test"))?.kanji,
    { on: ["ビョウ"], kun: ["ねこ"], strokes: 11 });
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
  // A usually-kana word's KANA spelling stays confident: only its kanji spellings
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
  // and stretched kana collapses, so caption/subtitle spellings reach the entry :
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
  for (let iteration = 0; iteration < 5; iteration += 1) await parseOffline(corpus, ["eng"], "https://shirabe.test");
  const benchmarkMs = performance.now() - benchmarkStartedAt;
  // Diagnostic only. Wall-clock on unknown CI hardware can't be asserted without
  // either flaking or being so loose it passes a 20x regression: which is what
  // the old `< 10_000` bound did for a run that takes a few hundred ms.
  context.diagnostic(`dictionary-prefix benchmark: 5 representative sentences in ${benchmarkMs.toFixed(1)} ms`);

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
    const url = input instanceof Request ? input.url : String(input);
    return url.endsWith("/current")
      ? new Response(JSON.stringify(current), { headers: { "Content-Type": "application/json" } })
      : new Response(new Uint8Array(archive), { headers: { "Content-Type": "application/gzip" } });
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

  for (const inflectionClass of ["unknown-class", null, 42]) {
    const invalidRecords = structuredClone(records);
    const invalidTerm = invalidRecords[1] as unknown as { expressions: Array<Record<string, unknown>> };
    invalidTerm.expressions[0]!.inflectionClass = inflectionClass;
    archive = gzipSync(invalidRecords.map((record) => JSON.stringify(record)).join("\n") + "\n");
    current = { ...manifest("v-invalid-inflection", createHash("sha256").update(archive).digest("hex")), bytes: archive.byteLength };
    await assert.rejects(installDictionary("https://api.test"), /term record is invalid/i);
    assert.equal((await dictionaryStatus()).revision, "v1");
  }

  const unsafeRecords = structuredClone(records);
  // Name the one shape this reaches into, rather than indexing into the union of
  // every record type in the fixture (a header has no senses).
  const term = unsafeRecords[1] as { senses: Array<{ glosses: { eng: string[] } }> };
  term.senses[0]!.glosses.eng = ["<script>alert(1)</script>"];
  archive = gzipSync(unsafeRecords.map((record) => JSON.stringify(record)).join("\n") + "\n");
  const unsafeChecksum = createHash("sha256").update(archive).digest("hex");
  current = { ...manifest("v-unsafe", unsafeChecksum), bytes: archive.byteLength };
  await assert.rejects(installDictionary("https://api.test"), /executable/i);
  assert.equal((await dictionaryStatus()).revision, "v1");

  // Clip URLs are built from the manifest's recipe now, so the recipe is where a
  // hostile pack would aim a play button. The base has to survive the same guard
  // the privileged background fetch applies: our bucket, over https, or nothing.
  archive = compressed;
  const offSiteAudio = manifest("v-external-audio");
  current = { ...offSiteAudio, audio: { ...offSiteAudio.audio, baseUrl: "https://example.com/audio" } } as unknown as typeof current; // deliberately off-site
  await assert.rejects(installDictionary("https://api.test"), /manifest is invalid/i);
  assert.equal((await dictionaryStatus()).revision, "v1");

  archive = compressed;
  current = { ...manifest("v-old-schema"), schemaVersion: 5 } as unknown as typeof current;
  await assert.rejects(installDictionary("https://api.test"), /schema 5/i);
  assert.equal((await dictionaryStatus()).revision, "v1");

  archive = compressed;
  current = { ...manifest("v-old-recipe"), buildRecipeVersion: 12 } as unknown as typeof current;
  await assert.rejects(installDictionary("https://api.test"), /dictionary pack.*outdated.*rebuild/i);
  assert.equal((await dictionaryStatus()).revision, "v1");
  assert.equal((await lookupOffline("食べました", ["eng"], "https://shirabe.test"))?.entry, "jmdict:1");

  archive = compressed;
  current = { ...manifest("v-future"), minimumExtensionVersion: "9.0.0" } as unknown as typeof current; // deliberately too new
  await assert.rejects(installDictionary("https://api.test"), /9\.0\.0 or newer/i);
  assert.equal((await dictionaryStatus()).revision, "v1");

  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
    const signal = input instanceof Request ? input.signal : init?.signal;
    if (signal?.aborted) return reject(new DOMException("cancelled", "AbortError"));
    signal?.addEventListener("abort", () => reject(new DOMException("cancelled", "AbortError")), { once: true });
  })) as typeof fetch;
  const pending = installDictionary("https://api.test");
  cancelDictionaryInstall();
  await assert.rejects(pending, /cancel|abort/i);
  assert.equal((await dictionaryStatus()).revision, "v1");

  await removeDictionary();
  assert.equal((await dictionaryStatus()).installed, false);
  current = manifest("v3");
  archive = compressed;
  globalThis.fetch = (async (input: string | URL | Request) => (input instanceof Request ? input.url : String(input)).endsWith("/current")
    ? new Response(JSON.stringify(current), { headers: { "Content-Type": "application/json" } })
    : new Response(new Uint8Array(archive), { headers: { "Content-Type": "application/gzip" } })) as typeof fetch;
  await checkDictionaryUpdate("https://api.test");
  assert.equal((await dictionaryStatus()).revision, "v3");
});

test("an honorific prefix is probed away so ご配慮 reaches 配慮", () => {
  const texts = (surface: string): string[] => lookupVariants(surface).map((variant) => variant.text);

  // JMdict lists ご連絡 but not ご配慮; probing the stripped stem is what keeps
  // the two reading the same way instead of one span and two.
  assert.ok(texts("ご配慮").includes("配慮"));
  assert.ok(texts("お手紙").includes("手紙"));
  assert.ok(texts("御配慮").includes("配慮"));
  assert.ok(texts("お忙しい").includes("忙しい"));

  // The verbatim spelling stays first and free, so a listed form still wins.
  assert.deepEqual(lookupVariants("ご配慮")[0], { text: "ご配慮", processingCost: 0 });

  // A kana stem is far more often an ordinary word than an honorific: stripping
  // おもう to もう or およそ to よそ would invent a reading nobody wrote.
  assert.ok(!texts("おもう").includes("もう"));
  assert.ok(!texts("およそ").includes("よそ"));
  assert.ok(!texts("ご").includes(""));
});

test("a narrow spelling reaches the wide one the dictionary files it under", () => {
  const texts = (surface: string): string[] => lookupVariants(surface).map((variant) => variant.text);

  // JMdict files acronyms and counted numbers WIDE (ＡＢＣ, ＥＤＴＡ, ３つ) while a
  // page writes them narrow, and `normalize` puts the page's text through NFKC,
  // which folds the other way. So the two never met: the pack carries ＡＢＣ and
  // not one narrow twin, and every one of those entries was unreachable from a
  // page that spelled it the ordinary way.
  assert.ok(texts("ABC").includes("ＡＢＣ"));
  assert.ok(texts("3つ").includes("３つ"));

  // Verbatim first and free, so a narrow spelling the pack really carries still
  // wins on its own terms.
  assert.deepEqual(lookupVariants("ABC")[0], { text: "ABC", processingCost: 0 });

  // Kana and kanji are not alnum, so nothing else moves.
  assert.deepEqual(texts("猫"), [ "猫" ]);
});
