import assert from "node:assert/strict";
import { lstat, readdir, readFile } from "node:fs/promises";
import { dirname, extname, join, relative } from "node:path";

const textExtensions = new Set([".css", ".html", ".js", ".json", ".mjs", ".txt"]);
const requestedTarget = process.argv[2];
assert.ok(!requestedTarget || ["firefox", "chrome"].includes(requestedTarget), "target must be firefox or chrome");
const targets = requestedTarget ? [requestedTarget] : ["firefox", "chrome"];

// The SDK a store build bundles has to be the one package.json pins. `npm run
// sdk:link` symlinks a sibling working copy, so every local check passes
// against code a clean `npm ci` (what AMO's source reviewer runs) never installs.
const pkg = JSON.parse(await readFile("package.json", "utf8"));
const lock = JSON.parse(await readFile("package-lock.json", "utf8"));
for (const name of ["@shirabe-org/api", "@shirabe-org/card"]) {
  const path = join("node_modules", name);
  assert.ok(!(await lstat(path)).isSymbolicLink(), `${path} is a symlink: run npm ci before a release build`);
  assert.ok(!(await lstat(dirname(path))).isSymbolicLink(), `${dirname(path)} is a symlink: run npm ci before a release build`);
  const pinned = pkg.dependencies[name];
  assert.equal(lock.packages[""].dependencies[name], pinned, `package-lock.json pins ${name} differently from package.json`);
  assert.equal(lock.packages[path]?.version, pinned, `package-lock.json resolves ${name} to another version`);
  const installed = JSON.parse(await readFile(join(path, "package.json"), "utf8")).version;
  assert.equal(installed, pinned, `${name} ${installed} is installed but package.json pins ${pinned}`);
}

for (const target of targets) {
  const root = join("dist", target);
  const manifest = JSON.parse(await readFile(join(root, "manifest.json"), "utf8"));
  assert.deepEqual(
    manifest.host_permissions,
    ["<all_urls>", "https://shirabe.org/*", "https://cdn.shirabe.org/*", "https://t.shirabe.org/*"],
    `${target} has unexpected required hosts`,
  );
  assert.equal(manifest.optional_host_permissions, undefined, `${target} must not request page access per site`);
  // Firefox shows these at install. A save sends the page's address and title,
  // which Firefox counts as browsing activity. Error reports are optional
  // because the reader can turn them off (the errorReports setting).
  if (target === "firefox") {
    assert.deepEqual(manifest.browser_specific_settings.gecko.data_collection_permissions,
      { required: ["websiteContent", "browsingActivity"], optional: ["technicalAndInteraction", "authenticationInfo"] });
  }

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

console.log("Release manifests and dist contents contain the expected permissions and production assets.");

async function filesBelow(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(entries.map((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? filesBelow(path) : [path];
  }));
  return files.flat();
}
