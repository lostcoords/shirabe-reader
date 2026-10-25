import assert from "node:assert/strict";
import test from "node:test";
import type { ParsedToken } from "../src/common/types.js";

function token(surface: string, start: number): ParsedToken {
  return { start, length: surface.length, surface, lemma: surface, reading: null, pos: "noun", content: true, state: "none",
    components: [{ surface, start, end: start + surface.length, lemma: surface, pos: ["noun"] }] } as ParsedToken;
}

async function withMessages(answer: (message: { type: string; texts?: string[] }) => unknown, run: () => Promise<void>) {
  const { ext } = await import("../src/common/browser.js");
  const original = ext.runtime.sendMessage;
  ext.runtime.sendMessage = (async (message: { type: string; texts?: string[] }) => answer(message)) as typeof ext.runtime.sendMessage;
  try {
    await run();
  } finally {
    ext.runtime.sendMessage = original;
  }
}

test("a long paragraph is cut at sentence ends and rebuilds exactly", async () => {
  const { splitForMarks } = await import("../src/content/parser.js");
  const sentence = "吾輩は猫である。";
  const text = sentence.repeat(200);

  const pieces = splitForMarks(text);

  assert.equal(pieces.join(""), text);
  assert.ok(pieces.length > 1);
  for (const piece of pieces) {
    assert.ok(piece.length <= 500, `${piece.length} characters`);
    assert.ok(piece.endsWith("。"), "every piece ends on a sentence");
  }
});

test("text with no sentence end still fits, without halving a character", async () => {
  const { splitForMarks } = await import("../src/content/parser.js");
  const text = "猫".repeat(499) + "𠮷" + "猫".repeat(600);

  const pieces = splitForMarks(text);

  assert.equal(pieces.join(""), text);
  assert.ok(pieces.every((piece) => piece.length <= 500));
  assert.ok(pieces.every((piece) => !/[\ud800-\udbff]$/.test(piece)), "a piece never ends on half a surrogate pair");
});

test("marks for a split paragraph land where the words are on the page", async () => {
  const { requestMarks, splitForMarks } = await import("../src/content/parser.js");
  const text = "吾輩は猫である。".repeat(100);
  const firstPiece = splitForMarks(text)[0]!;

  await withMessages((message) => ({ ok: true, type: "parseBatchOnline", accepted: true,
    tokens: (message.texts ?? []).map(() => [token("吾輩", 0)]) }), async () => {
    const [tokens] = (await requestMarks([text]))!;
    assert.equal(tokens![0]!.start, 0);
    assert.equal(tokens![1]!.start, firstPiece.length);
    assert.equal(tokens![1]!.components![0]!.start, firstPiece.length);
    assert.equal(text.slice(tokens![1]!.start, tokens![1]!.start + 2), "吾輩");
  });
});

test("a tab sends one parse at a time", async () => {
  const { requestMarks } = await import("../src/content/parser.js");
  let inFlight = 0;
  let most = 0;

  await withMessages(async (message) => {
    inFlight += 1;
    most = Math.max(most, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 5));
    inFlight -= 1;
    return { ok: true, type: "parseBatchOnline", accepted: true, tokens: (message.texts ?? []).map(() => []) };
  }, async () => {
    await Promise.all([requestMarks(["猫"]), requestMarks(["犬"]), requestMarks(["鳥".repeat(1200)])]);
  });

  assert.equal(most, 1);
});

test("text nothing on screen wants is never sent", async () => {
  const { requestMarks } = await import("../src/content/parser.js");
  let sent = 0;

  await withMessages(() => { sent += 1; return { ok: true, accepted: true, tokens: [] }; }, async () => {
    assert.equal(await requestMarks(["猫"], () => false), null);
  });

  assert.equal(sent, 0);
});

test("a refusal carries how long Shirabe asked to wait", async () => {
  const { requestMarks } = await import("../src/content/parser.js");

  await withMessages(() => ({ ok: true, type: "parseBatchOnline", accepted: false, tokens: [], retryAfter: 15 }), async () => {
    await assert.rejects(requestMarks(["猫"]), (error: { retryAfter?: number }) => error.retryAfter === 15);
  });
});

test("only a connected reader who shares page text can mark words", async () => {
  const { canMarkWords, DEFAULTS } = await import("../src/common/config.js");
  const account = { ...DEFAULTS, refreshToken: "token", scopes: ["user:dictionary:read"] };

  assert.equal(canMarkWords(DEFAULTS), false, "signed out");
  assert.equal(canMarkWords(account), true);
  assert.equal(canMarkWords({ ...account, localOnlyAnalysis: true }), false, "kept page text on this device");
  assert.equal(canMarkWords({ ...account, scopes: [] }), false, "connected without the parse scope");
});

test("reading apps and the reader's own sites mark without asking, other pages wait for the command", async () => {
  const { BUILTIN_RULES, marksWithoutAsking, resolveHostMode } = await import("../src/common/host-rules.js");
  const ruleFor = (url: string) => resolveHostMode(url, { disabledHosts: [], rules: BUILTIN_RULES }).rule;

  assert.equal(marksWithoutAsking("https://example.com/a", ruleFor("https://example.com/a"), []), false);
  assert.equal(marksWithoutAsking("https://example.com/a", undefined, ["example.com"]), true);
  const aozora = "https://www.aozora.gr.jp/cards/000148/files/789_14547.html";
  assert.equal(marksWithoutAsking(aozora, ruleFor(aozora), []), true);
  const wikipedia = "https://ja.wikipedia.org/wiki/猫";
  assert.equal(marksWithoutAsking(wikipedia, ruleFor(wikipedia), []), false, "a common site stays on the command");
  assert.equal(ruleFor("https://www.youtube.com/watch?v=x")?.marks, undefined, "captions keep their own handling");
});

test("a connected parse refused with Retry-After reports it", async () => {
  const originalFetch = globalThis.fetch;
  const originalChrome = globalThis.chrome;
  Object.assign(globalThis, { chrome: originalChrome ?? {
    runtime: { id: "reader-test" },
    storage: { local: { get: async () => ({}) }, onChanged: { addListener() {} } },
  } });
  globalThis.fetch = (async () => new Response(JSON.stringify({ code: "BUSY", detail: "Busy" }), {
    status: 429, headers: { "Content-Type": "application/problem+json", "Retry-After": "15" },
  })) as typeof fetch;
  try {
    const { ParseRefused, ShirabeApi } = await import("../src/common/api.js");
    const { DEFAULTS } = await import("../src/common/config.js");
    const api = new ShirabeApi({ ...DEFAULTS, apiBase: "https://shirabe.test", refreshToken: "refresh", accessToken: "access",
      accessTokenExpiresAt: new Date(Date.now() + 3_600_000).toISOString(), scopes: ["user:dictionary:read"] });

    await assert.rejects(api.parseWithProvenance(["猫"]), (error) => error instanceof ParseRefused && error.retryAfter === 15);
  } finally {
    globalThis.fetch = originalFetch;
    Object.assign(globalThis, { chrome: originalChrome });
  }
});
