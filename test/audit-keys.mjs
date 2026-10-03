import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const directory = mkdtempSync(join(tmpdir(), "shirabe-audit-keys-"));
const version = JSON.parse(readFileSync(new URL("../manifest.base.json", import.meta.url), "utf8")).version;
try {
  const outfile = join(directory, "keys.cjs");
  await build({ entryPoints: ["extension/test/audit-keys.ts"], bundle: true, platform: "node", format: "cjs", outfile, logLevel: "silent",
    define: { __DEFAULT_API_BASE__: JSON.stringify("https://shirabe.org"), __EXTENSION_VERSION__: JSON.stringify(version) } });
  execFileSync(process.execPath, [outfile, ...process.argv.slice(2)], { stdio: "inherit" });
} finally {
  rmSync(directory, { recursive: true, force: true });
}
