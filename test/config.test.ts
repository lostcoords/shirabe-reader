import assert from "node:assert/strict";
import test from "node:test";
import { ensureChrome } from "./support/dom.js";

ensureChrome();

test("exported settings carry preferences and never a sign-in", async () => {
  const { DEFAULTS, shareableConfig } = await import("../src/common/config.js");
  const signedIn = {
    ...DEFAULTS, accessToken: "access", accessTokenExpiresAt: "2999-01-01T00:00:00Z", accessTokenRefreshAt: "2998-01-01T00:00:00Z",
    refreshToken: "refresh", account: "Reader", accountCheckedAt: "2026-01-01T00:00:00Z", scopes: ["user:study:write"], entitled: true,
    dictionaryStackFingerprint: "a".repeat(16), dictionaryStackDirty: true, dictionaryNames: { jmdict: "JMdict" },
    availableDictionaries: [{ slug: "jmdict", name: "JMdict", languages: ["eng"] }], furiganaMode: "off" as const,
  };
  const exported = shareableConfig(signedIn);
  const secrets = ["accessToken", "accessTokenExpiresAt", "accessTokenRefreshAt", "refreshToken", "account", "accountCheckedAt",
    "scopes", "entitled", "dictionaryStackFingerprint", "dictionaryStackDirty", "dictionaryNames", "availableDictionaries"];
  for (const key of secrets) {
    assert.ok(!(key in exported), `${key} would be written into an exported settings file`);
  }
  assert.equal(exported.furiganaMode, "off");
  assert.equal(Object.keys(exported).length, Object.keys(signedIn).length - secrets.length, "every preference survives the export");
});
