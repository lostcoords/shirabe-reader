// Cross-browser build for Shirabe Reader.
//
//   node build.mjs firefox          one-shot build into dist/firefox
//   node build.mjs chrome --watch   rebuild-on-change into dist/chrome
//
// Both targets share every source file. The ONLY per-browser difference is the
// generated manifest: Chrome MV3 wants a `service_worker`, Firefox MV3 wants a
// background `scripts` array plus a `browser_specific_settings.gecko` block.
import * as esbuild from "esbuild";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const target = process.argv[2] ?? "firefox";
const watch = process.argv.includes("--watch");

if (!["firefox", "chrome"].includes(target)) {
  console.error(`Unknown target "${target}". Use "firefox" or "chrome".`);
  process.exit(1);
}

const outdir = join(root, "dist", target);

// Each entry becomes a standalone classic (IIFE) bundle. Content scripts and
// MV3 background workers can't be ES modules across both browsers, so we let
// esbuild inline every import into one self-contained file per entry point.
const entries = {
  background: "src/background/background.ts",
  content: "src/content/content.ts",
  "action/popup": "src/action/popup.ts",
};

const buildOptions = {
  entryPoints: Object.fromEntries(
    Object.entries(entries).map(([out, src]) => [out, join(root, src)]),
  ),
  outdir,
  bundle: true,
  format: "iife",
  target: ["firefox115", "chrome110"],
  sourcemap: watch ? "inline" : false,
  logLevel: "info",
};

async function manifest() {
  const base = JSON.parse(await readFile(join(root, "manifest.base.json"), "utf8"));

  if (target === "firefox") {
    base.background = { scripts: ["background.js"] };
    base.browser_specific_settings = {
      gecko: { id: "reader@shirabe.org", strict_min_version: "115.0" },
    };
  } else {
    base.background = { service_worker: "background.js" };
  }

  await writeFile(join(outdir, "manifest.json"), JSON.stringify(base, null, 2));
}

async function copyStatic() {
  await cp(join(root, "src/content/content.css"), join(outdir, "content.css"));
  await cp(join(root, "src/action/popup.html"), join(outdir, "action/popup.html"));
  await cp(join(root, "src/action/popup.css"), join(outdir, "action/popup.css"));
  await cp(join(root, "src/icons"), join(outdir, "icons"), { recursive: true });
}

async function buildAll() {
  await rm(outdir, { recursive: true, force: true });
  await mkdir(join(outdir, "action"), { recursive: true });

  if (watch) {
    const ctx = await esbuild.context(buildOptions);
    await ctx.watch();
  } else {
    await esbuild.build(buildOptions);
  }

  await manifest();
  await copyStatic();
  console.log(`✓ ${target} build → ${outdir}${watch ? " (watching)" : ""}`);
}

buildAll().catch((err) => {
  console.error(err);
  process.exit(1);
});
