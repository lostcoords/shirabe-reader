import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { extname, join, relative } from "node:path";

const textExtensions = new Set([".css", ".html", ".js", ".json", ".mjs", ".txt"]);
const requestedTarget = process.argv[2];
assert.ok(!requestedTarget || ["firefox", "chrome"].includes(requestedTarget), "target must be firefox or chrome");
const targets = requestedTarget ? [requestedTarget] : ["firefox", "chrome"];

for (const target of targets) {
  const root = join("dist", target);
  const manifest = JSON.parse(await readFile(join(root, "manifest.json"), "utf8"));
  // Required hosts are first-party Shirabe origins ONLY, listed exhaustively so a
  // new one has to be added here deliberately: shirabe.org (API), cdn.shirabe.org
  // (audio clips the background worker fetches: src/common/audio.ts), and
  // t.shirabe.org (PostHog, through our own domain rather than
  // *.i.posthog.com, which content blockers filter by name:
  // src/common/telemetry.ts). Page access stays optional, asserted below.
  assert.deepEqual(
    manifest.host_permissions,
    ["https://shirabe.org/*", "https://cdn.shirabe.org/*", "https://t.shirabe.org/*"],
    `${target} has unexpected required hosts`,
  );
  assert.deepEqual(manifest.optional_host_permissions, ["<all_urls>"], `${target} page access must remain optional`);

  for (const file of await filesBelow(root)) {
    const path = relative(root, file);
    assert.ok(!path.endsWith(".map"), `${target} package contains source map ${path}`);
    assert.ok(!path.startsWith("test/") && !path.includes("node_modules"), `${target} package contains development file ${path}`);
    if (!textExtensions.has(extname(file))) continue;
    const source = await readFile(file, "utf8");
    assert.doesNotMatch(source, /shirabe\.localhost|127\.0\.0\.1/, `${target} package contains a development origin in ${path}`);
    // A build made without POSTHOG_PROJECT_TOKEN in the environment ships an
    // empty token and reports nothing, silently, forever. The absence then
    // reads as "no crashes", which is the failure this whole migration was
    // about. Caught here rather than by noticing an empty dashboard.
    if (path === "background.js") {
      assert.match(source, /"phc_[A-Za-z0-9_-]{20,}"/, `${target} was built without POSTHOG_PROJECT_TOKEN set`);
    }
  }
}

console.log("Release manifests and dist contents contain only production hosts/assets.");

async function filesBelow(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(entries.map((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? filesBelow(path) : [path];
  }));
  return files.flat();
}
