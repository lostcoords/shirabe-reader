import assert from "node:assert/strict";
import test from "node:test";
import { installWindow } from "./support/dom.js";
import type { Request as MessageRequest } from "../src/common/messages.js";

// A saved word has to arrive at /api/v1 with the entry it came from. The pack cites
// an entry as one handle ("jmdict:2517580"); the API links a card by the pair
// (dictionarySlug, sourceId). Getting that translation wrong is silent: the
// save still succeeds, it just lands an orphan card (docs/specs/srs.md §1.1),
// which is what every Reader card used to be.

async function postedBody(options: { lemma: string; entry?: string }): Promise<Record<string, unknown>> {
  const save = { ...options, key: "save-1" };
  const original = globalThis.fetch;
  let body: Record<string, unknown> = {};
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    body = await request.json() as Record<string, unknown>;
    return new Response(
      JSON.stringify({ card: { id: 1 }, created: true, word: { lemma: options.lemma, state: "new", decks: [] } }),
      { headers: { "Content-Type": "application/json" } },
    );
  }) as unknown as typeof fetch;
  try {
    const { ShirabeApi } = await import("../src/common/api.js");
    await new ShirabeApi({ apiBase: "https://shirabe.test", accessToken: "shra_test", accessTokenExpiresAt: new Date(Date.now() + 3_600_000).toISOString(), refreshToken: "shrr_test" } as never).save(save);
    return body;
  } finally {
    globalThis.fetch = original;
  }
}

test("a save posts the entry as the (dictionarySlug, sourceId) pair /api/v1 links by", async () => {
  const body = await postedBody({ lemma: "変わる", entry: "jmdict:1207590" });

  assert.equal(body.dictionarySlug, "jmdict");
  assert.equal(body.sourceId, "1207590");
  assert.equal(body.entry, undefined, "the packed handle is a client shape: the wire takes the pair");
  assert.equal(body.key, undefined, "the retry key travels as a header");
});

test("a source id may carry colons of its own; the slug never does", async () => {
  const body = await postedBody({ lemma: "田中", entry: "jmnedict:name:5041233" });

  assert.equal(body.dictionarySlug, "jmnedict");
  assert.equal(body.sourceId, "name:5041233");
});

test("a quick save links the card even when the word's popup never opened", async () => {
  // The popup stamps the entry it resolved. But a shortcut fires on the HOVERED
  // word, and in modifier mode nothing looked it up. Keyboard mining is the fast
  // path through a page, so it cannot be the one that lands orphans.
  const window = installWindow({ frames: true });
  const sent: MessageRequest[] = [];
  const { ext } = await import("../src/common/browser.js");
  ext.runtime.sendMessage = (async (message: MessageRequest) => {
    sent.push(message);
    if (message.type === "lookup") {
      return { ok: true, type: "lookup", definition: { headword: "変わる", entry: "jmdict:1207590", senses: [] } };
    }
    return { ok: true, type: "save", result: { state: "new", created: true, decks: [] } };
  }) as typeof ext.runtime.sendMessage;

  const { save } = await import("../src/content/actions.js");
  const word = window.document.createElement("span") as unknown as HTMLElement;
  word.dataset.lemma = "変わる";
  window.document.body.append(word as never);

  await save(word);

  const request = sent.find((message) => message.type === "save") as Extract<MessageRequest, { type: "save" }>;
  assert.equal(request.entry, "jmdict:1207590", "the save asks for the entry it wasn't given");
  assert.equal(word.dataset.entry, "jmdict:1207590", "and remembers it, so a re-save doesn't ask again");
});

test("a word with no entry saves as free text rather than half a handle", async () => {
  // Nothing to link to (the word was never looked up, or came from a pack older
  // than the id). Posting a slug with no source id would link nothing anyway,
  // and a half-filled pair is the shape that invites a bogus match.
  for (const entry of [undefined, "", "jmdict", "jmdict:", ":1207590"]) {
    const body = await postedBody({ lemma: "変わる", entry });
    assert.equal(body.dictionarySlug, undefined, `"${entry}" is not a handle`);
    assert.equal(body.sourceId, undefined, `"${entry}" is not a handle`);
    assert.equal(body.lemma, "変わる", "the save still goes through: an orphan card beats no card");
  }
});

// Known used to post the bare spelling. The server then retired every card of
// every homograph (はし the bridge with はし the chopsticks), and an unsaved word
// got a card linked to no entry, in no chosen deck.
test("Known and taking it back post the word's reading and entry, the identity a save sends", async () => {
  const original = globalThis.fetch;
  const requests: Array<{ method: string; path: string; key: string | null; body: unknown }> = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    requests.push({ method: request.method, path: new URL(request.url).pathname, key: request.headers.get("Idempotency-Key"), body: await request.json() });
    const state = request.method === "DELETE" ? "none" : "retired";
    return Response.json({ word: { lemma: "橋", state, decks: state === "none" ? [] : [{ id: 7, name: "Reading pile" }] } });
  }) as typeof fetch;
  try {
    const { ShirabeApi } = await import("../src/common/api.js");
    const { DEFAULTS } = await import("../src/common/config.js");
    const api = new ShirabeApi({ ...DEFAULTS, apiBase: "https://shirabe.test", accessToken: "shra_test", refreshToken: "shrr_test", accessTokenExpiresAt: new Date(Date.now() + 3_600_000).toISOString() });
    const known = await api.markKnown({ lemma: "橋", reading: "はし", entry: "jmdict:1489850", deckId: 7, key: "known-1" });
    assert.equal(known.state, "retired");
    const taken = await api.unmarkKnown({ lemma: "橋", reading: "はし", entry: "jmdict:1489850" });
    assert.equal(taken.state, "none");
    const word = { lemma: "橋", reading: "はし", dictionarySlug: "jmdict", sourceId: "1489850" };
    assert.deepEqual(requests, [
      { method: "POST", path: "/api/v1/srs/knowns", key: "known-1", body: { ...word, deckId: 7 } },
      { method: "DELETE", path: "/api/v1/srs/knowns", key: null, body: word },
    ]);
  } finally {
    globalThis.fetch = original;
  }
});

test("Known on a word whose popup never opened asks for its entry, as a save does", async () => {
  const window = installWindow({ frames: true });
  const sent: MessageRequest[] = [];
  const { ext } = await import("../src/common/browser.js");
  ext.runtime.sendMessage = (async (message: MessageRequest) => {
    sent.push(message);
    if (message.type === "lookup") {
      return { ok: true, type: "lookup", definition: { headword: "橋", entry: "jmdict:1489850", senses: [] } };
    }
    return { ok: true, type: "markKnown", details: { state: "retired", decks: [] } };
  }) as typeof ext.runtime.sendMessage;

  const { markKnown } = await import("../src/content/actions.js");
  const word = window.document.createElement("span") as unknown as HTMLElement;
  word.dataset.lemma = "橋";
  word.dataset.reading = "はし";
  window.document.body.append(word as never);

  assert.equal((await markKnown(word)).ok, true);

  const request = sent.find((message) => message.type === "markKnown") as Extract<MessageRequest, { type: "markKnown" }>;
  assert.equal(request.reading, "はし", "the reading keeps the chopsticks' card out of it");
  assert.equal(request.entry, "jmdict:1489850", "an unsaved word's new card links to its entry");
});

test("Ignore posts the word as text with its reading, and the page stops marking it", async () => {
  const original = globalThis.fetch;
  const requests: Array<{ path: string; key: string | null; body: unknown }> = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    requests.push({ path: new URL(request.url).pathname, key: request.headers.get("Idempotency-Key"), body: await request.json() });
    return Response.json({ ignore: { text: "田中", reading: "たなか" } }, { status: 201 });
  }) as typeof fetch;
  try {
    const { ShirabeApi } = await import("../src/common/api.js");
    const { DEFAULTS } = await import("../src/common/config.js");
    const api = new ShirabeApi({ ...DEFAULTS, apiBase: "https://shirabe.test", accessToken: "shra_test", refreshToken: "shrr_test", accessTokenExpiresAt: new Date(Date.now() + 3_600_000).toISOString() });
    await api.ignore({ lemma: "田中", reading: "たなか", key: "ignore-1" });
    assert.deepEqual(requests, [{ path: "/api/v1/srs/word-ignores", key: "ignore-1", body: { text: "田中", reading: "たなか" } }]);
  } finally {
    globalThis.fetch = original;
  }

  const window = installWindow();
  const { ext } = await import("../src/common/browser.js");
  const sent: MessageRequest[] = [];
  ext.runtime.sendMessage = (async (message: MessageRequest) => {
    sent.push(message);
    return { ok: true, type: "ignore" };
  }) as typeof ext.runtime.sendMessage;
  const { ignore } = await import("../src/content/actions.js");
  const word = window.document.createElement("span") as unknown as HTMLElement;
  word.dataset.lemma = "田中";
  word.dataset.reading = "たなか";
  word.dataset.state = "none";
  assert.equal((await ignore(word)).ok, true);
  const [{ key, ...request }] = sent as Array<Extract<MessageRequest, { type: "ignore" }>>;
  assert.deepEqual([request], [{ type: "ignore", lemma: "田中", reading: "たなか" }]);
  assert.match(key, /^[0-9a-f]{32}$/);
  assert.equal(word.dataset.state, "ignored");
});

test("a save that kept its line but not its clip tells the reader, and why", async () => {
  const window = installWindow({ frames: true });
  const { ext } = await import("../src/common/browser.js");
  ext.runtime.sendMessage = (async (message: MessageRequest) => {
    if (message.type === "lookup") return { ok: true, type: "lookup", definition: null };
    if (message.type === "captureTab") return { ok: false, error: "no tab" };
    return { ok: true, type: "save", result: { state: "new", created: true, decks: [], mediaError: "The screenshot is not an image." } };
  }) as typeof ext.runtime.sendMessage;
  const { save } = await import("../src/content/actions.js");
  const word = window.document.createElement("span") as unknown as HTMLElement;
  word.dataset.lemma = "猫";
  window.document.body.append(word as never);

  const outcome = await save(word);

  assert.equal(outcome.ok, true);
  assert.equal(outcome.message, "Saved 猫. Saved without the clip or screenshot: The screenshot is not an image.");
});

test("Not known and Stop ignoring take back what was set, and a card Known made is forgotten with it", async () => {
  const window = installWindow({ frames: true });
  const { ext } = await import("../src/common/browser.js");
  const sent: MessageRequest[] = [];
  ext.runtime.sendMessage = (async (message: MessageRequest) => {
    sent.push(message);
    if (message.type === "lookup") return { ok: true, type: "lookup", definition: { headword: "橋", entry: "jmdict:1489850", senses: [] } };
    if (message.type === "unmarkKnown") return { ok: true, type: "unmarkKnown", details: { state: "none", decks: [] } };
    return { ok: true, type: "unignore", details: { state: "none", decks: [] } };
  }) as typeof ext.runtime.sendMessage;
  const { unignore, unmarkKnown } = await import("../src/content/actions.js");
  const word = window.document.createElement("span") as unknown as HTMLElement;
  Object.assign(word.dataset, { lemma: "橋", reading: "はし", state: "retired", cardId: "41", cardUrl: "https://shirabe.test/study/cards?card_id=41" });
  window.document.body.append(word as never);

  assert.equal((await unmarkKnown(word)).ok, true);
  assert.equal(word.dataset.state, "none");
  assert.equal(word.dataset.cardId, undefined, "the card Known made is gone");
  assert.equal(word.dataset.cardUrl, undefined);

  word.dataset.state = "ignored";
  assert.equal((await unignore(word)).ok, true);
  assert.equal(word.dataset.state, "none");

  const writes = sent.filter((message) => message.type !== "lookup");
  assert.deepEqual(writes, [
    { type: "unmarkKnown", lemma: "橋", reading: "はし", entry: "jmdict:1489850" },
    { type: "unignore", lemma: "橋", reading: "はし" },
  ]);
});

// The card offers Ignore only on an unsaved word. The shortcut used to ignore
// any word: the server kept answering a saved one by its cards, while the page
// painted it ignored and then offered Stop ignoring on a word with cards.
test("the ignore shortcut ignores only an unsaved word and lifts only an ignored one", async () => {
  const window = installWindow();
  const { ext } = await import("../src/common/browser.js");
  const sent: MessageRequest[] = [];
  ext.runtime.sendMessage = (async (message: MessageRequest) => {
    sent.push(message);
    return message.type === "ignore" ? { ok: true, type: "ignore" } : { ok: true, type: "unignore", details: { state: "none", decks: [] } };
  }) as typeof ext.runtime.sendMessage;
  const { toggleIgnore } = await import("../src/content/actions.js");
  const word = window.document.createElement("span") as unknown as HTMLElement;
  Object.assign(word.dataset, { lemma: "猫", reading: "ねこ" });

  for (const state of ["new", "learning", "due", "suspended", "retired"]) {
    word.dataset.state = state;
    const outcome = await toggleIgnore(word);
    assert.equal(outcome.ok, false, `a ${state} word is not ignored`);
    assert.equal(word.dataset.state, state);
  }
  assert.deepEqual(sent, [], "a saved word sends nothing");

  word.dataset.state = "none";
  assert.equal((await toggleIgnore(word)).ok, true);
  assert.equal(word.dataset.state, "ignored");
  assert.equal((await toggleIgnore(word)).ok, true);
  assert.equal(word.dataset.state, "none");
  assert.deepEqual(sent.map(({ type }) => type), ["ignore", "unignore"]);
});
