import "fake-indexeddb/auto";
import assert from "node:assert/strict";
import test from "node:test";
import type { Request, Response as WorkerResponse } from "../src/common/messages.js";

test("an anonymous background start purges an orphaned private dictionary before lookup", async () => {
  let listener: (request: Request, sender: object, respond: (response: WorkerResponse) => void) => unknown;
  const storage: Record<string, unknown> = {};
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
      tabs: { onRemoved: event, query: async () => [], sendMessage: async () => {} },
      scripting: { unregisterContentScripts: async () => {} },
      permissions: { contains: async () => false },
    },
  });

  const { packPayload, testPackManifest } = await import("./support/pack.js");
  const { installDictionary } = await import("../src/common/offline-dictionary.js");
  const { DEFAULTS } = await import("../src/common/config.js");
  const term = (id: string, writing: string, dictionary: string) => JSON.stringify({
    type: "term", id, dictionary, headword: writing,
    expressions: [{ text: writing, script: "kana", common: true, tags: [] }],
    readings: [{ text: writing, kind: "kana" }],
    senses: [{ glosses: { eng: [id] }, partsOfSpeech: ["n"], fields: [], misc: [], dialects: [], restrictions: [] }],
  });
  const publicPayload = packPayload([
    JSON.stringify({ type: "header", schemaVersion: 7, languages: ["eng"], source: "Startup test" }),
    term("jmdict:public", "公開", "jmdict"),
  ]);
  const privatePayload = packPayload([
    JSON.stringify({ type: "header", schemaVersion: 7, languages: ["eng"], source: "Private startup test" }),
    term("yomitan-test:private", "秘密", "yomitan-test"),
  ]);
  const publicManifest = testPackManifest(publicPayload, { contentRevision: "startup-public", terms: 1 }, {
    downloadUrl: "https://packs.test/public.gz",
  });
  const privateManifest = testPackManifest(privatePayload, { contentRevision: "startup-private", terms: 1 }, {
    artifact: "private.ndjson.gz", dictionaries: [{ slug: "yomitan-test", version: "1" }],
    downloadUrl: "https://packs.test/private.gz",
  });
  const stack = {
    stackFingerprint: "b".repeat(16), dictionaries: ["yomitan-test:eng", "jmdict:eng"],
    dictionaryReveal: {}, dictionaryNames: { "yomitan-test": "Private startup test" },
    publicPack: publicManifest, personalPacks: [privateManifest],
  };
  globalThis.fetch = (async (input: unknown) => {
    const url = String(input);
    if (url.endsWith("/api/v1/dictionary-packs/stack")) {
      return new Response(JSON.stringify(stack), { headers: { "Content-Type": "application/json" } });
    }
    if (url.endsWith("/public.gz")) return new Response(new Uint8Array(publicPayload));
    if (url.endsWith("/private.gz")) return new Response(new Uint8Array(privatePayload));
    return new Promise<Response>((resolve) => setTimeout(() => resolve(new Response(JSON.stringify(publicManifest), {
      headers: { "Content-Type": "application/json" },
    })), 100));
  }) as typeof fetch;
  await installDictionary("https://api.test", "Bearer access-token");
  Object.assign(storage, { config: { ...DEFAULTS, apiBase: "https://api.test", errorReports: false } });

  await import("../src/background/background.js");
  const send = (request: Request) => new Promise<WorkerResponse>((resolve) => {
    assert.equal(listener(request, {}, resolve), true);
  });
  const privateLookup = await send({ type: "lookup", query: "秘密" });
  assert.ok(privateLookup.ok && privateLookup.type === "lookup");
  assert.equal(privateLookup.definition, null);
  const publicLookup = await send({ type: "lookup", query: "公開" });
  assert.ok(publicLookup.ok && publicLookup.type === "lookup");
  assert.equal(publicLookup.definition?.entry, "jmdict:public");
  assert.deepEqual((await indexedDB.databases()).map(({ name }) => name), ["shirabe-offline-dictionary-public-v1"]);
});
