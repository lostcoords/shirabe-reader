import "fake-indexeddb/auto";
import assert from "node:assert/strict";
import test from "node:test";
import type { Request as WorkerRequest, Response as WorkerResponse } from "../src/common/messages.js";

test("dictionary installation reports late failures once and ignores late cancellation", async (context) => {
  let listener!: (request: WorkerRequest, sender: object, respond: (response: WorkerResponse) => void) => unknown;
  const storage: Record<string, unknown> = {};
  const event = { addListener() {} };
  Object.assign(globalThis, {
    self: { addEventListener() {} },
    chrome: {
      runtime: { onMessage: { addListener(callback: typeof listener) { listener = callback; } }, onConnect: event, onInstalled: event, getURL: (path: string) => path },
      storage: { local: { get: async () => storage, set: async (values: Record<string, unknown>) => { Object.assign(storage, values); }, remove: async (keys: string | string[]) => { for (const key of [keys].flat()) delete storage[key]; } }, onChanged: event },
      tabs: { onRemoved: event, query: async () => [], sendMessage: async () => {} },
      scripting: { unregisterContentScripts: async () => {} }, permissions: { contains: async () => true },
    },
  });
  const { DEFAULTS } = await import("../src/common/config.js");
  storage.config = { ...DEFAULTS, apiBase: "https://api.test", errorReports: true };
  type CapturedEvent = { event: string; properties: Record<string, unknown> };
  const batches: CapturedEvent[][] = [];
  let rejectDownload!: (error: Error) => void;
  let started!: () => void;
  let downloadStarted!: Promise<void>;
  let download!: Promise<Response>;
  const beginDownload = () => {
    downloadStarted = new Promise<void>((resolve) => { started = resolve; });
    download = new Promise<Response>((_resolve, reject) => { rejectDownload = reject; });
  };
  beginDownload();
  const originalFetch = globalThis.fetch;
  const originalError = console.error;
  console.error = () => {};
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.includes("/api/v1/dictionary-packs")) {
      const signal = input instanceof Request ? input.signal : init?.signal;
      signal?.addEventListener("abort", () => rejectDownload(new DOMException("Cancelled", "AbortError")), { once: true });
      started();
      return download;
    }
    if (url === "https://posthog.test/batch/") {
      batches.push(JSON.parse(String(init?.body)).batch);
      return new Response(null, { status: 200 });
    }
    return new Response(null, { status: 404 });
  }) as typeof fetch;
  const { captureEvent, setTelemetryEnabled } = await import("../src/background/telemetry.js");
  context.after(async () => {
    setTelemetryEnabled(false);
    const { removeDictionary } = await import("../src/common/offline-dictionary.js");
    await removeDictionary();
    globalThis.fetch = originalFetch;
    console.error = originalError;
  });
  await import("../src/background/background.js");
  const send = (request: WorkerRequest) => new Promise<WorkerResponse>((resolve) => { listener(request, {}, resolve); });
  const settled = async (predicate: () => Promise<boolean>) => {
    for (let attempt = 0; attempt < 500; attempt += 1) {
      if (await predicate()) return;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    assert.fail("background install reporting did not settle");
  };
  const report = async () => {
    await settled(async () => {
      const status = await send({ type: "dictionaryStatus" });
      return status.ok && status.type === "dictionaryStatus" && !status.dictionary.installing;
    });
    for (let index = 0; index < 20; index += 1) captureEvent("flush-test");
    await settled(async () => batches.length > 0);
    setTelemetryEnabled(false);
    const events = batches.splice(0).flat();
    return {
      failures: events.filter((entry) => entry.event === "dictionary_install_failed"),
      exceptions: events.filter((entry) => entry.event === "$exception"),
    };
  };

  await context.test("failure after the successful channel reply is reported exactly once", async () => {
    const response = await send({ type: "installDictionary" });
    assert.ok(response.ok && response.type === "installDictionary");
    await downloadStarted;
    rejectDownload(new Error("Download failed after the popup replied"));
    const events = await report();
    assert.equal(events.failures.length, 1);
    assert.equal(events.failures[0].properties.request, "installDictionary");
    assert.equal(events.exceptions.length, 1);
  });

  await context.test("failure before the channel reply is not counted twice", async () => {
    beginDownload();
    setTelemetryEnabled(true);
    const response = send({ type: "installDictionary" });
    await downloadStarted;
    rejectDownload(new Error("Download failed before the popup replied"));
    assert.equal((await response).ok, false);
    const events = await report();
    assert.equal(events.failures.length, 1);
    assert.equal(events.exceptions.length, 1);
  });

  await context.test("an aborted install after the reply is not an error report", async () => {
    beginDownload();
    setTelemetryEnabled(true);
    const response = await send({ type: "installDictionary" });
    assert.ok(response.ok && response.type === "installDictionary");
    await downloadStarted;
    const cancelled = await send({ type: "cancelDictionaryInstall" });
    assert.ok(cancelled.ok && cancelled.type === "cancelDictionaryInstall");
    const events = await report();
    assert.equal(events.failures.length, 0);
    assert.equal(events.exceptions.length, 0);
  });
});
