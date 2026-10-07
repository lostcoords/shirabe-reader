import "fake-indexeddb/auto";
import assert from "node:assert/strict";
import test from "node:test";
import type { Request as WorkerRequest, Response as WorkerResponse } from "../src/common/messages.js";
import { packPayload, testPackManifest } from "./support/pack.js";

test("browser alarms recover pending exports without an open popup, and disconnect clears private sync state", async (context) => {
  let listener!: (request: WorkerRequest, sender: object, respond: (response: WorkerResponse) => void) => unknown;
  let alarmListener!: (alarm: { name: string }) => void;
  const storage: Record<string, unknown> = {};
  const alarms = new Map<string, { scheduledTime: number; periodInMinutes?: number }>();
  const event = { addListener() {} };
  Object.assign(globalThis, {
    self: { addEventListener() {} },
    chrome: {
      runtime: { onMessage: { addListener(callback: typeof listener) { listener = callback; } }, onConnect: event, onInstalled: event, getURL: (path: string) => path },
      storage: { local: { get: async () => storage, set: async (values: Record<string, unknown>) => { Object.assign(storage, values); }, remove: async (keys: string | string[]) => { for (const key of [keys].flat()) delete storage[key]; } }, onChanged: event },
      tabs: { onRemoved: event, query: async () => [], sendMessage: async () => {} },
      scripting: { unregisterContentScripts: async () => {} }, permissions: { contains: async () => false },
      alarms: {
        create: async (name: string, info: { when?: number; periodInMinutes?: number }) => { alarms.set(name, { scheduledTime: info.when ?? Date.now() + (info.periodInMinutes ?? 0) * 60_000, periodInMinutes: info.periodInMinutes }); },
        get: async (name: string) => alarms.get(name), clear: async (name: string) => alarms.delete(name),
        onAlarm: { addListener(callback: typeof alarmListener) { alarmListener = callback; } },
      },
    },
  });
  const { DEFAULTS } = await import("../src/common/config.js");
  Object.assign(storage, { config: { ...DEFAULTS, apiBase: "https://api.test", accessToken: "token", refreshToken: "refresh",
    accessTokenExpiresAt: "2999-01-01T00:00:00Z", scopes: ["user:profile:read", "user:dictionary:read"], errorReports: false } });
  const makePack = (slug: string) => {
    const payload = packPayload([
      JSON.stringify({ type: "header", schemaVersion: 7, languages: ["eng"], source: slug }),
      JSON.stringify({ type: "term", id: `${slug}:1`, dictionary: slug, headword: "猫", expressions: [{ text: "猫", script: "kanji", common: true, tags: [] }],
        readings: [{ text: "ねこ", kind: "kana" }], senses: [{ glosses: { eng: [slug] }, partsOfSpeech: ["n"], fields: [], misc: [], dialects: [], restrictions: [] }] }),
    ]);
    return { payload, manifest: testPackManifest(payload, { contentRevision: slug, terms: 1 }, { dictionaries: [{ slug }], downloadUrl: `https://packs.test/${slug}.gz` }) };
  };
  const base = makePack("jmdict");
  const privatePack = makePack("personal");
  let pending = true;
  let privateDownloads = 0;
  const sources = [{ dictionary: "personal", languages: ["en"], reveal: "show" }, { dictionary: "jmdict", languages: ["en"], reveal: "show" }];
  const originalFetch = globalThis.fetch;
  const originalNow = Date.now;
  context.after(async () => { const { removeDictionary } = await import("../src/common/offline-dictionary.js"); await removeDictionary(); globalThis.fetch = originalFetch; Date.now = originalNow; });
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.endsWith("/me")) return Response.json({ user: { name: "Reader", displayName: "Reader" }, entitlement: { srs: true } });
    if (url.endsWith("/dictionary-stack")) return Response.json({ dictionaryStack: { fingerprint: "a".repeat(16), sources } });
    if (url.endsWith("/dictionaries")) return Response.json({ dictionaries: [{ slug: "personal", name: "Personal", kind: "definition", languages: ["en"] }] });
    if (url.endsWith("/dictionary-packs")) return Response.json({ dictionaryStack: { fingerprint: "a".repeat(16), sources },
      packs: [{ ...base.manifest, kind: "base" }, ...(pending ? [] : [{ ...privatePack.manifest, kind: "overlay" }])], pendingPacks: pending ? ["personal"] : [] },
      { status: pending ? 202 : 200, headers: { "Retry-After": "5" } });
    if (url.endsWith("/current")) return Response.json(base.manifest);
    if (url.endsWith("/revoke")) return new Response(null, { status: 204 });
    if (url.endsWith("/personal.gz")) { privateDownloads += 1; return new Response(new Uint8Array(privatePack.payload)); }
    if (url.endsWith("/jmdict.gz")) return new Response(new Uint8Array(base.payload));
    return new Response(null, { status: 404 });
  }) as typeof fetch;
  await import("../src/background/background.js");
  const send = (request: WorkerRequest) => new Promise<WorkerResponse>((resolve) => { listener(request, {}, resolve); });
  const settled = async (predicate: () => Promise<boolean>) => {
    for (let attempt = 0; attempt < 500; attempt += 1) {
      if (await predicate()) return;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    assert.fail("background sync did not reach the expected state");
  };
  await settled(async () => {
    const status = await send({ type: "dictionaryStatus" });
    return status.ok && status.type === "dictionaryStatus" && status.dictionary.pendingPacks.includes("personal") && !status.dictionary.installing &&
      (alarms.get("shirabe-dictionary-sync")?.scheduledTime ?? Infinity) <= originalNow() + 65_000;
  });
  assert.equal(typeof alarmListener, "function", "the worker registers a persistent retry event");
  const scheduled = alarms.get("shirabe-dictionary-sync")!;
  assert.ok(scheduled.scheduledTime <= originalNow() + 65_000, "pending exports get a near-term alarm, not tomorrow's check");
  pending = false;
  Date.now = () => originalNow() + 65_000;
  alarms.delete("shirabe-dictionary-sync");
  alarmListener({ name: "shirabe-dictionary-sync" });
  await settled(async () => {
    const status = await send({ type: "dictionaryStatus" });
    return status.ok && status.type === "dictionaryStatus" && !status.dictionary.installing && status.dictionary.packs.some((pack) => pack.slug === "personal" && pack.state === "ready");
  });
  assert.equal(privateDownloads, 1);
  const disconnected = await send({ type: "disconnect" });
  assert.equal(disconnected.ok, true);
  await settled(async () => {
    const status = await send({ type: "dictionaryStatus" });
    return status.ok && status.type === "dictionaryStatus" && !status.dictionary.installing;
  });
  const status = await send({ type: "dictionaryStatus" });
  assert.ok(status.ok && status.type === "dictionaryStatus");
  assert.equal(status.dictionary.pendingPacks.length, 0);
  assert.ok(status.dictionary.packs.every((pack) => pack.slug !== "personal"));
});
