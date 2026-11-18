import assert from "node:assert/strict";
import test from "node:test";
import type { TelemetrySignal } from "../src/common/telemetry.js";

// ── ingestClientReport ───────────────────────────────────────────────────────
// FLUSH_AT signals so the batch is POSTed synchronously with no timer left
// behind for the rest of the suite to trip over.
const FLUSH_AT = 20;

function signals(count: number): TelemetrySignal[] {
  return Array.from({ length: count }, (_, i) => ({
    kind: "event" as const, name: `e${i}`, context: "background" as const, timestamp: 0,
  }));
}

async function sentContexts(report: { context: unknown; signals: TelemetrySignal[] }): Promise<string[]> {
  Object.assign(globalThis, {
    chrome: globalThis.chrome ?? { storage: { local: { get: async () => ({}), set: async () => {} } } },
    __FARO_URL__: "https://o.test/collect",
    __TELEMETRY_ENV__: "development",
  });
  type Captured = { batch: Array<{ properties: { source: string } }> };
  let resolveSend: (payload: Captured) => void;
  const sent = new Promise<Captured>((resolve) => {
    resolveSend = resolve;
  });
  globalThis.fetch = (async (_url: string, init: { body: string }) => {
    resolveSend(JSON.parse(init.body));
    return { ok: true };
  }) as unknown as typeof fetch;

  const { ingestClientReport } = await import("../src/background/telemetry.js");
  ingestClientReport(report as never);
  // The PostHog capture shape: one batch of events, each carrying its source in
  // `properties`. This used to read the Faro payload's `events[].attributes`.
  return (await sent).batch.map((event) => event.properties.source);
}

test("a page claiming 'background' is re-stamped as content, never the privileged worker", async () => {
  const sources = await sentContexts({ context: "background", signals: signals(FLUSH_AT) });
  assert.equal(sources.length, FLUSH_AT);
  assert.ok(sources.every((source) => source === "content"), `expected all content, got ${[...new Set(sources)].join(", ")}`);
});

test("a genuine client context is kept, and junk falls back to content", async () => {
  assert.equal((await sentContexts({ context: "popup", signals: signals(FLUSH_AT) }))[0], "popup");
  assert.equal((await sentContexts({ context: "options", signals: signals(FLUSH_AT) }))[0], "options");
  assert.equal((await sentContexts({ context: { toString: () => "popup" }, signals: signals(FLUSH_AT) }))[0], "content");
});
