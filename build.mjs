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
// A plain `--watch` (no --serve) hot-reloads in YOUR OWN Firefox instead: load
// dist/firefox once via about:debugging and the reload server below tells the
// extension to reload itself after every build. See "Develop in your own
// Firefox" in the README.
//
// Both targets share every source file. The ONLY per-browser difference is the
// generated manifest: Chrome MV3 wants a `service_worker`, Firefox MV3 wants a
// background `scripts` array plus a `browser_specific_settings.gecko` block.
import * as esbuild from "esbuild";
import { spawn } from "node:child_process";
import { existsSync, rmSync, watch as watchFiles } from "node:fs";
import { createServer } from "node:http";
import { copyFile, cp, mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
// The test suite imports this file for the host lists below, so the build only
// runs when build.mjs is the entry point rather than on every import.
const isMain = process.argv[1] === fileURLToPath(import.meta.url);
const target = process.argv[2] ?? "firefox";
const watch = process.argv.includes("--watch");
const serve = process.argv.includes("--serve");
const baseManifest = JSON.parse(await readFile(join(root, "manifest.base.json"), "utf8"));

// A Japanese page to open on launch so the dev browser is ready to test against.
const START_URL = "https://ja.wikipedia.org/wiki/日本語";

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
const localApi = apiBase.includes("shirabe.localhost");

const outputArg = process.argv.find((arg) => arg.startsWith("--outdir="));
const outdir = outputArg
  ? join(root, outputArg.slice("--outdir=".length))
  : join(root, "dist", target);
// A persistent, per-target dev profile so login + connection survive restarts
// (gitignored). First run: log in once; every run after reuses it.
const profileDir = join(root, ".web-ext-profile", target);
const watchLock = join(root, ".web-ext-profile", `${target}.watch.lock`);

// Self-reload for a watcher without --serve: the extension subscribes to this
// local event stream and reloads itself after every build, so you can develop a
// temporary add-on in your everyday Firefox. Firefox only: Chrome's MV3
// background is a service worker, which has no EventSource.
const RELOAD_PORT = 8473;
const devReload = watch && !serve && target === "firefox";
const reloadUrl = `http://127.0.0.1:${RELOAD_PORT}/reload`;

// The Chromium half of the same idea, and it works the other way round: the
// extension can't listen (a service worker has no EventSource), so the WATCHER
// drives the browser instead, over the DevTools protocol. `Extensions.
// loadUnpacked` is what web-ext sends, and sending it twice for the same path
// is a reload, so load and reload are one call.
//
// Start Brave/Chrome yourself with --remote-debugging-port and keep your own
// profile: unlike --serve, nothing here needs web-ext to own the browser.
//
// That port is not free of consequence: anything local that can reach it can
// drive the browser and read the session. Dev builds only, and it is off unless
// you ask for it.
// Brave is what we read in; CHROMIUM_BINARY names any other Chromium.
const DEFAULT_CHROMIUM = "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser";
const cdpArg = process.argv.find((arg) => arg === "--cdp" || arg.startsWith("--cdp="));
const cdpPort = cdpArg ? Number(cdpArg.split("=")[1] ?? 9222) : null;
const cdpReload = Boolean(watch && !serve && target !== "firefox" && cdpPort);
// Until the browser is confirmed up, a rebuild has nowhere to go: the first
// build fires one before ensureCdpBrowser has finished launching, and warning
// about that would be crying wolf on the happy path.
let cdpReady = false;

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
  // shirabe-sdk lives beside this project in the repository and is bundled from
  // source: no install step and no version to bump while the extension is its
  // only consumer (docs/plans/word-card-library.md).
  alias: { "shirabe-sdk": join(root, "../shirabe-sdk/src") },
  format: "iife",
  target: ["firefox115", "chrome110"],
  sourcemap: watch ? "inline" : false,
  logLevel: "info",
  // Default API host baked in at build time: local server for dev/watch builds,
  // production for shipped one-shot builds. Overridable at runtime via Advanced.
  define: {
    __DEFAULT_API_BASE__: JSON.stringify(apiBase),
    // Release list only, so production zips never embed a localhost host pattern.
    __SHIRABE_OFF_HOSTS__: JSON.stringify(watch ? DEV_OFF_HOSTS : RELEASE_OFF_HOSTS),
    __EXTENSION_VERSION__: JSON.stringify(baseManifest.version),
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
    // Empty everywhere else, so the self-reload client compiles down to nothing.
    __DEV_RELOAD_URL__: JSON.stringify(devReload ? reloadUrl : ""),
  },
  // Rebuild finished and clean → tell any listening extension to reload itself.
  plugins: devReload || cdpReload
    ? [{
      name: "dev-reload",
      setup: (build) => build.onEnd((result) => {
        if (!result.errors.length) announceRebuild();
      }),
    }]
    : [],
};

async function manifest() {
  const base = structuredClone(baseManifest);

  // Store packages must never request a development origin. Watch builds add
  // the local Rails host because their baked-in API default points there.
  if (watch && localApi) base.host_permissions.push("https://shirabe.localhost/*");
  // Reaching the local reload stream is a fetch to another origin, so the watch
  // manifest has to ask for it. Never in a packaged build.
  if (devReload) base.host_permissions.push(`http://127.0.0.1:${RELOAD_PORT}/*`);

  if (target === "firefox") {
    base.background = { scripts: ["background.js"] };
    base.browser_specific_settings = {
      gecko: {
        // Keep temporary/watch storage isolated from the signed production
        // extension. A stable dev ID preserves it across npm run dev restarts,
        // while a broken dev origin can never poison a user's release data.
        id: watch ? "reader-dev@shirabe.org" : "reader@shirabe.org",
        strict_min_version: "142.0",
        // What we actually send, not what we could reach. Reading a page sends
        // nothing: parsing and lookup are local, and telemetry carries failure
        // shape only (error class, our own frames, versions, browser). The two
        // optional entries are user-initiated: connecting an account transmits
        // its key, and mining a sentence transmits that sentence. Keep this
        // honest against src/common/telemetry.ts and STORE_LISTING.md, since a
        // reviewer compares all three.
        data_collection_permissions: {
          required: ["none"],
          optional: ["technicalAndInteraction", "authenticationInfo", "websiteContent"],
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
  // copyFile overwrites in place. fs.cp unlinks an existing destination first,
  // which races with web-ext's reload watcher and can leave a temporarily
  // missing asset (or throw ENOENT when another reload observes that gap).
  await copyFile(join(root, "src/content/content.css"), join(outdir, "content.css"));
  await copyFile(join(root, "src/action/popup.html"), join(outdir, "action/popup.html"));
  await copyFile(join(root, "src/action/popup.css"), join(outdir, "action/popup.css"));
  await copyFile(join(root, "src/options/options.html"), join(outdir, "options/options.html"));
  await copyFile(join(root, "src/options/options.css"), join(outdir, "options/options.css"));
  await copyFile(join(root, "node_modules/@noble/hashes/LICENSE"), join(outdir, "licenses/noble-hashes-MIT.txt"));
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

async function buildAll() {
  if (watch) await acquireWatchLock();
  // A temporary add-on loaded from about:debugging keeps reading THIS directory,
  // so deleting it pulls the extension out from under a browser that already has
  // it loaded: restarting the watcher would leave a dead add-on and a blank
  // popup. Watch builds overwrite in place instead (as copyStatic already does,
  // for the same reason); one-shot builds still start from a clean directory so
  // a package can never inherit a stale file.
  if (!watch) await rm(outdir, { recursive: true, force: true });
  await mkdir(join(outdir, "action"), { recursive: true });
  await mkdir(join(outdir, "options"), { recursive: true });
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
  if (devReload) startReloadServer();
  console.log(`✓ ${target} build → ${outdir}${watch ? " (watching)" : ""}`);
  if (cdpReload) await ensureCdpBrowser();
}

// `--cdp` needs a browser listening on the debugging port, and the flag only
// takes effect at startup: a browser already open without it cannot be given one
// (a second launch just focuses the first). So: use one that answers, otherwise
// start one, otherwise say plainly that the running browser has to be quit. The
// alternative, quitting it ourselves, would throw away someone's tabs to save
// them a keystroke.
async function ensureCdpBrowser() {
  if (await cdpAlive()) {
    cdpReady = true;
    console.log(`↻ attached to the browser on CDP :${cdpPort}`);
    return announceRebuild();
  }

  const binary = process.env.CHROMIUM_BINARY ?? DEFAULT_CHROMIUM;
  if (!existsSync(binary)) {
    return console.warn(`↻ no browser on CDP :${cdpPort}, and none at ${binary}. Set CHROMIUM_BINARY, or start yours with --remote-debugging-port=${cdpPort}.`);
  }

  console.log(`↻ starting ${basename(binary)} on CDP :${cdpPort}`);
  // Detached, and its output discarded: the browser outlives the watcher, so
  // Ctrl-C here must not take the window down with it.
  spawn(binary, [`--remote-debugging-port=${cdpPort}`], { detached: true, stdio: "ignore" }).unref();

  for (let i = 0; i < 40; i++) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    if (await cdpAlive()) {
      cdpReady = true;
      return announceRebuild();
    }
  }
  console.warn(`↻ ${basename(binary)} did not open CDP :${cdpPort}. It is probably already running without the flag: quit it and restart this watcher.`);
}

async function cdpAlive() {
  try {
    return (await fetch(`http://127.0.0.1:${cdpPort}/json/version`)).ok;
  } catch {
    return false;
  }
}

// A one-route event stream the extension subscribes to. Every connected client
// is a Firefox that loaded `outdir` as a temporary add-on; a rebuild pushes one
// event and each of them calls runtime.reload() on itself.
const reloadClients = new Set();

function startReloadServer() {
  const server = createServer((request, response) => {
    if (request.url !== "/reload") {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-store",
      // The subscriber is a moz-extension: page, so this is a cross-origin read.
      "access-control-allow-origin": "*",
    });
    // Reconnect fast after the watcher restarts, rather than EventSource's
    // browser default of a few seconds.
    response.write("retry: 1000\n\n");
    reloadClients.add(response);
    request.on("close", () => reloadClients.delete(response));
  });
  server.on("error", (error) => {
    console.error(`✗ self-reload disabled: port ${RELOAD_PORT}: ${error.code ?? error.message}`);
  });
  // Never a reason to keep the watcher alive by itself.
  server.unref();
  server.listen(RELOAD_PORT, "127.0.0.1", () => {
    console.log(`↻ self-reload stream on ${reloadUrl} (load dist/${target} via about:debugging)`);
  });
}

let announceTimer;

// TS rebuilds and the static resync below can both land for a single save, so
// coalesce them into one reload.
function announceRebuild() {
  if (!devReload && !cdpReload) return;
  clearTimeout(announceTimer);
  announceTimer = setTimeout(() => {
    for (const client of reloadClients) client.write("event: rebuilt\ndata: {}\n\n");
    if (cdpReload) reloadOverCdp();
  }, 150);
}

// A dead browser, a closed port, a Chromium too old for the command: all of them
// mean "no reload this time", never "take the watcher down with you".
async function reloadOverCdp() {
  if (!cdpReady) return;
  let socket;
  try {
    const endpoint = await fetch(`http://127.0.0.1:${cdpPort}/json/version`).then((r) => r.json());
    socket = new WebSocket(endpoint.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      socket.onopen = resolve;
      socket.onerror = () => reject(new Error("DevTools socket refused the connection"));
    });

    const id = 1;
    const answer = new Promise((resolve) => {
      socket.addEventListener("message", (event) => {
        const message = JSON.parse(event.data);
        if (message.id === id) resolve(message);
      });
    });
    socket.send(JSON.stringify({ id, method: "Extensions.loadUnpacked", params: { path: outdir } }));

    const { error } = await answer;
    if (error) console.warn(`↻ reload refused: ${error.message}`);
    else console.log("↻ reloaded in the browser (refresh the tab for content scripts)");
  } catch (error) {
    console.warn(`↻ no browser on CDP :${cdpPort} (${error.message})`);
  } finally {
    socket?.close();
  }
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

// esbuild only watches the TS graph, so re-sync everything else: CSS, popup
// HTML, icons, and the generated manifest: when it changes. web-ext then sees
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
        announceRebuild();
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
    // Firefox uses its own cert store: not the OS keychain: so it won't trust
    // the rb-portless dev CA and every https://shirabe.localhost request fails.
    // Enterprise-roots pulls in the OS trust store (where `rb-portless trust` put
    // the CA). Chrome uses the keychain already, so this is Firefox-only.
    args.push("--firefox-profile", profileDir, "--pref", "security.enterprise_roots.enabled=true", "--devtools");
  } else {
    args.push("--chromium-profile", profileDir);
    // Any Chromium will do, and web-ext defaults to Chrome. CHROMIUM_BINARY
    // points it at the one you actually read in: `npm run dev:brave` sets it to
    // Brave. Nothing about the build changes, only which browser opens it.
    if (process.env.CHROMIUM_BINARY) args.push("--chromium-binary", process.env.CHROMIUM_BINARY);
  }

  const child = spawn("npx", args, { cwd: root, stdio: "inherit" });

  const stop = () => child.kill();
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  child.on("exit", (code) => process.exit(code ?? 0));
}

if (isMain) {
  buildAll()
    .then(() => {
      if (serve) return startWebExt();
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
