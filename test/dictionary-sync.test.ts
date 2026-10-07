import "fake-indexeddb/auto";
import assert from "node:assert/strict";
import test from "node:test";
import { packPayload, testPackManifest } from "./support/pack.js";
import { checkDictionaryUpdate, dictionaryStatus, installDictionary, lookupOffline, removeDictionary,
  deactivatePrivateDictionaries, disablePrivateDictionaryLookups, setActiveDictionaryStack, type DictionaryStackManifest } from "../src/common/offline-dictionary.js";

function pack(slug: string, revision = "1") {
  const payload = packPayload([
    JSON.stringify({ type: "header", schemaVersion: 7, languages: ["eng"], source: slug }),
    JSON.stringify({ type: "term", id: `${slug}:cat`, dictionary: slug, headword: "猫",
      expressions: [{ text: "猫", script: "kanji", common: true, tags: [] }], readings: [{ text: "ねこ", kind: "kana" }],
      senses: [{ glosses: { eng: [`${slug}-${revision}`] }, partsOfSpeech: ["n"], fields: [], misc: [], dialects: [], restrictions: [] }] }),
  ]);
  return { payload, manifest: testPackManifest(payload, { contentRevision: `${slug}-${revision}`, terms: 1 }, {
    dictionaries: [{ slug, version: revision, languages: ["eng"] }], languages: ["eng"],
    downloadUrl: `https://packs.test/${slug}-${revision}.gz`,
  }) };
}

async function catalog(context: { after: (fn: () => Promise<void>) => void }, count = 3) {
  await removeDictionary();
  const originalFetch = globalThis.fetch;
  context.after(async () => { globalThis.fetch = originalFetch; await removeDictionary(); });
  const base = pack("jmdict");
  const personal = Array.from({ length: count }, (_, index) => pack(`personal-${index}`));
  const data = {
    base, checks: 0, packs: personal, pending: [] as string[], retryAfter: "5", failed: new Set<string>(), downloads: [] as string[], fingerprint: "a".repeat(16),
    sources: [...personal.map(({ manifest }) => ({ dictionary: manifest.dictionaries[0]!.slug, languages: ["en"], reveal: "show" as const })),
      { dictionary: "jmdict", languages: ["en"], reveal: "show" as const }],
  };
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.endsWith("/dictionary-packs")) {
      data.checks += 1;
      const body: DictionaryStackManifest = {
        dictionaryStack: { fingerprint: data.fingerprint, sources: data.sources },
        packs: [{ ...base.manifest, kind: "base" }, ...data.packs.map(({ manifest }) => ({ ...manifest, kind: "overlay" as const }))],
        pendingPacks: data.pending,
      };
      return Response.json(body, { status: data.pending.length ? 202 : 200, headers: { "Retry-After": data.retryAfter } });
    }
    if (url.endsWith("/current")) return Response.json(base.manifest);
    data.downloads.push(url);
    if (data.failed.has(url)) return new Response(null, { status: 503 });
    const found = [base, ...data.packs].find(({ manifest }) => manifest.downloadUrl === url);
    return found ? new Response(new Uint8Array(found.payload)) : new Response(null, { status: 404 });
  }) as typeof fetch;
  return data;
}

test("adding, removing, reordering and updating personal dictionaries reuse every unchanged pack", async (context) => {
  const data = await catalog(context, 10);
  const originalPut = IDBObjectStore.prototype.put;
  let writes: string[] = [];
  IDBObjectStore.prototype.put = function (value: unknown, key?: IDBValidKey) {
    if (this.name === "terms") writes.push((value as { dictionary: string }).dictionary);
    return originalPut.call(this, value, key);
  };
  context.after(async () => { IDBObjectStore.prototype.put = originalPut; });
  await installDictionary("https://api.test", "Bearer secret");
  assert.equal(data.downloads.length, 11);
  writes = [];
  data.downloads = [];
  data.packs.push(pack("added"));
  data.sources.unshift({ dictionary: "added", languages: ["en"], reveal: "show" });
  data.fingerprint = "b".repeat(16);
  await installDictionary("https://api.test", "Bearer secret");
  assert.deepEqual(data.downloads, ["https://packs.test/added-1.gz"], "adding one pack must not fetch ten unchanged dictionaries");

  assert.deepEqual(writes, ["added"], "unchanged dictionaries need no record writes either");
  writes = [];
  data.downloads = [];
  data.packs.reverse();
  data.sources.reverse();
  data.fingerprint = "c".repeat(16);
  await installDictionary("https://api.test", "Bearer secret");
  assert.deepEqual(data.downloads, [], "manifest ordering is not dictionary content");
  data.packs = data.packs.filter(({ manifest }) => manifest.dictionaries[0]!.slug !== "added");
  data.sources = data.sources.filter(({ dictionary }) => dictionary !== "added");
  await installDictionary("https://api.test", "Bearer secret");
  assert.deepEqual(data.downloads, [], "removal reuses surviving dictionaries");

  assert.deepEqual(writes, [], "reordering and removal perform no term imports");
  data.packs = data.packs.map((item) => item.manifest.dictionaries[0]!.slug === "personal-4" ? pack("personal-4", "2") : item);
  await installDictionary("https://api.test", "Bearer secret");
  assert.deepEqual(data.downloads, ["https://packs.test/personal-4-2.gz"]);
  assert.deepEqual(writes, ["personal-4"]);
});

test("a partial sync keeps working revisions and does not download completed packs again", async (context) => {
  const data = await catalog(context, 2);
  await installDictionary("https://api.test", "Bearer secret");
  data.packs = [pack("personal-0", "2"), pack("personal-1", "2")];
  data.fingerprint = "b".repeat(16);
  data.failed.add(data.packs[1]!.manifest.downloadUrl);
  data.downloads = [];
  await assert.rejects(installDictionary("https://api.test", "Bearer secret"), /503/);
  const current = await lookupOffline("猫", ["eng"], "https://api.test");
  assert.equal(current?.entry, "personal-0:cat");
  assert.ok(current?.senses.some((sense) => sense.glosses.some(({ text }) => text === "personal-1-1")), "failed dictionary retains its previous working version");
  assert.equal((await dictionaryStatus()).stackFingerprint, "", "partial activation cannot certify the old complete stack");
  data.failed.clear();
  disablePrivateDictionaryLookups();
  data.downloads = [];
  await installDictionary("https://api.test", "Bearer secret");
  assert.deepEqual(data.downloads, ["https://packs.test/personal-1-2.gz"], "the completed dictionary is reusable across retries");
});

test("pending exports remain visible and cannot be certified by local preferences", async (context) => {
  const data = await catalog(context, 1);
  await installDictionary("https://api.test", "Bearer secret");
  data.pending = ["building"];
  data.fingerprint = "b".repeat(16);
  data.sources.unshift({ dictionary: "building", languages: ["en"], reveal: "show" });
  await installDictionary("https://api.test", "Bearer secret");
  await setActiveDictionaryStack(data.sources.map(({ dictionary }) => `${dictionary}:en`), {}, {}, data.fingerprint);
  const status = await dictionaryStatus();
  assert.deepEqual(status.pendingPacks, ["building"]);
  assert.notEqual(status.stackFingerprint, data.fingerprint, "desired preferences do not prove that all content is installed");
  assert.ok(status.retryAt, "pending exports persist their next retry time");
});

test("a failed automatic check does not suppress a retry for a whole day", async (context) => {
  const data = await catalog(context, 1);
  await installDictionary("https://api.test", "Bearer secret");
  data.packs = [pack("personal-0", "2")];
  const url = data.packs[0]!.manifest.downloadUrl;
  data.failed.add(url);
  await assert.rejects(checkDictionaryUpdate("https://api.test", "Bearer secret"), /503/);
  const status = await dictionaryStatus();
  assert.equal(status.lastCheckedAt, null, "a failed check must not advance the successful-update timestamp");
  assert.ok(status.retryAt);
  const attempts = data.downloads.length;
  await checkDictionaryUpdate("https://api.test", "Bearer secret");
  assert.equal(data.downloads.length, attempts, "ordinary checks honor persisted backoff");
  const originalNow = Date.now;
  context.after(async () => { Date.now = originalNow; });
  const retryAt = Date.parse(status.retryAt);
  Date.now = () => retryAt + 1;
  data.failed.clear();
  await checkDictionaryUpdate("https://api.test", "Bearer secret");
  assert.equal(data.downloads.length, attempts + 1);
  assert.equal((await dictionaryStatus()).retryAt, null);
  assert.ok((await dictionaryStatus()).lastCheckedAt);
});

test("disabled personal dictionaries stay installed but indexed probes search only enabled dictionaries", async (context) => {
  const data = await catalog(context, 10);
  await installDictionary("https://api.test", "Bearer secret");
  await setActiveDictionaryStack(["personal-2:en", "jmdict:en"], {}, {}, data.fingerprint);
  const original = IDBIndex.prototype.getAll;
  const probes: string[] = [];
  IDBIndex.prototype.getAll = function (...args: Parameters<IDBIndex["getAll"]>) {
    if (this.name === "lookupKeys") probes.push(String(args[0] instanceof IDBKeyRange ? args[0].lower : args[0]));
    return original.apply(this, args);
  };
  context.after(async () => { IDBIndex.prototype.getAll = original; });
  const definition = await lookupOffline("猫", ["eng"], "https://api.test");
  assert.deepEqual(definition?.senses.flatMap((sense) => sense.glosses.map(({ text }) => text)), ["personal-2-1", "jmdict-1"]);
  assert.ok(probes.some((key) => key.includes("personal-2")), "enabled private dictionary uses its indexed generation");
  assert.ok(probes.some((key) => key.startsWith("jmdict-1\0")), "public dictionary participates in the same lookup");
  assert.ok(!probes.some((key) => key.includes("personal-0")), "disabled dictionaries do not need index queries");
  const coldRequests = probes.length;
  data.sources = data.sources.filter(({ dictionary }) => ["personal-2", "jmdict"].includes(dictionary));
  await installDictionary("https://api.test", "Bearer secret");
  await lookupOffline("猫", ["eng"], "https://api.test");
  assert.equal(probes.length, coldRequests, "warm probes reuse the bounded cache");
  data.downloads = [];
  await setActiveDictionaryStack(["personal-0:en", "jmdict:en"], {}, {}, data.fingerprint);
  assert.equal((await lookupOffline("猫", ["eng"], "https://api.test"))?.entry, "personal-0:cat");
  assert.deepEqual(data.downloads, [], "enabling cached dictionaries needs no download");
});


test("automatic checks install missing storage without waiting a day", async (context) => {
  const data = await catalog(context, 1);
  await checkDictionaryUpdate("https://api.test", "Bearer secret");
  assert.equal((await dictionaryStatus()).installed, true);
  assert.equal(data.downloads.length, 2);
});

test("a corrupt private pack leaves its old indexed records and the other dictionaries usable", async (context) => {
  const data = await catalog(context, 2);
  await installDictionary("https://api.test", "Bearer secret");
  const corrupt = pack("personal-0", "2");
  corrupt.manifest.sha256 = "0".repeat(64);
  data.packs[0] = corrupt;
  await assert.rejects(installDictionary("https://api.test", "Bearer secret"), /checksum/);
  const definition = await lookupOffline("猫", ["eng"], "https://api.test");
  assert.deepEqual(definition?.senses.flatMap((sense) => sense.glosses.map(({ text }) => text)), ["personal-0-1", "personal-1-1", "jmdict-1"]);
  const status = await dictionaryStatus();
  assert.equal(status.packs.find((pack) => pack.slug === "personal-0")?.state, "error");
  assert.equal(status.packs.find((pack) => pack.slug === "personal-1")?.state, "ready");
});

test("pending exports respect Retry-After and finish automatically using only the newly ready pack", async (context) => {
  const data = await catalog(context, 1);
  await installDictionary("https://api.test", "Bearer secret");
  data.pending = ["building"];
  data.retryAfter = "600";
  data.sources.unshift({ dictionary: "building", languages: ["en"], reveal: "show" });
  await installDictionary("https://api.test", "Bearer secret");
  const status = await dictionaryStatus();
  assert.ok(status.retryAt);
  assert.ok(Date.parse(status.retryAt) >= Date.now() + 590_000);
  assert.equal(status.packs.find((pack) => pack.slug === "building")?.state, "building");
  const originalNow = Date.now;
  context.after(async () => { Date.now = originalNow; });
  const now = Date.parse(status.retryAt) + 1;
  Date.now = () => now;
  data.pending = [];
  data.packs.push(pack("building"));
  data.downloads = [];
  await checkDictionaryUpdate("https://api.test", "Bearer secret");
  assert.deepEqual(data.downloads, ["https://packs.test/building-1.gz"]);
  assert.equal((await dictionaryStatus()).retryAt, null);
  assert.equal((await dictionaryStatus()).packs.find((pack) => pack.slug === "building")?.state, "ready");
});


test("signed-out startup cleanup retains public-download backoff across worker starts", async (context) => {
  const data = await catalog(context, 0);
  data.failed.add("https://packs.test/jmdict-1.gz");
  await assert.rejects(installDictionary("https://api.test"), /503/);
  const retryAt = (await dictionaryStatus()).retryAt;
  assert.ok(retryAt);
  await deactivatePrivateDictionaries();
  assert.equal((await dictionaryStatus()).retryAt, retryAt);
  const attempts = data.downloads.length;
  await checkDictionaryUpdate("https://api.test");
  assert.equal(data.downloads.length, attempts);
});


test("an interrupted sync bypasses a recent successful-check timestamp after restart", async (context) => {
  const data = await catalog(context, 1);
  await checkDictionaryUpdate("https://api.test", "Bearer secret");
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("shirabe-offline-dictionary-public-v1");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  const transaction = db.transaction("meta", "readwrite");
  const store = transaction.objectStore("meta");
  const request = store.get("syncState");
  request.onsuccess = () => store.put({ key: "syncState", value: { ...request.result.value, inProgress: true } });
  await new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error);
  });
  db.close();
  data.downloads = [];
  const checks = data.checks;
  await checkDictionaryUpdate("https://api.test", "Bearer secret");
  assert.equal(data.checks, checks + 1, "an unfinished attempt must not wait out the ordinary check interval");
  assert.deepEqual(data.downloads, [], "committed content survives the interrupted attempt");
});


test("revoked private records disappear even when a public update fails and old preferences are restored", async (context) => {
  const data = await catalog(context, 2);
  await installDictionary("https://api.test", "Bearer secret");
  data.packs = data.packs.filter(({ manifest }) => manifest.dictionaries[0]!.slug !== "personal-0");
  data.sources = data.sources.filter(({ dictionary }) => dictionary !== "personal-0");
  data.base.manifest.contentRevision = "jmdict-2";
  data.base.manifest.downloadUrl = "https://packs.test/jmdict-2.gz";
  data.failed.add(data.base.manifest.downloadUrl);
  await assert.rejects(installDictionary("https://api.test", "Bearer secret"), /503/);
  await setActiveDictionaryStack(["personal-0:en", "personal-1:en", "jmdict:en"], {}, {}, data.fingerprint);
  const definition = await lookupOffline("猫", ["eng"], "https://api.test");
  assert.deepEqual(definition?.senses.flatMap((sense) => sense.glosses.map(({ text }) => text)), ["personal-1-1", "jmdict-1"]);
});
