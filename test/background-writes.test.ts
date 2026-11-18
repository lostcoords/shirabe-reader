import "fake-indexeddb/auto";
import assert from "node:assert/strict";
import test from "node:test";
import type { Request, Response as WorkerResponse } from "../src/common/messages.js";
import { stubBackground } from "./support/background.js";

// The background owns every write to Shirabe: a connected, entitled reader, a
// fake server that records what reached it, and the worker's real message listener.

type Sent = { method: string; path: string; headers: Headers; body: unknown };

const sent: Sent[] = [];
const answers = new Map<string, (body: unknown) => Response>();

async function boot(): Promise<(request: Request) => Promise<WorkerResponse>> {
  const background = stubBackground();
  const { DEFAULTS } = await import("../src/common/config.js");
  Object.assign(background.storage, { config: {
    ...DEFAULTS, apiBase: "https://api.test", accessToken: "access-token",
    accessTokenExpiresAt: "2999-01-01T00:00:00Z", refreshToken: "refresh-token",
    scopes: ["user:profile:read", "user:dictionary:read", "user:study:read", "user:study:write"],
    entitled: true, account: "Reader", accountCheckedAt: new Date().toISOString(), errorReports: false,
  } });
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const path = new URL(request.url).pathname;
    const text = await request.text();
    const body = text ? JSON.parse(text) : undefined;
    sent.push({ method: request.method, path, headers: request.headers, body });
    const answer = answers.get(`${request.method} ${path}`);
    return answer ? answer(body) : new Response(null, { status: 503 });
  }) as typeof fetch;
  return background.start();
}

const send = boot();
const json = (body: unknown, status = 200) => Response.json(body, { status });

test("Known keeps the whole word it answered, so a reopened card does not snap back", async () => {
  const worker = await send;
  answers.set("POST /api/v1/srs/knowns", () => json({
    word: { lemma: "橋", state: "retired", decks: [{ id: 7, name: "Reading pile" }], cardId: 41, cardCount: 1 },
  }));
  sent.length = 0;
  const known = await worker({ type: "markKnown", lemma: "橋", reading: "はし", entry: "jmdict:1489850", key: "known-1" });
  assert.ok(known.ok && known.type === "markKnown");
  assert.equal(sent.find(({ path }) => path === "/api/v1/srs/knowns")?.headers.get("Idempotency-Key"), "known-1");

  sent.length = 0;
  const reopened = await worker({ type: "states", lemmas: ["橋"] });
  assert.ok(reopened.ok && reopened.type === "states");
  assert.equal(reopened.details["橋"]?.state, "retired", "the popup reads details first");
  assert.equal(reopened.details["橋"]?.cardId, 41);
  assert.deepEqual(sent.filter(({ path }) => path.startsWith("/api/v1/srs")), [], "answered from what Known just returned");
});

test("Ignore reaches the server's list and the word reads as ignored without asking again", async () => {
  const worker = await send;
  answers.set("POST /api/v1/srs/word-ignores", (body) => json({ ignore: body }, 201));
  sent.length = 0;
  const ignored = await worker({ type: "ignore", lemma: "田中", reading: "たなか", key: "ignore-1" });
  assert.ok(ignored.ok && ignored.type === "ignore");
  assert.deepEqual(sent.map(({ method, path, headers, body }) => ({ method, path, key: headers.get("Idempotency-Key"), body })),
    [{ method: "POST", path: "/api/v1/srs/word-ignores", key: "ignore-1", body: { text: "田中", reading: "たなか" } }]);

  sent.length = 0;
  const states = await worker({ type: "states", lemmas: ["田中"] });
  assert.ok(states.ok && states.type === "states");
  assert.equal(states.states["田中"], "ignored");
  assert.deepEqual(sent, []);
});

test("taking Known back keeps the word the server answered, the card it purged gone with it", async () => {
  const worker = await send;
  answers.set("DELETE /api/v1/srs/knowns", () => json({ word: { lemma: "橋", state: "none", decks: [] } }));
  sent.length = 0;
  const taken = await worker({ type: "unmarkKnown", lemma: "橋", reading: "はし", entry: "jmdict:1489850" });
  assert.ok(taken.ok && taken.type === "unmarkKnown");
  assert.deepEqual(sent.map(({ method, path, body }) => ({ method, path, body })),
    [{ method: "DELETE", path: "/api/v1/srs/knowns", body: { lemma: "橋", reading: "はし", dictionarySlug: "jmdict", sourceId: "1489850" } }]);

  sent.length = 0;
  const reopened = await worker({ type: "states", lemmas: ["橋"] });
  assert.ok(reopened.ok && reopened.type === "states");
  assert.deepEqual(reopened.details["橋"], { state: "none", decks: [] });
  assert.deepEqual(sent, []);
});

test("stopping ignoring a word lifts it on the server, and the word reads as unsaved", async () => {
  const worker = await send;
  answers.set("DELETE /api/v1/srs/word-ignores", () => new Response(null, { status: 204 }));
  sent.length = 0;
  const lifted = await worker({ type: "unignore", lemma: "田中", reading: "たなか" });
  assert.ok(lifted.ok && lifted.type === "unignore");
  assert.deepEqual(sent.map(({ method, path, body }) => ({ method, path, body })),
    [{ method: "DELETE", path: "/api/v1/srs/word-ignores", body: { text: "田中", reading: "たなか" } }]);

  sent.length = 0;
  const states = await worker({ type: "states", lemmas: ["田中"] });
  assert.ok(states.ok && states.type === "states");
  assert.equal(states.states["田中"], "none");
  assert.deepEqual(sent, []);
});

// Ignore used to live only in the reader's cache: the next parse answered the
// word as `none` and the page marked it again.
test("an ignored word stays ignored when the page is parsed again", async () => {
  const worker = await send;
  answers.set("POST /api/v1/srs/word-ignores", (body) => json({ ignore: body }, 201));
  await worker({ type: "ignore", lemma: "田中", reading: "たなか", key: "ignore-2" });
  answers.set("POST /api/v1/parse", () => json({
    packRevision: "r", stackFingerprint: "f", sources: ["jmdict:en"],
    results: [{ tokens: [
      { startOffset: 0, endOffset: 2, surface: "田中", lemma: "田中", reading: "たなか", kind: "word", study: { state: "ignored", decks: [] } },
    ] }],
  }));

  const parsed = await worker({ type: "parseBatchOnline", texts: ["田中"] });
  assert.ok(parsed.ok && parsed.type === "parseBatchOnline");
  assert.equal(parsed.tokens[0]?.[0]?.state, "ignored");
  const opened = await worker({ type: "states", lemmas: ["田中"] });
  assert.ok(opened.ok && opened.type === "states");
  assert.equal(opened.details["田中"]?.state, "ignored");
});

test("a save that kept its line but not its clip says so, and why", async () => {
  const worker = await send;
  answers.set("POST /api/v1/srs/saves", () => json({
    card: { id: 6 }, created: true, mediaError: "The audio clip is longer than 30 seconds.",
    word: { lemma: "猫", state: "new", decks: [{ id: 1, name: "Saved words" }] },
  }, 201));
  const saved = await worker({ type: "save", lemma: "猫", reading: "ねこ", key: "save-media" });
  assert.ok(saved.ok && saved.type === "save");
  assert.equal(saved.result.mediaError, "The audio clip is longer than 30 seconds.");
});

// A save into a deck typed by name used to post the name with the save, and the
// server made a deck on every attempt. The deck endpoint answers a repeated key
// with the deck it already made, so saving again after a failure finds it.
test("a new deck is made once under the save's key, and saving again after a failure lands in it", async () => {
  const worker = await send;
  const deck = { id: 12, name: "Immersion", visibility: "personal", counts: { total: 0, new: 0, due: 0, learning: 0, review: 0 } };
  answers.set("POST /api/v1/srs/decks", () => json({ deck }, 201));
  answers.delete("POST /api/v1/srs/saves");
  sent.length = 0;
  const save = { type: "save", lemma: "高い", reading: "たかい", newDeckName: "Immersion", key: "form-1" } as const;
  const failed = await worker(save);
  assert.equal(failed.ok, false, "the save itself answered 503");

  answers.set("POST /api/v1/srs/saves", () => json({
    card: { id: 5 }, created: true, word: { lemma: "高い", state: "new", decks: [{ id: 12, name: "Immersion" }] },
  }, 201));
  const saved = await worker(save);
  assert.ok(saved.ok && saved.type === "save");

  const writes = sent.map(({ method, path, headers, body }) => ({ method, path, key: headers.get("Idempotency-Key"), body }));
  const created = { method: "POST", path: "/api/v1/srs/decks", key: "form-1", body: { name: "Immersion" } };
  const into = { method: "POST", path: "/api/v1/srs/saves", key: "form-1", body: { lemma: "高い", reading: "たかい", deckId: 12 } };
  assert.deepEqual(writes, [created, into, created, into], "both attempts are the same two requests");

  answers.set("GET /api/v1/srs/decks", () => json({ decks: [deck] }));
  sent.length = 0;
  const decks = await worker({ type: "decks" });
  assert.ok(decks.ok && decks.type === "decks");
  assert.deepEqual(decks.decks.map(({ id }) => id), [12]);
  assert.deepEqual(sent.map(({ method, path }) => `${method} ${path}`), ["GET /api/v1/srs/decks"], "the next form lists the deck it made");
});

// Marks used to cost two requests a batch: the cut, then a lookup of every word
// in it. The cut carries each word's state when asked, and the popup that opens
// on one of those words reads what it said.
test("a parse asks for study states, and opening a parsed word asks nothing more", async () => {
  const worker = await send;
  const study = { state: "learning", decks: [{ id: 7, name: "Reading pile" }], cardId: 41, cardCount: 1, savedSenses: ["jmdict#0"] };
  answers.set("POST /api/v1/parse", () => json({
    packRevision: "r", stackFingerprint: "f", sources: ["jmdict:en"],
    results: [{ tokens: [
      { startOffset: 0, endOffset: 1, surface: "猫", lemma: "猫", reading: "ねこ", kind: "word", study },
      { startOffset: 1, endOffset: 2, surface: "が", lemma: "が", kind: "particle" },
    ] }],
  }));
  sent.length = 0;
  const parsed = await worker({ type: "parseBatchOnline", texts: ["猫が"] });
  assert.ok(parsed.ok && parsed.type === "parseBatchOnline");
  assert.equal(parsed.studied, true);
  assert.equal(parsed.tokens[0]?.[0]?.state, "learning");
  assert.deepEqual(sent.map(({ method, path, body }) => ({ method, path, body })),
    [{ method: "POST", path: "/api/v1/parse", body: { texts: ["猫が"], include: ["study"] } }]);

  sent.length = 0;
  const opened = await worker({ type: "states", lemmas: ["猫"] });
  assert.ok(opened.ok && opened.type === "states");
  assert.deepEqual(opened.details["猫"], { state: "learning", decks: [{ id: 7, name: "Reading pile" }], cardId: 41, cardCount: 1, savedSenses: ["jmdict#0"] });
  assert.deepEqual(sent, []);
});
