import assert from "node:assert/strict";
import test from "node:test";
import type { TelemetrySignal } from "../src/common/telemetry.js";

let granted = false;
let checks = 0;
let sends = 0;

Object.assign(globalThis, {
  browser: {
    permissions: {
      contains: async (request: { data_collection: string[] }) => {
        assert.deepEqual(request.data_collection, ["technicalAndInteraction"]);
        checks += 1;
        return granted;
      },
    },
    storage: { local: { get: async () => ({}), set: async () => {} } },
  },
  fetch: async () => { sends += 1; return { ok: true }; },
});

function report(ingestClientReport: (report: { context: "content"; signals: TelemetrySignal[] }) => void): void {
  const signals: TelemetrySignal[] = Array.from({ length: 20 }, (_, i) => ({
    kind: "event", name: `event_${i}`, context: "content", timestamp: Date.now(),
  }));
  ingestClientReport({ context: "content", signals });
}

test("Firefox sends error reports only with its optional data permission", async () => {
  const { ingestClientReport } = await import("../src/background/telemetry.js");
  report(ingestClientReport);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(checks, 1);
  assert.equal(sends, 0);

  granted = true;
  report(ingestClientReport);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(checks, 2);
  assert.equal(sends, 1);
});
