import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";

const packDir = process.argv[2];
if (!packDir) throw new Error("Usage: node test/search-parity.mjs /absolute/current-pack-directory");
const dir = mkdtempSync(join(tmpdir(), "shirabe-search-parity-run-"));
const webOutput = join(dir, "web.json");
const manifest = JSON.parse(readFileSync(new URL("../manifest.base.json", import.meta.url), "utf8"));
const revision = process.env.PARITY_OFFLINE_REV;
const snapshot = revision ? [{
  name: "offline-revision",
  setup(builder) {
    builder.onLoad({ filter: /\/src\/common\// }, ({ path }) => ({
      contents: execFileSync("jj", ["file", "show", "-r", revision, relative(resolve("."), path)], { cwd: ".", encoding: "utf8" }),
      loader: path.endsWith(".json") ? "json" : "ts", resolveDir: dirname(path),
    }));
  },
}] : [];
if (revision) execFileSync("jj", ["root"], { cwd: ".", stdio: "ignore" });
try {
  execFileSync("bin/rails", ["runner", "script/export_search_parity.rb"], {
    cwd: process.env.SHIRABE_PATH ?? "../shirabe", stdio: "inherit",
    env: { ...process.env, PARITY_PACK_DIR: resolve(packDir), PARITY_WEB_OUTPUT: webOutput },
  });
  const outfile = join(dir, "parity.cjs");
  const browserBundle = join(dir, "browser.js");
  if (process.env.PARITY_NO_BROWSER !== "1") {
    await build({
      entryPoints: ["test/search-parity-browser.ts"], bundle: true, platform: "browser", format: "iife",
      outfile: browserBundle, logLevel: "silent", define: { __EXTENSION_VERSION__: JSON.stringify(manifest.version) },
      plugins: snapshot,
    });
  }
  await build({
    entryPoints: ["test/search-parity-runner.ts"], bundle: true, platform: "node",
    format: "cjs", outfile, logLevel: "silent",
    define: {
      __EXTENSION_VERSION__: JSON.stringify(manifest.version),
      __DEFAULT_API_BASE__: JSON.stringify("https://shirabe.test"),
      __SHIRABE_OFF_HOSTS__: JSON.stringify([]),
    },
  });
  execFileSync(process.execPath, [outfile, webOutput], { stdio: "inherit", env: {
    ...process.env, PARITY_BROWSER_BUNDLE: process.env.PARITY_NO_BROWSER === "1" ? "" : browserBundle,
  } });
} finally {
  rmSync(dir, { recursive: true, force: true });
}
