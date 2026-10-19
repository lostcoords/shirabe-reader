import * as esbuild from "esbuild";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { rmSync, watch as watchFiles } from "node:fs";
import { copyFile, cp, mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { developmentBuildId, DEVELOPMENT_RELOAD_PORT, startDevelopmentReloadServer } from "./dev-reload-server.mjs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const run = promisify(execFile);
const tailwindCli = join(dirname(fileURLToPath(import.meta.resolve("@tailwindcss/cli/package.json"))), "dist/index.mjs");
const nobleHashesRoot = dirname(fileURLToPath(import.meta.resolve("@noble/hashes")));
// The test suite imports this file for the host lists below, so the build only
// runs when build.mjs is the entry point rather than on every import.
const isMain = process.argv[1] === fileURLToPath(import.meta.url);
const target = process.argv[2] ?? "firefox";
const watch = process.argv.includes("--watch");
const devReloadPort = Number(process.env.SHIRABE_DEV_RELOAD_PORT || DEVELOPMENT_RELOAD_PORT);
if (watch && (!Number.isInteger(devReloadPort) || devReloadPort < 1 || devReloadPort > 65535)) {
  throw new Error(`SHIRABE_DEV_RELOAD_PORT must be a TCP port, got ${process.env.SHIRABE_DEV_RELOAD_PORT}`);
}
const baseManifest = JSON.parse(await readFile(join(root, "manifest.base.json"), "utf8"));

if (isMain && !["firefox", "chrome"].includes(target)) {
  console.error(`Unknown target "${target}". Use "firefox" or "chrome".`);
  process.exit(1);
}

// Shirabe's own pages are the dictionary, not a reading surface, so the reader
// never parses them. Exported because the test suite compiles against the same
// `__SHIRABE_OFF_HOSTS__` define: one definition, so dropping a host here fails
// the tests instead of silently shipping.
export const RELEASE_OFF_HOSTS = ["*://shirabe.org/*", "*://*.shirabe.org/*"];
export const DEV_OFF_HOSTS = [...RELEASE_OFF_HOSTS, "*://shirabe.localhost/*"];

// Which server a build talks to. A watcher defaults to the local one, but a
// watcher is also how you test UNRELEASED extension code against the server that
// is already live, which is the shape of every pre-release check:
// `--api=https://shirabe.org` gives you that with no local Rails. It has to be a
// build flag rather than a Settings field because config.ts repairs a stored
// apiBase back to the build-time default, precisely so a dev profile cannot get
// stuck pointing at production.
const apiArg = process.argv.find((arg) => arg.startsWith("--api="));
const apiBase = apiArg
  ? apiArg.slice("--api=".length).replace(/\/$/, "")
  : (watch ? "https://shirabe.localhost" : "https://shirabe.org");
const apiHost = new URL(apiBase).hostname;
// The local server, including a worktree's own name such as `signup-shirabe.localhost`.
const localApi = apiHost === "shirabe.localhost" || apiHost.endsWith("-shirabe.localhost");
const devOffHosts = localApi && apiHost !== "shirabe.localhost" ? [...DEV_OFF_HOSTS, `*://${apiHost}/*`] : DEV_OFF_HOSTS;

const outputArg = process.argv.find((arg) => arg.startsWith("--outdir="));
const outdir = outputArg
  ? resolve(root, outputArg.slice("--outdir=".length))
  : join(root, "dist", target);
// One watcher per output directory, so each Shirabe worktree can run its own.
const watchLock = outputArg
  ? join(dirname(outdir), `${basename(outdir)}.watch.lock`)
  : join(root, ".web-ext-profile", `${target}.watch.lock`);

// Each entry becomes a standalone classic (IIFE) bundle. Content scripts and
// MV3 background workers can't be ES modules across both browsers, so we let
// esbuild inline every import into one self-contained file per entry point.
const entries = {
  background: "src/background/background.ts",
  content: "src/content/content.ts",
  "action/popup": "src/action/popup.ts",
  "options/options": "src/options/options.ts",
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
    __DEFAULT_API_BASE__: JSON.stringify(apiBase),
    // Release list only, so production zips never embed a localhost host pattern.
    __SHIRABE_OFF_HOSTS__: JSON.stringify(watch ? devOffHosts : RELEASE_OFF_HOSTS),
    __EXTENSION_VERSION__: JSON.stringify(baseManifest.version),
    __DEV_RELOAD__: watch ? "true" : "false",
    __DEV_RELOAD_URL__: JSON.stringify(watch ? `http://127.0.0.1:${devReloadPort}/build.json` : ""),
    // Which build is actually loaded. The version alone can't answer that during
    // development: it doesn't move between rebuilds, so a stale copy of the
    // extension looks identical to a fresh one in the console.
    __BUILD_ID__: JSON.stringify(new Date().toISOString().replace(/[-:]/g, "").slice(0, 15)),
    // Telemetry ships to the self-hosted Grafana Faro receiver on the same host
    // Alloy the web app beacons to. The EXTENSION IS NOW ITS ONLY CLIENT: the
    // web app dropped the Faro SDK on 2026-08-22 and sends OTLP metrics to
    // /v1/metrics (:4330) instead, so /collect and the :4329 receiver must stay
    // provisioned for this. Watch builds report tagged "development" so dev
    // noise stays filterable, exactly like the web's DEPLOYMENT_ENV-tagged
    // environment.
    // PostHog through our own domain, the same host `POSTHOG_HOST` names in
    // production. Not `*.i.posthog.com` directly: content blockers filter that
    // by name, and a report that is silently swallowed is worse than none,
    // because the absence reads as "no crashes". The project token is public by
    // design: it names a project to write into and reads nothing.
    __POSTHOG_HOST__: JSON.stringify("https://t.shirabe.org"),
    __POSTHOG_TOKEN__: JSON.stringify(process.env.POSTHOG_PROJECT_TOKEN ?? ""),
    __TELEMETRY_ENV__: JSON.stringify(watch ? "development" : "production"),
  },
};

async function manifest() {
  const base = JSON.parse(await readFile(join(root, "manifest.base.json"), "utf8"));

  // Store packages must never request a development origin. Watch builds add
  // the local Rails host because their baked-in API default points there.
  if (watch && localApi) base.host_permissions.push(`https://${apiHost}/*`);

  if (target === "firefox") {
    base.background = { scripts: ["background.js"] };
    base.browser_specific_settings = {
      gecko: {
        id: watch ? "reader-dev@shirabe.org" : "reader@shirabe.org",
        strict_min_version: "142.0",
        data_collection_permissions: {
          required: ["websiteContent"],
          optional: ["technicalAndInteraction", "authenticationInfo"],
        },
      },
      gecko_android: {},
    };
  } else {
    base.background = { service_worker: "background.js" };
  }

  const destination = join(outdir, "manifest.json");
  const temporary = `${destination}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, JSON.stringify(base, null, 2));
  await rename(temporary, destination);
}

async function copyStatic() {
  await copyFile(join(root, "src/content/content.css"), join(outdir, "content.css"));
  await copyFile(join(root, "src/action/popup.html"), join(outdir, "action/popup.html"));
  await run(process.execPath, [tailwindCli, "--input", join(root, "src/action/popup.css"), "--output", join(outdir, "action/popup.css"), "--minify"], { cwd: root });
  await copyFile(join(root, "src/options/options.html"), join(outdir, "options/options.html"));
  await esbuild.build({
    entryPoints: [join(root, "src/options/options.css")],
    bundle: true,
    outfile: join(outdir, "options/options.css"),
    logLevel: "silent",
  });
  await copyFile(join(nobleHashesRoot, "LICENSE"), join(outdir, "licenses/noble-hashes-MIT.txt"));
  // The extension is GPL-3.0 (Yomitan-derived deinflection); ship its terms and
  // attribution with the package rather than only in the repository. These files
  // ARE the compliance: GPL-3.0 §4 wants a copy of the licence conveyed with the
  // program, and MIT wants its notice kept in copies. There is no in-product page
  // rendering them: shirabe.org/credits is the readable home, and the packaged
  // text is what has to travel.
  await copyFile(join(root, "LICENSE"), join(outdir, "licenses/gpl-3.0.txt"));
  await copyFile(join(root, "NOTICE"), join(outdir, "licenses/NOTICE.txt"));
  await cp(join(root, "src/icons"), join(outdir, "icons"), { recursive: true });
}

let scriptContext;
let watchedVersion = baseManifest.version;
let reloadServer;
let publishTimer;
function scheduleDevelopmentPublish() {
  if (!watch || !reloadServer) return;
  clearTimeout(publishTimer);
  publishTimer = setTimeout(() => {
    void publishDevelopmentBuild().catch((error) => console.error("✗ development reload publish failed", error));
  }, 250);
}
async function publishDevelopmentBuild() {
  if (!reloadServer) return;
  const id = developmentBuildId();
  const destination = join(outdir, "build.json");
  const temporary = `${destination}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify({ id })}\n`);
  await rename(temporary, destination);
  reloadServer.publish(id);
  console.log(`↻ development build ${id}`);
}
function developmentReloadPlugin() {
  return {
    name: "development-reload",
    setup(build) {
      build.onEnd((result) => {
        if (result.errors.length === 0) scheduleDevelopmentPublish();
      });
    },
  };
}
async function watchScripts(version) {
  await scriptContext?.dispose();
  scriptContext = await esbuild.context({ ...buildOptions,
    plugins: [developmentReloadPlugin()],
    define: { ...buildOptions.define, __EXTENSION_VERSION__: JSON.stringify(version) },
  });
  await scriptContext.watch();
  watchedVersion = version;
}

async function buildAll() {
  if (watch) {
    await acquireWatchLock();
    reloadServer = startDevelopmentReloadServer({ port: devReloadPort });
    await reloadServer.ready;
  }
  if (!watch) await rm(outdir, { recursive: true, force: true });
  await mkdir(join(outdir, "action"), { recursive: true });
  await mkdir(join(outdir, "options"), { recursive: true });
  await mkdir(join(outdir, "licenses"), { recursive: true });

  if (watch) {
    await watchScripts(baseManifest.version);
  } else {
    await esbuild.build(buildOptions);
  }

  await manifest();
  await copyStatic();
  if (watch) {
    watchStatic();
    scheduleDevelopmentPublish();
  }
  console.log(`✓ ${target} build → ${outdir}${watch ? " (watching)" : ""}`);
}

async function acquireWatchLock() {
  await mkdir(dirname(watchLock), { recursive: true });
  try {
    const handle = await open(watchLock, "wx");
    await handle.writeFile(String(process.pid));
    await handle.close();
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    const owner = Number(await readFile(watchLock, "utf8").catch(() => ""));
    if (owner && processAlive(owner)) {
      throw new Error(`A ${target} dev watcher is already running (PID ${owner}). Stop it before starting another.`);
    }
    await rm(watchLock, { force: true });
    return acquireWatchLock();
  }

  const release = () => rmSync(watchLock, { force: true });
  process.once("exit", release);
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

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
        const latest = JSON.parse(await readFile(join(root, "manifest.base.json"), "utf8"));
        if (latest.version !== watchedVersion) await watchScripts(latest.version);
        await manifest();
        await copyStatic();
        scheduleDevelopmentPublish();
        console.log("↻ synced static assets + manifest");
      }).catch((error) => {
        console.error("✗ static asset sync failed", error);
      });
    }, 60);
  };
  watchFiles(join(root, "src"), { recursive: true }, resync);
  watchFiles(join(root, "manifest.base.json"), resync);
}

if (isMain) {
  buildAll().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
