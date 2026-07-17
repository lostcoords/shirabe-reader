import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "shirabe-extension-test-"));
const outfile = join(dir, "tests.cjs");

try {
  await build({
    entryPoints: ["test/all.test.ts"], bundle: true, platform: "node", format: "cjs", outfile, logLevel: "silent",
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
  execFileSync(process.execPath, ["--test", outfile], { stdio: "inherit" });
} finally {
  rmSync(dir, { recursive: true, force: true });
}
