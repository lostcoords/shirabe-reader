import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { TelemetrySignal } from "../src/common/telemetry.js";

// The background worker can't be imported here: it registers listeners and
// installs global crash handlers on import. So the two worker-only invariants
// below are asserted against its source, the way telemetry.test.ts does.

test("a definition comes from the pack alone, so the cache key carries no connection state", () => {
  const background = readFileSync("src/background/background.ts", "utf8");
  const key = background.match(/lookupCache\.fetch\(`([^`]+)`/)?.[1];
  assert.ok(key, "expected a template-literal lookup cache key");
  // Signing in cannot change what a word means, so it must not fork the cache.
  // And nothing in the lookup path may reach the network for a definition.
  assert.doesNotMatch(key, /scope|connected|online/i);
  const handler = background.slice(background.indexOf('case "lookup"'), background.indexOf('case "dictionaryStatus"'));
  assert.doesNotMatch(handler, /api\./, "the pack is the dictionary; there is no server fallback to drift from");
});

test("a cached word state from an older build still renders, deck list or not", () => {
  const background = readFileSync("src/background/background.ts", "utf8");
  const pick = background.slice(background.indexOf("function pickDetails"), background.indexOf("// ── Redirect login"));
  // `decks` shipped as `memberships`; a snapshot from then has no `decks` at
  // all, and the reader calls `.map` on it the moment a popup opens.
  assert.match(pick, /decks: details\[lemma\]\.decks \?\? \[\]/);
});

test("a dictionary install reports its own failure, not just the ones the caller waits for", () => {
  const background = readFileSync("src/background/background.ts", "utf8");
  const install = background.slice(background.indexOf('case "installDictionary"'), background.indexOf('case "removeDictionary"'));
  // The rejection handler must hang off the install promise itself: the 150ms
  // race has already answered by the time a real download fails.
  assert.match(install, /captureEvent\("dictionary_install_failed"/);
  assert.match(install, /captureException\(error, "background", \{ request: "installDictionary" \}\)/);
  // A swallowing catch would put the counter right back to sleep.
  assert.doesNotMatch(install, /catch\(\(\) => undefined\)/);
});

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
  let resolveSend: (payload: { events: Array<{ attributes: { source: string } }> }) => void;
  const sent = new Promise<{ events: Array<{ attributes: { source: string } }> }>((resolve) => {
    resolveSend = resolve;
  });
  globalThis.fetch = (async (_url: string, init: { body: string }) => {
    resolveSend(JSON.parse(init.body));
    return { ok: true };
  }) as unknown as typeof fetch;

  const { ingestClientReport } = await import("../src/background/telemetry.js");
  ingestClientReport(report as never);
  return (await sent).events.map((event) => event.attributes.source);
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
