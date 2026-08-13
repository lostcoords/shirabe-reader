import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const dir = mkdtempSync(join(tmpdir(), "shirabe-probe1-"));
const manifestVersion = JSON.parse(readFileSync(new URL("../manifest.base.json", import.meta.url), "utf8")).version;
const outfile = join(dir, "probe.cjs");
try {
  await build({ entryPoints: ["test/one-sentence-probe.ts"], bundle: true, platform: "node", format: "cjs", outfile, logLevel: "silent",
    define: { __EXTENSION_VERSION__: JSON.stringify(manifestVersion), __DEFAULT_API_BASE__: JSON.stringify("https://shirabe.org"), __SHIRABE_OFF_HOSTS__: JSON.stringify([]) } });
  execFileSync(process.execPath, [outfile, ...process.argv.slice(2)], { stdio: "inherit" });
} finally { rmSync(dir, { recursive: true, force: true }); }
