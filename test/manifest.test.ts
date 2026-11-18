import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("the reader has one standing grant for ordinary pages", () => {
  const manifest = JSON.parse(readFileSync("manifest.base.json", "utf8")) as {
    host_permissions?: string[];
    optional_host_permissions?: string[];
    content_scripts?: Array<{ matches?: string[]; js?: string[]; css?: string[]; all_frames?: boolean }>;
  };

  // Every host the extension may reach, named exactly: the API, the audio CDN,
  // and PostHog through our own domain rather than *.i.posthog.com, which
  // content blockers filter by name.
  assert.deepEqual(manifest.host_permissions, ["<all_urls>", "https://shirabe.org/*", "https://cdn.shirabe.org/*", "https://t.shirabe.org/*"]);
  assert.equal(manifest.optional_host_permissions, undefined);
  assert.deepEqual(manifest.content_scripts, [{
    matches: ["<all_urls>"], js: ["content.js"], css: ["content.css"], all_frames: true, run_at: "document_idle",
  }]);
});
