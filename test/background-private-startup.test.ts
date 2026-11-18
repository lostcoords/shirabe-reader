import "fake-indexeddb/auto";
import assert from "node:assert/strict";
import test from "node:test";
import { stubBackground } from "./support/background.js";

test("an anonymous background start purges an orphaned private dictionary before lookup", async () => {
  const background = stubBackground();
  const { packHeader, packPayload, term, testPackManifest } = await import("./support/pack.js");
  const { installDictionary, setActiveDictionaryStack } = await import("../src/common/offline-dictionary.js");
  const { DEFAULTS } = await import("../src/common/config.js");
  const publicPayload = packPayload([
    JSON.stringify(packHeader(["eng"])),
    term("jmdict:public", "公開", null, "公開", "jmdict:public"),
  ]);
  const privatePayload = packPayload([
    JSON.stringify(packHeader(["eng"])),
    term("yomitan-test:private", "秘密", null, "秘密", "yomitan-test:private"),
  ]);
  const publicManifest = testPackManifest(publicPayload, { contentRevision: "startup-public", terms: 1 }, {
    downloadUrl: "https://packs.test/public.gz",
  });
  const privateManifest = testPackManifest(privatePayload, { contentRevision: "startup-private", terms: 1 }, {
    artifact: "private.ndjson.gz", dictionaries: [{ slug: "yomitan-test", version: "1" }],
    downloadUrl: "https://packs.test/private.gz",
  });
  const stack = {
    dictionaryStack: { fingerprint: "b".repeat(16), sources: [
      { dictionary: "yomitan-test", languages: ["en"], reveal: "show" },
      { dictionary: "jmdict", languages: ["en"], reveal: "show" },
    ] },
    packs: [{ ...publicManifest, kind: "base" }, { ...privateManifest, kind: "overlay" }], pendingPacks: [],
  };
  globalThis.fetch = (async (input: unknown) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.endsWith("/api/v1/dictionary-packs")) {
      return new Response(JSON.stringify(stack), { headers: { "Content-Type": "application/json" } });
    }
    if (url.endsWith("/public.gz")) return new Response(new Uint8Array(publicPayload));
    if (url.endsWith("/private.gz")) return new Response(new Uint8Array(privatePayload));
    return new Promise<Response>((resolve) => setTimeout(() => resolve(new Response(JSON.stringify(publicManifest), {
      headers: { "Content-Type": "application/json" },
    })), 100));
  }) as typeof fetch;
  await installDictionary("https://api.test", "Bearer access-token");
  await setActiveDictionaryStack(["yomitan-test:en"], {}, {}, "b".repeat(16));
  Object.assign(background.storage, { config: { ...DEFAULTS, apiBase: "https://api.test", errorReports: false } });

  const send = await background.start();
  const privateLookup = await send({ type: "lookup", query: "秘密" });
  assert.ok(privateLookup.ok && privateLookup.type === "lookup");
  assert.equal(privateLookup.definition, null);
  const publicLookup = await send({ type: "lookup", query: "公開" });
  assert.ok(publicLookup.ok && publicLookup.type === "lookup");
  assert.equal(publicLookup.definition?.entry, "jmdict:public");
  assert.deepEqual((await indexedDB.databases()).map(({ name }) => name), ["shirabe-offline-dictionary-public-v1"]);
});
