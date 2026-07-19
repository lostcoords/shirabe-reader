import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "shirabe-extension-test-"));

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
        __EXTENSION_VERSION__: JSON.stringify("0.2.0"),
        __DEFAULT_API_BASE__: JSON.stringify("https://shirabe.org"),
        // Unit tests exercise the local-dev host rule; production packages omit it.
        __SHIRABE_OFF_HOSTS__: JSON.stringify([
          "*://shirabe.org/*",
          "*://*.shirabe.org/*",
          "*://shirabe.localhost/*",
        ]),
      },
    });
  }
  for (const suite of suites) {
    execFileSync(process.execPath, ["--test", suite.outfile], { stdio: "inherit" });
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
