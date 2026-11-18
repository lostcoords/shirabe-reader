import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import { join } from "node:path";
import { bundleTests } from "./support/bundle.mjs";

// Every suite runs in its own process, all at once. A suite that installs a
// dictionary pack owns the offline-dictionary module singleton and its
// fake-indexeddb, so sharing a process means tearing a database down under
// another suite's pending transactions.
//
// Segmentation runs as shards: fake-indexeddb never forgets a finished
// transaction, so one process running the whole corpus slows quadratically.
const SEGMENTATION_SHARDS = 8;

const suites = [
  ...Array.from({ length: SEGMENTATION_SHARDS }, (_, shard) => ({
    name: "segmentation.test.ts", entry: "test/segmentation.test.ts", env: { SEGMENTATION_SHARD: `${shard}/${SEGMENTATION_SHARDS}` },
  })),
  { name: "all.test.ts", entry: "test/all.test.ts" },
  { name: "watch-build.test.mjs", file: "test/watch-build.test.mjs" },
  { name: "development-reload-server.test.mjs", file: "test/development-reload-server.test.mjs" },
  { name: "click-positions.test.ts", entry: "test/click-positions.test.ts" },
  { name: "background-dictionary-sync.test.ts", entry: "test/background-dictionary-sync.test.ts" },
  { name: "background-install-reporting.test.ts", entry: "test/background-install-reporting.test.ts" },
  { name: "dictionary-panel.test.ts", entry: "test/dictionary-panel.test.ts" },
  { name: "dictionary-sync.test.ts", entry: "test/dictionary-sync.test.ts" },
  { name: "development-build.test.ts", entry: "test/development-build.test.ts" },
  { name: "telemetry-permission.test.ts", entry: "test/telemetry-permission.test.ts" },
  { name: "background-parity.test.ts", entry: "test/background-parity.test.ts" },
  { name: "background-parity.test.ts", entry: "test/background-parity.test.ts", env: { PARITY_MESSAGE_API: "firefox" } },
  { name: "background-private-startup.test.ts", entry: "test/background-private-startup.test.ts" },
  { name: "background-writes.test.ts", entry: "test/background-writes.test.ts" },
  { name: "content-shortcuts.test.ts", entry: "test/content-shortcuts.test.ts" },
];

const requested = process.argv.slice(2);
if (requested.some((name) => !suites.some((suite) => suite.name === name))) throw new Error("Unknown extension test suite");
const selected = requested.length ? suites.filter((suite) => requested.includes(suite.name)) : suites;

/** Run one suite, holding its output until it exits so parallel suites do not interleave. */
function run(file, env) {
  return new Promise((resolve) => {
    const started = performance.now();
    const child = spawn(process.execPath, ["--test", file], { env: { ...process.env, ...env } });
    const output = [];
    child.stdout.on("data", (chunk) => output.push(chunk));
    child.stderr.on("data", (chunk) => output.push(chunk));
    child.on("close", (code) => resolve({ code, output: Buffer.concat(output), ms: performance.now() - started }));
  });
}

const dir = mkdtempSync(join(tmpdir(), "shirabe-extension-test-"));
try {
  const bundles = await bundleTests([...new Set(selected.flatMap((suite) => suite.entry ?? []))], dir);
  const queue = [...selected];
  const failed = [];
  await Promise.all(Array.from({ length: Math.min(availableParallelism(), queue.length) }, async () => {
    for (let suite = queue.shift(); suite; suite = queue.shift()) {
      const label = [suite.name, ...Object.entries(suite.env ?? {}).map(([key, value]) => `${key}=${value}`)].join(" ");
      const result = await run(suite.file ?? bundles[suite.entry], suite.env);
      process.stdout.write(`\n# ${label} (${(result.ms / 1000).toFixed(1)} s)\n`);
      process.stdout.write(result.output);
      if (result.code !== 0) failed.push(label);
    }
  }));
  if (failed.length) {
    process.stderr.write(`\nFailed: ${failed.join(", ")}\n`);
    process.exitCode = 1;
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
