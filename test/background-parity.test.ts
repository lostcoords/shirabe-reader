import "fake-indexeddb/auto";
import assert from "node:assert/strict";
import test from "node:test";
import type { Request, Response as WorkerResponse } from "../src/common/messages.js";

test("background messages preserve online parse offsets and picked entry identity", async () => {
  const firefox = process.env.PARITY_MESSAGE_API === "firefox";
  let listener: (request: Request, sender: object, respond: (response: WorkerResponse) => void) => unknown;
  const storage: Record<string, unknown> = {};
  const tabMessages: unknown[] = [];
  const event = { addListener() {} };
  Object.assign(globalThis, {
    self: { addEventListener() {} },
    chrome: {
      runtime: {
        onMessage: { addListener(callback: typeof listener) { listener = callback; } },
        onConnect: event, onInstalled: event, getURL: (path: string) => path,
      },
      storage: {
        local: {
          get: async () => storage,
          set: async (values: Record<string, unknown>) => { Object.assign(storage, values); },
          remove: async () => {},
        },
        onChanged: event,
      },
      tabs: { onRemoved: event, query: async () => [{ id: 1 }], sendMessage: async (_tabId: number, message: unknown) => { tabMessages.push(message); } },
      scripting: { unregisterContentScripts: async () => {} },
      permissions: { contains: async () => false },
    },
  });
  if (firefox) Object.assign(globalThis, { browser: globalThis.chrome });
  const { packPayload, testPackManifest } = await import("./support/pack.js");
  const { installDictionary } = await import("../src/common/offline-dictionary.js");
  const { DEFAULTS } = await import("../src/common/config.js");
  const term = (id: string, writing: string, reading: string, pos: string, dictionary = "jmdict") => JSON.stringify({
    type: "term", id, dictionary, headword: writing,
    expressions: [{ text: writing, script: "kana", common: true, tags: [] }],
    readings: [{ text: reading, kind: "kana" }],
    senses: [{ glosses: { eng: [id] }, partsOfSpeech: [pos], fields: [], misc: [], dialects: [], restrictions: [] }],
  });
  const publicPayload = packPayload([
    JSON.stringify({ type: "header", schemaVersion: 7, languages: ["eng", "spa"], source: "Background parity" }),
    term("jmdict:banana", "バナナ", "バナナ", "n"),
    term("jmdict:copula", "だ", "だ", "cop"),
  ]);
  const privatePayload = packPayload([
    JSON.stringify({ type: "header", schemaVersion: 7, languages: ["eng"], source: "Private test dictionary" }),
    term("yomitan-test:secret", "内緒", "ないしょ", "n", "yomitan-test"),
  ]);
  const publicManifest = testPackManifest(publicPayload, { contentRevision: "background-public", terms: 2 }, {
    downloadUrl: "https://packs.test/public.gz",
  });
  const privateManifest = testPackManifest(privatePayload, { contentRevision: "background-private", terms: 1 }, {
    artifact: "private.ndjson.gz", languages: ["eng"],
    dictionaries: [{ slug: "yomitan-test", version: "1" }],
    downloadUrl: "https://packs.test/private.gz",
  });
  const stack = {
    stackFingerprint: "a".repeat(16), dictionaries: ["yomitan-test:en", "jmdict:en"],
    dictionaryReveal: {}, dictionaryNames: { "yomitan-test": "Private test dictionary" },
    publicPack: publicManifest, personalPacks: [privateManifest],
  };
  Object.assign(storage, { config: {
    ...DEFAULTS, apiBase: "https://api.test", accessToken: "access-token",
    accessTokenExpiresAt: "2999-01-01T00:00:00Z", refreshToken: "refresh-token",
    scopes: ["READ_ACCOUNT", "READ_DICTIONARY"], account: "Reader", accountCheckedAt: new Date().toISOString(),
    languages: ["eng"], dictionaryStack: stack.dictionaries,
    dictionaryStackFingerprint: stack.stackFingerprint, errorReports: false,
  } });
  let disconnected = false;
  let revokeUnavailable = true;
  globalThis.fetch = (async (input: unknown) => {
    const url = String(input);
    if (url.endsWith("/api/v1/oauth/revoke")) {
      if (revokeUnavailable) {
        revokeUnavailable = false;
        return new Response(JSON.stringify({ detail: "offline" }), { status: 503, headers: { "Content-Type": "application/json" } });
      }
      disconnected = true;
      return new Response(null, { status: 204 });
    }
    if (url.endsWith("/api/v1/dictionary-packs")) {
      return new Response(JSON.stringify(stack), { headers: { "Content-Type": "application/json" } });
    }
    if (url.endsWith("/api/v1/dictionary-packs/current")) {
      return disconnected
        ? new Response(JSON.stringify({ detail: "offline" }), { status: 503, headers: { "Content-Type": "application/json" } })
        : new Response(JSON.stringify(publicManifest), { headers: { "Content-Type": "application/json" } });
    }
    if (url.endsWith("/api/v1/parse")) {
      return new Response(JSON.stringify({ tokens: [
        [
          { position: 0, length: 4, surface: "ﾊﾞﾅﾅ", lemma: "バナナ", pos: "noun", kind: "word",
            entry: { dictionary: "jmdict", sourceId: "banana" }, state: "none" },
          { position: 4, length: 1, surface: "。", lemma: "。", pos: null, kind: "symbol" },
        ],
        [
          { position: 0, length: 3, surface: "バナナ", lemma: "バナナ", pos: "noun", kind: "word",
            entry: { dictionary: "jmdict", sourceId: "banana" }, state: "none" },
          { position: 3, length: 1, surface: "。", lemma: "。", pos: null, kind: "symbol" },
        ],
      ] }));
    }
    if (url.endsWith("/public.gz")) return new Response(new Uint8Array(publicPayload));
    if (url.endsWith("/private.gz")) return new Response(new Uint8Array(privatePayload));
    return new Response(null, { status: 404 });
  }) as typeof fetch;
  await installDictionary("https://api.test", "Bearer access-token");
  await import("../src/background/background.js");
  const send = (request: Request) => new Promise<WorkerResponse>((resolve) => {
    const result = listener(request, {}, resolve);
    if (firefox) {
      assert.ok(result instanceof Promise);
      void result.then(resolve);
    } else {
      assert.equal(result, true);
    }
  });
  const parsed = await send({ type: "parseBatch", texts: ["ﾊﾞﾅﾅ。", "バナナ。"] });
  assert.ok(parsed.ok && parsed.type === "parseBatch");
  assert.equal(parsed.tokens[0][0].entry, "jmdict:banana");
  assert.equal(parsed.tokens[0][0].surface, "ﾊﾞﾅﾅ");
  assert.equal(parsed.tokens[0][1].start, 4);
  assert.equal(parsed.tokens[1][1].start, 3);
  const romaji = await send({ type: "lookup", query: "banana" });
  assert.ok(romaji.ok && romaji.type === "lookup");
  assert.equal(romaji.definition?.entry, "jmdict:banana");
  const picked = await send({ type: "lookupEntry", entry: "jmdict:copula", surface: "だった" });
  assert.ok(picked.ok && picked.type === "lookupEntry");
  assert.equal(picked.definition?.entry, "jmdict:copula");
  assert.equal(picked.definition?.baseForm, "だ");
  assert.deepEqual(picked.definition?.inflection, ["past"]);
  const missing = await send({ type: "lookupEntry", entry: "jmdict:missing", surface: "バナナ" });
  assert.ok(!missing.ok);
  assert.equal(missing.code, "OFFLINE_LOOKUP_UNAVAILABLE");

  const privateLookup = await send({ type: "lookup", query: "内緒" });
  assert.ok(privateLookup.ok && privateLookup.type === "lookup");
  assert.equal(privateLookup.definition?.entry, "yomitan-test:secret");

  const deleteDatabase = indexedDB.deleteDatabase.bind(indexedDB);
  Object.defineProperty(indexedDB, "deleteDatabase", {
    configurable: true,
    value(name: string) {
      if (name !== "shirabe-offline-dictionary-private-v1") return deleteDatabase(name);
      const request = {} as IDBOpenDBRequest;
      queueMicrotask(() => request.onblocked?.(new Event("blocked") as IDBVersionChangeEvent));
      return request;
    },
  });
  const blockedDisconnect = await send({ type: "disconnect" });
  assert.ok(!blockedDisconnect.ok);
  const storedConfig = storage.config as { accessToken: string; refreshToken: string; scopes: string[] };
  assert.equal(storedConfig.accessToken, "");
  assert.equal(storedConfig.refreshToken, "");
  assert.deepEqual(storedConfig.scopes, []);
  const privateAfterBlockedDelete = await send({ type: "lookup", query: "内緒" });
  assert.ok(privateAfterBlockedDelete.ok && privateAfterBlockedDelete.type === "lookup");
  assert.equal(privateAfterBlockedDelete.definition, null);
  Object.defineProperty(indexedDB, "deleteDatabase", { configurable: true, value: deleteDatabase });

  tabMessages.length = 0;
  const disconnectedResponse = await send({ type: "disconnect" });
  assert.ok(disconnectedResponse.ok && disconnectedResponse.type === "disconnect");
  assert.ok(tabMessages.some((message) => (message as { command?: string }).command === "dictionaryChanged"),
    "disconnect notifies open pages even when the public-pack refresh fails");
  const privateAfterDisconnect = await send({ type: "lookup", query: "内緒" });
  assert.ok(privateAfterDisconnect.ok && privateAfterDisconnect.type === "lookup");
  assert.equal(privateAfterDisconnect.definition, null);
  const publicAfterDisconnect = await send({ type: "lookup", query: "バナナ" });
  assert.ok(publicAfterDisconnect.ok && publicAfterDisconnect.type === "lookup");
  assert.equal(publicAfterDisconnect.definition?.entry, "jmdict:banana");
});
