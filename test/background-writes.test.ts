import "fake-indexeddb/auto";
import assert from "node:assert/strict";
import test from "node:test";
import type { Request, Response as WorkerResponse } from "../src/common/messages.js";

// The background owns every write to Shirabe. It cannot be imported beside the
// other suites (it registers listeners and crash handlers on import), so this
// file is its own process: a connected, entitled reader, a fake server that
// records what reached it, and the worker's real message listener.

type Sent = { method: string; path: string; headers: Headers; body: unknown };

const sent: Sent[] = [];
const answers = new Map<string, (body: unknown) => Response>();
let listener: (request: Request, sender: object, respond: (response: WorkerResponse) => void) => unknown;

async function boot(): Promise<(request: Request) => Promise<WorkerResponse>> {
  const storage: Record<string, unknown> = {};
  const event = { addListener() {} };
  Object.assign(globalThis, {
    self: { addEventListener() {} },
    chrome: {
      runtime: {
        onMessage: { addListener(callback: typeof listener) { listener = callback; } },
        onConnect: event, onInstalled: event, getURL: (path: string) => path,
      },
      storage: {
        local: {
          get: async (key?: string) => (key ? { [key]: storage[key] } : storage),
          set: async (values: Record<string, unknown>) => { Object.assign(storage, values); },
          remove: async () => {},
        },
        onChanged: event,
      },
      tabs: { onRemoved: event, query: async () => [], sendMessage: async () => {} },
      scripting: { unregisterContentScripts: async () => {} },
      permissions: { contains: async () => false },
    },
  });
  const { DEFAULTS } = await import("../src/common/config.js");
  Object.assign(storage, { config: {
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
  await import("../src/background/background.js");
  return (request) => new Promise<WorkerResponse>((resolve) => {
    const result = listener(request, {}, resolve);
    if (result instanceof Promise) void result.then(resolve);
  });
}

const send = boot();
const json = (body: unknown, status = 200) => Response.json(body, { status });

test("Known keeps the whole word it answered, so a reopened card does not snap back", async () => {
  const worker = await send;
  answers.set("POST /api/v1/srs/states", () => json({
    word: { lemma: "橋", state: "retired", decks: [{ id: 7, name: "Reading pile" }], cardId: 41, cardCount: 1 },
  }));
  sent.length = 0;
  const known = await worker({ type: "setState", lemma: "橋", state: "retired", reading: "はし", entry: "jmdict:1489850", key: "known-1" });
  assert.ok(known.ok && known.type === "setState");
  assert.equal(sent.find(({ path }) => path === "/api/v1/srs/states")?.headers.get("Idempotency-Key"), "known-1");

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
