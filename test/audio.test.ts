import assert from "node:assert/strict";
import test from "node:test";
import { isR2AudioUrl } from "shirabe-sdk/word-card/audio.js";

test("only https clips under cdn.shirabe.org/audio/ are fetchable", () => {
  assert.equal(isR2AudioUrl(`https://cdn.shirabe.org/audio/${"a".repeat(64)}.m4a`), true);

  // This guard is the security boundary that stops a compromised content script
  // making the privileged background worker fetch an arbitrary URL, so every
  // part of it: scheme, host, path prefix: has to hold on its own.
  assert.equal(isR2AudioUrl("https://evil.example.com/audio/clip.m4a"), false, "wrong host");
  assert.equal(isR2AudioUrl("https://cdn.shirabe.org.evil.example.com/audio/clip.m4a"), false, "the CDN host is a prefix, not a match");
  assert.equal(isR2AudioUrl("http://cdn.shirabe.org/audio/clip.m4a"), false, "plain http is not the CDN");
  assert.equal(isR2AudioUrl("https://cdn.shirabe.org/packs/dictionary.ndjson.gz"), false, "outside /audio/");
  assert.equal(isR2AudioUrl("blob:https://cdn.shirabe.org/audio/clip.m4a"), false, "blob: is not https:");
  assert.equal(isR2AudioUrl("javascript:fetch('https://evil.example.com')"), false, "javascript: never reaches the fetch");

  // Nothing and nonsense are simply not clips.
  assert.equal(isR2AudioUrl(null), false);
  assert.equal(isR2AudioUrl(undefined), false);
  assert.equal(isR2AudioUrl(""), false);
  assert.equal(isR2AudioUrl("/audio/clip.m4a"), false, "a relative path has no origin to check");
});
