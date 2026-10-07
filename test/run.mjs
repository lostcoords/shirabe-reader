import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEV_OFF_HOSTS } from "../build.mjs";

const dir = mkdtempSync(join(tmpdir(), "shirabe-extension-test-"));
// Read the real version rather than a literal: a pack declares the minimum
// client it needs, so a stale test version silently fails every install the
// moment MINIMUM_EXTENSION_VERSION is bumped.
const manifestVersion = JSON.parse(readFileSync(new URL("../manifest.base.json", import.meta.url), "utf8")).version;

// The segmentation corpora install a dictionary pack, so they run in their own
// process: sharing one with the unit suite means sharing the offline-dictionary
// module singleton and fake-indexeddb, and tearing the database down under
// another test's still-pending transactions. All of them share one process and
// one installed pack, so the 58 MB pack is scanned once rather than per corpus.
const suites = [
  { name: "background-dictionary-sync.test.ts", entry: "test/background-dictionary-sync.test.ts", outfile: join(dir, "background-dictionary-sync.cjs") },
  { name: "background-install-reporting.test.ts", entry: "test/background-install-reporting.test.ts", outfile: join(dir, "background-install-reporting.cjs") },
  { name: "dictionary-panel.test.ts", entry: "test/dictionary-panel.test.ts", outfile: join(dir, "dictionary-panel.cjs") },
  { name: "dictionary-sync.test.ts", entry: "test/dictionary-sync.test.ts", outfile: join(dir, "dictionary-sync.cjs") },
  { name: "click-positions.test.ts", entry: "test/click-positions.test.ts", outfile: join(dir, "click-positions.cjs") },
  { name: "telemetry-permission.test.ts", entry: "test/telemetry-permission.test.ts", outfile: join(dir, "telemetry-permission.cjs") },
  { name: "background-parity.test.ts", entry: "test/background-parity.test.ts", outfile: join(dir, "background-parity.cjs") },
  { name: "background-private-startup.test.ts", entry: "test/background-private-startup.test.ts", outfile: join(dir, "background-private-startup.cjs") },
  { name: "all.test.ts", entry: "test/all.test.ts", outfile: join(dir, "tests.cjs") },
  { name: "segmentation.test.ts", entry: "test/segmentation.test.ts", outfile: join(dir, "segmentation.cjs") },
];

const requested = process.argv.slice(2);
if (!requested.length || requested.includes("all.test.ts")) {
  execFileSync(process.execPath, ["--test", "test/watch-build.test.mjs"], { stdio: "inherit" });
}
const selectedSuites = requested.length ? suites.filter((suite) => requested.includes(suite.name)) : suites;
if (requested.some((name) => !suites.some((suite) => suite.name === name))) throw new Error("Unknown extension test suite");

try {
  for (const suite of selectedSuites) {
    await build({
      entryPoints: [suite.entry], bundle: true, platform: "node", format: "cjs", outfile: suite.outfile, logLevel: "silent",
      define: {
        __EXTENSION_VERSION__: JSON.stringify(manifestVersion),
        __DEFAULT_API_BASE__: JSON.stringify("https://shirabe.org"),
        // Straight from the builder, so the host matrix under test is the one that
        // ships. Unit tests use the dev list because it exercises the local-dev
        // host rule too; production packages omit only that last entry.
        __SHIRABE_OFF_HOSTS__: JSON.stringify(DEV_OFF_HOSTS),
        // The telemetry sender reads these at module scope; without them the
        // bundle carries bare identifiers and the suite dies on the first import.
        __POSTHOG_HOST__: JSON.stringify("https://posthog.test"),
        __POSTHOG_TOKEN__: JSON.stringify("phc_test"),
        __TELEMETRY_ENV__: JSON.stringify("test"),
      },
    });
  }
  for (const suite of selectedSuites) {
    execFileSync(process.execPath, ["--test", suite.outfile], { stdio: "inherit" });
    if (suite.name === "background-parity.test.ts") {
      execFileSync(process.execPath, ["--test", suite.outfile], {
        stdio: "inherit", env: { ...process.env, PARITY_MESSAGE_API: "firefox" },
      });
    }
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
