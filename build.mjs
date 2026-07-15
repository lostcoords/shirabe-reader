// Cross-browser build for Shirabe Reader.
//
//   node build.mjs firefox                  one-shot build into dist/firefox
//   node build.mjs chrome --watch           rebuild-on-change into dist/chrome
//   node build.mjs firefox --watch --serve  watch + launch a browser that
//                                           hot-reloads the extension (web-ext)
//
// In --serve mode you launch the browser ONCE and leave it open: edits to any
// source (TS, CSS, HTML, icons, or the manifest) hot-reload the extension in
// place, and a persistent dev profile keeps you logged in across restarts.
//
// Both targets share every source file. The ONLY per-browser difference is the
// generated manifest: Chrome MV3 wants a `service_worker`, Firefox MV3 wants a
// background `scripts` array plus a `browser_specific_settings.gecko` block.
import * as esbuild from "esbuild";
import { spawn } from "node:child_process";
import { watch as watchFiles } from "node:fs";
import { copyFile, cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const target = process.argv[2] ?? "firefox";
const watch = process.argv.includes("--watch");
const serve = process.argv.includes("--serve");
const baseManifest = JSON.parse(await readFile(join(root, "manifest.base.json"), "utf8"));

// A Japanese page to open on launch so the dev browser is ready to test against.
const START_URL = "https://ja.wikipedia.org/wiki/日本語";

if (!["firefox", "chrome"].includes(target)) {
  console.error(`Unknown target "${target}". Use "firefox" or "chrome".`);
  process.exit(1);
}

const outputArg = process.argv.find((arg) => arg.startsWith("--outdir="));
const outdir = outputArg
  ? join(root, outputArg.slice("--outdir=".length))
  : join(root, "dist", target);
// A persistent, per-target dev profile so login + connection survive restarts
// (gitignored). First run: log in once; every run after reuses it.
const profileDir = join(root, ".web-ext-profile", target);

// Each entry becomes a standalone classic (IIFE) bundle. Content scripts and
// MV3 background workers can't be ES modules across both browsers, so we let
// esbuild inline every import into one self-contained file per entry point.
const entries = {
  background: "src/background/background.ts",
  content: "src/content/content.ts",
  "action/popup": "src/action/popup.ts",
  "options/options": "src/options/options.ts",
  "reader/reader": "src/reader/reader.ts",
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
  // Default API host baked in at build time: local server for dev/watch builds,
  // production for shipped one-shot builds. Overridable at runtime via Advanced.
  define: {
    __DEFAULT_API_BASE__: JSON.stringify(watch ? "https://shirabe.localhost" : "https://shirabe.org"),
    __EXTENSION_VERSION__: JSON.stringify(baseManifest.version),
  },
};

async function manifest() {
  const base = structuredClone(baseManifest);

  // Store packages must never request a development origin. Watch builds add
  // the local Rails host because their baked-in API default points there.
  if (watch) base.host_permissions.push("https://shirabe.localhost/*");

  if (target === "firefox") {
    base.background = { scripts: ["background.js"] };
    base.browser_specific_settings = {
      gecko: {
        // Keep temporary/watch storage isolated from the signed production
        // extension. A stable dev ID preserves it across npm run dev restarts,
        // while a broken dev origin can never poison a user's release data.
        id: watch ? "reader-dev@shirabe.org" : "reader@shirabe.org",
        strict_min_version: "142.0",
        data_collection_permissions: {
          required: ["authenticationInfo", "browsingActivity", "searchTerms", "websiteContent"],
        },
      },
      gecko_android: {},
    };
  } else {
    base.background = { service_worker: "background.js" };
  }

  await writeFile(join(outdir, "manifest.json"), JSON.stringify(base, null, 2));
}

async function copyStatic() {
  // copyFile overwrites in place. fs.cp unlinks an existing destination first,
  // which races with web-ext's reload watcher and can leave a temporarily
  // missing asset (or throw ENOENT when another reload observes that gap).
  await copyFile(join(root, "src/content/content.css"), join(outdir, "content.css"));
  await copyFile(join(root, "src/action/popup.html"), join(outdir, "action/popup.html"));
  await copyFile(join(root, "src/action/popup.css"), join(outdir, "action/popup.css"));
  await copyFile(join(root, "src/options/options.html"), join(outdir, "options/options.html"));
  await copyFile(join(root, "src/options/options.css"), join(outdir, "options/options.css"));
  await copyFile(join(root, "src/reader/reader.html"), join(outdir, "reader/reader.html"));
  await copyFile(join(root, "src/reader/reader.css"), join(outdir, "reader/reader.css"));
  await copyFile(join(root, "src/licenses.html"), join(outdir, "licenses.html"));
  await copyFile(join(root, "node_modules/pdfjs-dist/LICENSE"), join(outdir, "licenses/pdfjs-Apache-2.0.txt"));
  await copyFile(join(root, "node_modules/@noble/hashes/LICENSE"), join(outdir, "licenses/noble-hashes-MIT.txt"));
  // The extension is GPL-3.0 (Yomitan-derived deinflection); ship its terms and
  // attribution with the package rather than only in the repository.
  await copyFile(join(root, "LICENSE"), join(outdir, "licenses/gpl-3.0.txt"));
  await copyFile(join(root, "NOTICE"), join(outdir, "licenses/NOTICE.txt"));
  await copyFile(join(root, "node_modules/pdfjs-dist/build/pdf.worker.min.mjs"), join(outdir, "reader/pdf.worker.min.mjs"));
  await cp(join(root, "src/icons"), join(outdir, "icons"), { recursive: true });
}

async function buildAll() {
  await rm(outdir, { recursive: true, force: true });
  await mkdir(join(outdir, "action"), { recursive: true });
  await mkdir(join(outdir, "options"), { recursive: true });
  await mkdir(join(outdir, "reader"), { recursive: true });
  await mkdir(join(outdir, "licenses"), { recursive: true });

  if (watch) {
    const ctx = await esbuild.context(buildOptions);
    await ctx.watch();
  } else {
    await esbuild.build(buildOptions);
  }

  await manifest();
  await copyStatic();
  if (watch) watchStatic();
  console.log(`✓ ${target} build → ${outdir}${watch ? " (watching)" : ""}`);
}

// esbuild only watches the TS graph, so re-sync everything else — CSS, popup
// HTML, icons, and the generated manifest — when it changes. web-ext then sees
// the updated `outdir` and reloads, so editing those hot-reloads without a
// restart too.
function watchStatic() {
  let timer;
  let sync = Promise.resolve();
  const resync = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      // File watchers can fire again while an earlier async copy is still in
      // progress. Serialize runs so two fs.cp calls never race to replace the
      // same destination and crash the dev watcher with an ENOENT unlink.
      sync = sync.catch(() => undefined).then(async () => {
        await manifest();
        await copyStatic();
        console.log("↻ synced static assets + manifest");
      }).catch((error) => {
        console.error("✗ static asset sync failed", error);
      });
    }, 60);
  };
  watchFiles(join(root, "src"), { recursive: true }, (_event, file) => {
    if (!file || !file.endsWith(".ts")) resync(); // .ts is esbuild's job
  });
  watchFiles(join(root, "manifest.base.json"), resync);
}

// Launch a browser via web-ext that reloads the extension whenever the build in
// `outdir` changes. Firefox reloads on its own; Chromium reloads via web-ext.
async function startWebExt() {
  // web-ext's --profile-create-if-missing mkdir isn't recursive, so make sure the
  // parent exists; it then creates (and reuses) the per-target profile inside.
  await mkdir(dirname(profileDir), { recursive: true });

  const runTarget = target === "firefox" ? "firefox-desktop" : "chromium";
  // A persistent profile (created on first run, kept after) means you log in and
  // approve the extension ONCE, not every launch.
  const args = [
    "web-ext", "run",
    "--source-dir", outdir,
    "--target", runTarget,
    "--start-url", START_URL,
    "--profile-create-if-missing",
    "--keep-profile-changes",
  ];

  if (target === "firefox") {
    // Firefox uses its own cert store — not the OS keychain — so it won't trust
    // the rb-portless dev CA and every https://shirabe.localhost request fails.
    // Enterprise-roots pulls in the OS trust store (where `rb-portless trust` put
    // the CA). Chrome uses the keychain already, so this is Firefox-only.
    args.push("--firefox-profile", profileDir, "--pref", "security.enterprise_roots.enabled=true", "--devtools");
  } else {
    args.push("--chromium-profile", profileDir);
  }

  const child = spawn("npx", args, { cwd: root, stdio: "inherit" });

  const stop = () => child.kill();
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  child.on("exit", (code) => process.exit(code ?? 0));
}

buildAll()
  .then(() => {
    if (serve) return startWebExt();
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
