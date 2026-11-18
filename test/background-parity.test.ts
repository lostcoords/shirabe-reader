import "fake-indexeddb/auto";
import assert from "node:assert/strict";
import test from "node:test";
import type { Response as WorkerResponse } from "../src/common/messages.js";
import { stubBackground } from "./support/background.js";

test("background messages parse locally with stable offsets and entry identity during account refresh", async () => {
  const firefox = process.env.PARITY_MESSAGE_API === "firefox";
  const { storage, tabMessages, start } = stubBackground({ firefox, tabs: [{ id: 1 }] });
  const { packHeader, packPayload, term, testPackManifest } = await import("./support/pack.js");
  const { installDictionary } = await import("../src/common/offline-dictionary.js");
  const { DEFAULTS } = await import("../src/common/config.js");
  const publicPayload = packPayload([
    JSON.stringify(packHeader()),
    term("jmdict:banana", "バナナ", null, "バナナ", "jmdict:banana", true, "n"),
    term("jmdict:copula", "だ", null, "だ", "jmdict:copula", true, "cop"),
  ]);
  const privatePayload = packPayload([
    JSON.stringify(packHeader(["eng"])),
    term("yomitan-test:secret", "内緒", "内緒", "ないしょ", "yomitan-test:secret"),
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
    dictionaryStack: { fingerprint: "a".repeat(16), sources: [
      { dictionary: "yomitan-test", languages: ["en"], reveal: "show" },
      { dictionary: "jmdict", languages: ["en"], reveal: "show" },
    ] },
    packs: [{ ...publicManifest, kind: "base" }, { ...privateManifest, kind: "overlay" }], pendingPacks: [],
  };
  Object.assign(storage, { config: {
    ...DEFAULTS, apiBase: "https://api.test", accessToken: "access-token",
    accessTokenExpiresAt: "2999-01-01T00:00:00Z", refreshToken: "refresh-token",
    scopes: ["user:profile:read", "user:dictionary:read"], account: "Reader", accountCheckedAt: new Date().toISOString(),
    languages: ["eng"], dictionaryStack: ["yomitan-test:en", "jmdict:en"],
    dictionaryStackFingerprint: stack.dictionaryStack.fingerprint, errorReports: false,
  } });
  let disconnected = false;
  let revokeUnavailable = true;
  let onlineParses = 0;
  let parsePackRevision = publicManifest.contentRevision;
  const finishProfiles: Array<() => void> = [];
  let profileStarted!: () => void;
  const profileRequested = new Promise<void>((resolve) => { profileStarted = resolve; });
  globalThis.fetch = (async (input: unknown) => {
    const url = input instanceof Request ? input.url : String(input);
    if (["/api/v1/me", "/api/v1/dictionary-stack", "/api/v1/dictionaries"].some((path) => url.includes(path))) {
      profileStarted();
      return new Promise<Response>((resolve) => {
        finishProfiles.push(() => resolve(new Response(null, { status: 503 })));
      });
    }
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
      onlineParses += 1;
      return new Response(JSON.stringify({ stackFingerprint: stack.dictionaryStack.fingerprint,
        packRevision: parsePackRevision, sources: ["yomitan-test:en", "jmdict:en"],
        results: [
          { text: "ﾊﾞﾅﾅ。", tokens: [
            { startOffset: 0, endOffset: 4, surface: "ﾊﾞﾅﾅ", lemma: "バナナ", partOfSpeech: "noun", kind: "word" },
            { startOffset: 4, endOffset: 5, surface: "。", kind: "symbol" },
          ] },
          { text: "バナナ。", tokens: [
            { startOffset: 0, endOffset: 3, surface: "バナナ", lemma: "バナナ", partOfSpeech: "noun", kind: "word" },
            { startOffset: 3, endOffset: 4, surface: "。", kind: "symbol" },
          ] },
        ] }), { headers: { "Content-Type": "application/json" } });
    }
    if (url.endsWith("/public.gz")) return new Response(new Uint8Array(publicPayload));
    if (url.endsWith("/private.gz")) return new Response(new Uint8Array(privatePayload));
    return new Response(null, { status: 404 });
  }) as typeof fetch;
  await installDictionary("https://api.test", "Bearer access-token");
  const send = await start();
  await profileRequested;
  let parsed: WorkerResponse;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    parsed = await Promise.race([
      send({ type: "parseBatch", texts: ["ﾊﾞﾅﾅ。", "バナナ。"] }),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("Local parse waited for the account network request")), 500);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    finishProfiles.forEach((finish) => finish());
  }
  assert.ok(parsed.ok && parsed.type === "parseBatch");
  assert.equal(parsed.tokens[0][0].entry, "jmdict:banana");
  assert.equal(parsed.tokens[0][0].surface, "ﾊﾞﾅﾅ");
  assert.equal(parsed.tokens[0][1].start, 4);
  assert.equal(parsed.tokens[1][1].start, 3);
  assert.equal(onlineParses, 0);
  const marked = await send({ type: "parseBatchOnline", texts: ["ﾊﾞﾅﾅ。", "バナナ。"] });
  assert.ok(marked.ok && marked.type === "parseBatchOnline");
  assert.equal(marked.accepted, true);
  assert.equal(marked.tokens[0][0].entry, undefined, "the card finds its entry when it opens");
  assert.equal(onlineParses, 1);
  parsePackRevision = "older-pack";
  const stalePack = await send({ type: "parseBatchOnline", texts: ["バナナ。"] });
  assert.ok(stalePack.ok && stalePack.type === "parseBatchOnline");
  assert.equal(stalePack.accepted, true, "marks do not depend on the installed pack");
  const span = await send({ type: "lookupSpan", text: "バナナ。", startOffset: 0, endOffset: 3 });
  assert.ok(span.ok && span.type === "lookupSpan");
  assert.equal(span.definition?.entry, "jmdict:banana");
  const scan = await send({ type: "lookupScan", text: "バナナ。", offset: 1 });
  assert.ok(scan.ok && scan.type === "lookupScan");
  assert.equal(scan.startOffset, 0);
  assert.equal(scan.definition?.entry, "jmdict:banana");
  const parsedCard = await send({ type: "lookupParsed", surface: "バナナ", entry: "jmdict:banana",
    groups: [["jmdict:banana"]] });
  assert.ok(parsedCard.ok && parsedCard.type === "lookupParsed");
  assert.deepEqual(parsedCard.alternatives.map((definition) => definition.entry), ["jmdict:banana"]);
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
