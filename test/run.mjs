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

// The golden segmentation corpus installs its own dictionary pack, so it runs in
// its own process: sharing one with the unit suite means sharing the
// offline-dictionary module singleton and fake-indexeddb, and tearing the
// database down under another test's still-pending transactions.
const suites = [
  { name: "all.test.ts", entry: "test/all.test.ts", outfile: join(dir, "tests.cjs") },
  { name: "segmentation-golden.test.ts", entry: "test/segmentation-golden.test.ts", outfile: join(dir, "golden.cjs") },
  { name: "cross-engine.test.ts", entry: "test/cross-engine.test.ts", outfile: join(dir, "cross-engine.cjs") },
];

try {
  for (const suite of suites) {
    await build({
      entryPoints: [suite.entry], bundle: true, platform: "node", format: "cjs", outfile: suite.outfile, logLevel: "silent",
      define: {
        __EXTENSION_VERSION__: JSON.stringify(manifestVersion),
        __DEFAULT_API_BASE__: JSON.stringify("https://shirabe.org"),
        // Straight from the builder, so the host matrix under test is the one that
        // ships. Unit tests use the dev list because it exercises the local-dev
        // host rule too; production packages omit only that last entry.
        __SHIRABE_OFF_HOSTS__: JSON.stringify(DEV_OFF_HOSTS),
      },
    });
  }
  for (const suite of suites) {
    execFileSync(process.execPath, ["--test", suite.outfile], { stdio: "inherit" });
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
