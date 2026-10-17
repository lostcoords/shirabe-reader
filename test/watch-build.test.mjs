import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { appendFile, cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(new URL("../build.mjs", import.meta.url)));

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

test("everyday Brave has one development command and no browser launcher", async () => {
  const { scripts } = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  assert.deepEqual(Object.keys(scripts).filter((name) => /^(dev|watch)(:|$)/.test(name)), ["watch:chrome"]);
  assert.equal(scripts["watch:chrome"], "node build.mjs chrome --watch");
  const builder = await readFile(join(root, "build.mjs"), "utf8");
  assert.match(builder, /startDevelopmentReloadServer/);
  assert.doesNotMatch(builder, /spawn\(|WebSocket|--cdp|Extensions\.loadUnpacked|web-ext run|osascript|open -a/);
});

test("the everyday Brave watcher rebuilds scripts and static assets in place", { timeout: 30_000 }, async () => {
  const workspace = await mkdtemp(join(tmpdir(), "shirabe-watch-test-"));
  const fixture = join(workspace, "extension");
  let watcher;
  let output = "";
  let exit;
  const eventually = async (condition) => {
    for (let attempt = 0; attempt < 200; attempt++) {
      if (watcher.exitCode !== null || watcher.signalCode !== null) {
        assert.fail(`Watcher exited unexpectedly:\n${output}`);
      }
      if (await condition().catch(() => false)) return;
      await delay(50);
    }
    assert.fail(`Watcher did not update the build:\n${output}`);
  };
  const built = (path) => readFile(join(fixture, "dist/chrome", path), "utf8");

  try {
    await mkdir(fixture);
    for (const path of ["build.mjs", "dev-reload-server.mjs", "manifest.base.json", "src", "LICENSE", "NOTICE"]) {
      await cp(join(root, path), join(fixture, path), { recursive: true });
    }
    await symlink(join(root, "node_modules"), join(fixture, "node_modules"), "dir");
    const port = await freePort();
    watcher = spawn(process.execPath, ["build.mjs", "chrome", "--watch"], {
      cwd: fixture,
      env: { ...process.env, SHIRABE_DEV_RELOAD_PORT: String(port) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    exit = once(watcher, "exit");
    watcher.stdout.on("data", (chunk) => { output += chunk; });
    watcher.stderr.on("data", (chunk) => { output += chunk; });
    await eventually(async () => output.includes("(watching)") && (await built("background.js")).includes("https://shirabe.localhost"));
    const css = await built("action/popup.css");
    assert.ok(css.includes(".gap-4"), "Tailwind layout utilities are compiled into the popup");
    assert.ok(css.includes("#252526"), "the popup uses neutral dark surfaces");
    assert.doesNotMatch(css, /@import|@source|@theme/);
    assert.ok((await built("options/options.css")).includes("#252526"), "settings share the popup palette");

    const manifest = JSON.parse(await built("manifest.json"));
    assert.deepEqual(manifest.background, { service_worker: "background.js" });
    assert.ok(manifest.host_permissions.includes("https://shirabe.localhost/*"));
    assert.ok(!manifest.host_permissions.some((host) => host.includes("127.0.0.1")));
    assert.equal(manifest.externally_connectable, undefined);
    assert.match(await built("background.js"), new RegExp(`http://127\\.0\\.0\\.1:${port}/build.json`));
    await eventually(async () => /^\d{8}T\d{9}-[0-9a-f]{2}$/.test(JSON.parse(await built("build.json")).id));
    const first = await fetch(`http://127.0.0.1:${port}/build.json`).then((response) => response.json());
    assert.equal(first.id, JSON.parse(await built("build.json")).id);

    await appendFile(join(fixture, "src/action/popup.ts"), '\nconsole.log("watch-script-probe");\n');
    await eventually(async () => (await built("action/popup.js")).includes('console.log("watch-script-probe")'));
    await eventually(async () => {
      const published = await fetch(`http://127.0.0.1:${port}/build.json`).then((response) => response.json());
      return published.id !== first.id && published.id === JSON.parse(await built("build.json")).id;
    });

    await appendFile(join(fixture, "src/action/popup.css"), '\n.watch-style-probe { display: block; }\n');
    await appendFile(join(fixture, "src/action/popup.html"), '\n<span id="watch-markup-probe"></span>\n');
    await eventually(async () => (await built("action/popup.css")).includes("watch-style-probe")
      && (await built("action/popup.html")).includes("watch-markup-probe"));
    assert.deepEqual(JSON.parse(await built("manifest.json")), manifest);

    await appendFile(join(fixture, "src/common/theme.css"), '\n:root { --watch-theme-probe: #0f766e; }\n');
    await eventually(async () => (await built("action/popup.css")).includes("--watch-theme-probe")
      && (await built("options/options.css")).includes("--watch-theme-probe")
      && (await built("content.js")).includes("--watch-theme-probe"));

    const sourceManifest = JSON.parse(await readFile(join(fixture, "manifest.base.json"), "utf8"));
    sourceManifest.version = "0.3.17";
    sourceManifest.permissions.push("notifications");
    await writeFile(join(fixture, "manifest.base.json"), JSON.stringify(sourceManifest));
    await eventually(async () => {
      const current = JSON.parse(await built("manifest.json"));
      return current.version === "0.3.17" && current.permissions.includes("notifications")
        && (await built("background.js")).includes('"0.3.17"');
    });
    await appendFile(join(fixture, "src/action/popup.ts"), '\nconsole.log("watch-manifest-version-probe");\n');
    await eventually(async () => (await built("action/popup.js")).includes("watch-manifest-version-probe"));
    assert.ok((await built("background.js")).includes('"0.3.17"'), "later script rebuilds retain the updated client version");
  } finally {
    if (watcher && watcher.exitCode === null && watcher.signalCode === null) {
      watcher.kill("SIGTERM");
      await exit;
    }
    await rm(workspace, { recursive: true, force: true });
  }
});
