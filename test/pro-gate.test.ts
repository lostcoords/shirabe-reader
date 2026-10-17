import assert from "node:assert/strict";
import test from "node:test";

// The free/Pro line as the extension sees it: look up all you like, saving is
// bought (specs/browser-extension.md §1). The server answers a free account's
// save with 402 PRO_REQUIRED, and that has to arrive as an offer: not as a
// stack trace under the Save button, which is what a free user used to get.

const problem = (status: number, code: string, detail: string) => Response.json(
  { code, title: "Pro required", detail }, { status });

test("a 402 keeps the server's code and sentence, so the UI can offer plans", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => problem(402, "PRO_REQUIRED", "Writing to the SRS requires Pro.")) as unknown as typeof fetch;
  try {
    const { ApiError, ShirabeApi } = await import("../src/common/api.js");
    const api = new ShirabeApi({ apiBase: "https://shirabe.test", accessToken: "shra_test", accessTokenExpiresAt: new Date(Date.now() + 3_600_000).toISOString(), refreshToken: "shrr_test" } as never);

    const error = await api.save({ lemma: "勉強" }).then(() => null, (err: unknown) => err);

    assert.ok(error instanceof ApiError, "a refusal surfaces as ApiError");
    assert.equal(error.status, 402);
    assert.equal(error.code, "PRO_REQUIRED");
    assert.equal(error.message, "Writing to the SRS requires Pro.");
    assert.doesNotMatch(error.message, /stack|exception/i, "never a diagnostic dump");
  } finally {
    globalThis.fetch = original;
  }
});

test("needs-Pro is recognised by code or bare status, and nothing else is", async () => {
  const { isProRequired } = await import("../src/common/messages.js");

  assert.ok(isProRequired({ ok: false, error: "…", code: "PRO_REQUIRED", status: 402 }));
  assert.ok(isProRequired({ ok: false, error: "…", status: 402 }), "a 402 with no code still offers plans");
  assert.ok(!isProRequired({ ok: false, error: "…", code: "INSUFFICIENT_SCOPE", status: 403 }));
  assert.ok(!isProRequired({ ok: false, error: "Not connected.", status: 401 }));
  assert.ok(!isProRequired({ ok: false, error: "Request failed (500)." }));
});

test("the popup offers plans on a refusal instead of colouring it as an error", async () => {
  const { readFileSync } = await import("node:fs");
  const popup = readFileSync("node_modules/@shirabe-org/card/dist/word-card/card.js", "utf8");
  const actions = readFileSync("src/content/actions.ts", "utf8");

  assert.match(actions, /proRequired: true/, "the write actions flag the refusal");
  // The card asks its host where plans live: a host with no pricing page simply
  // does not answer, and the link stays inert rather than pointing at ours.
  const cardHost = readFileSync("src/content/card-host.ts", "utf8");
  assert.match(popup, /optional\(\)\.pricingUrl\?\.\("extension"\)/, "and the card asks for the plans link");
  assert.match(cardHost, /pricingUrl\(config\.apiBase, source\)/, "which the extension answers from its own config");
  assert.match(popup, /sb-error", !ok && !proRequired/, "a needs-Pro note is not painted as a failure");
});

test("every upgrade entry point tags itself, so none of them lands as organic traffic", async () => {
  const { readFileSync } = await import("node:fs");
  const { pricingUrl } = await import("../src/common/config.js");

  assert.equal(pricingUrl("https://shirabe.test/", "extension"), "https://shirabe.test/pricing?source=extension");

  // The word card, the toolbar popup, and the settings page each reach Pro from
  // a different moment; an untagged /pricing from any of them is a click the
  // funnel can't attribute (the web app tags the same way: pricing_path(source:)).
  // The word card builds its own link; the toolbar popup and the settings page
  // share one account card and declare the tag they mount it with.
  const wordCard = readFileSync("node_modules/@shirabe-org/card/dist/word-card/card.js", "utf8");
  assert.match(wordCard, /pricingUrl\?\.\("extension"\)/, "the word card must tag its upgrade link");
  const accountPanel = readFileSync("src/common/account-panel.ts", "utf8");
  assert.match(accountPanel, /pricingUrl\(apiBase, hooks\.pricingSource\)/, "the shared card must tag through its mount");
  for (const [file, source] of [
    ["src/action/popup.ts", "extension_popup"],
    ["src/options/options.ts", "extension_settings"],
  ] as const) {
    assert.match(readFileSync(file, "utf8"), new RegExp(`pricingSource: "${source}"`), `${file} must declare its source`);
  }
  for (const file of ["node_modules/@shirabe-org/card/dist/word-card/card.js", "src/action/popup.ts", "src/options/options.ts", "src/common/account-panel.ts"]) {
    assert.doesNotMatch(readFileSync(file, "utf8"), /\+ "\/pricing"/, `${file} must not hand-build an untagged pricing URL`);
  }
});

test("a signed-in free reader is told what's missing, and can act on it", async () => {
  const { Window } = await import("happy-dom");
  const window = new Window({ url: "https://reader.test/page" });
  const config = { apiBase: "https://shirabe.test", accessToken: "shra_x", accessTokenExpiresAt: new Date(Date.now() + 3_600_000).toISOString(), refreshToken: "shrr_x", scopes: ["user:study:read"], entitled: false };
  Object.assign(globalThis, {
    window, document: window.document, Node: window.Node, HTMLElement: window.HTMLElement,
    chrome: {
      runtime: { onMessage: { addListener() {} }, sendMessage: async () => ({ ok: true }) },
      storage: { local: { get: async () => ({ config }), set: async () => {} }, onChanged: { addListener() {} } },
    },
  });

  const { setCardHost, setWriteState, studyUnavailable } = await import("@shirabe-org/card/word-card");
  // The link resolves through the host, which is what a card with no host (an
  // anonymous Anki card, say) is entitled to leave inert.
  const { extensionHost } = await import("../src/content/card-host.js");
  setCardHost(extensionHost);

  // Signed in, no Pro: the controls are rightly absent, but what stands in for
  // them has to name the subscription and offer a way to buy it.
  setWriteState({ canWrite: false, connected: true });
  const offered = studyUnavailable();
  // Not a formality: `studyUnavailable` answers null for a surface that cannot
  // save at all, which is how an Anki card avoids offering an upgrade that
  // would not help it. The extension can save, so this reader is exactly who
  // the line is for and it has to be drawn.
  assert.ok(offered, "a signed-in free reader on a surface that saves gets the offer");
  await new Promise((resolve) => setTimeout(resolve, 0)); // the href resolves from stored config
  const link = offered.querySelector("a.sb-plans") as HTMLAnchorElement | null;

  assert.match(offered.textContent ?? "", /part of Pro/);
  assert.ok(link, "a signed-in free reader gets a way out, not just a sentence");
  // The host comes from stored config (pricingUrl is unit-tested above with an
  // explicit base); what matters here is that the link resolved and is tagged.
  assert.match(link.getAttribute("href") ?? "", /^https:\/\/[^/]+\/pricing\?source=extension$/);
  assert.equal(link.getAttribute("target"), "_blank");
  assert.equal(link.getAttribute("rel"), "noopener noreferrer");
  assert.doesNotMatch(offered.textContent ?? "", /Connect/, "never tell someone signed in to connect");

  // Anonymous is a different state: nothing to upgrade yet, so no plans link.
  setWriteState({ canWrite: false, connected: false });
  const anonymous = studyUnavailable();
  assert.ok(anonymous);
  const connect = anonymous.querySelector("button.sb-connect") as HTMLButtonElement | null;
  assert.equal(connect?.textContent, "Connect your account");
  assert.equal(anonymous.textContent, "Connect your account to see your dictionaries and save words");
  assert.equal(anonymous.querySelector(".sb-offline-mode"), null, "offline mode is named only for an offline lookup");
  const { readFileSync } = await import("node:fs");
  const content = readFileSync("src/content/content.ts", "utf8");
  assert.match(content, /historyNavigation: false/);
  assert.match(content, /showAuthoring: false/);
  assert.equal(anonymous.querySelector("a.sb-plans"), null, "nothing to upgrade until an account exists");
  // `ext` is bound at first import, so a later globalThis.chrome is not what send() calls.
  const { ext } = await import("../src/common/browser.js");
  const original = ext.runtime.sendMessage;
  const sent: unknown[] = [];
  ext.runtime.sendMessage = async (message: unknown) => {
    sent.push(message);
    return { ok: true };
  };
  try {
    connect?.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(sent, [{ type: "connect" }]);
    assert.equal(connect?.hidden, true);
  } finally {
    ext.runtime.sendMessage = original;
  }
});
