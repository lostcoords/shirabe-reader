import assert from "node:assert/strict";
import test from "node:test";

// `host-rules.ts` pulls in `browser.ts`, which resolves `ext` at module init and
// throws without a WebExtension global. Stub it before importing, and import
// inside each test, rather than relying on some earlier test file having
// installed one first.
if (!(globalThis as { chrome?: unknown }).chrome) {
  (globalThis as { chrome?: unknown }).chrome = {
    runtime: { sendMessage: async () => ({ ok: true }), onMessage: { addListener() {} }, getURL: (path: string) => path },
    storage: { local: { get: async () => ({}), set: async () => {}, remove: async () => {} }, onChanged: { addListener() {} } },
  };
}
const load = () => import("../src/common/host-rules.js");

test("match patterns anchor the host instead of matching anywhere in the URL", async () => {
  const { matchUrl } = await load();
  // The reason this test exists: compiling the whole pattern to one regex turns
  // the leading "*" of "*://" into ".*", which eats any prefix and matches every
  // URL that merely *contains* the host — a redirect target, a share link, a
  // search result carrying the URL in its query string.
  assert.equal(matchUrl("*://example.com/*", "https://evil.test/?q=https://example.com/"), false);
  assert.equal(matchUrl("*://reader.ttsu.app/*", "https://evil.test/page?next=https://reader.ttsu.app/x"), false);
  assert.equal(matchUrl("*://shirabe.org/*", "https://evil.test/a?x=://shirabe.org/"), false);

  // Neighbouring hosts are not substring matches either.
  assert.equal(matchUrl("*://shirabe.org/*", "https://notshirabe.org/en"), false);
  assert.equal(matchUrl("*://*.shirabe.org/*", "https://evilshirabe.org/"), false);

  // A "*" scheme is web pages only — never file: or an extension origin.
  assert.equal(matchUrl("*://example.com/*", "file:///example.com/x"), false);
  assert.equal(matchUrl("*://example.com/*", "https://example.com/ok"), true);
});

test("match patterns still cover the hosts the built-in rules target", async () => {
  const { matchUrl } = await load();
  assert.equal(matchUrl("*://reader.ttsu.app/*", "https://reader.ttsu.app/b?id=1"), true);
  assert.equal(matchUrl("*://www.netflix.com/watch/*", "https://www.netflix.com/watch/12345"), true);
  // Path globs see the query string, so "/browse*" still matches "?jbv=".
  assert.equal(matchUrl("*://www.netflix.com/browse*", "https://www.netflix.com/browse?jbv=1"), true);
  assert.equal(matchUrl("*://www.youtube.com/*", "http://www.youtube.com/watch?v=1"), true);
  assert.equal(matchUrl("*://ja.wikipedia.org/*", "https://ja.wikipedia.org/wiki/日本語"), true);
  // "*.host" covers the bare host and any subdomain.
  assert.equal(matchUrl("*://*.shirabe.org/*", "https://shirabe.org/en"), true);
  assert.equal(matchUrl("*://*.shirabe.org/*", "https://www.shirabe.org/"), true);
  assert.equal(matchUrl("<all_urls>", "https://anything.test/x"), true);
});

test("a bare domain typed by the user becomes a host-anchored pattern", async () => {
  const { normalizePattern } = await load();
  assert.equal(normalizePattern("example.com"), "*://example.com/*");
  assert.equal(normalizePattern("  example.com  "), "*://example.com/*");
  assert.equal(normalizePattern("*://example.com/*"), "*://example.com/*");
  assert.equal(normalizePattern("<all_urls>"), "<all_urls>");
  assert.equal(normalizePattern(""), "");
});

test("turning the reader off for one site does not disable it on unrelated pages", async () => {
  const { BUILTIN_RULES, resolveHostMode } = await load();
  const disabledHosts = ["example.com"];
  const off = (url: string) => resolveHostMode(url, { disabledHosts, rules: BUILTIN_RULES }).mode;

  assert.equal(off("https://example.com/article"), "off");
  // The same URL appearing inside someone else's query string must not count.
  assert.equal(off("https://news.example.jp/story?ref=https://example.com/"), "auto");
  assert.equal(off("https://news.example.jp/story"), "auto");
});
