import assert from "node:assert/strict";
import test from "node:test";
import type { Request } from "../src/common/messages.js";

// A saved word has to arrive at /api/v1 with the entry it came from. The pack cites
// an entry as one handle ("jmdict:2517580"); the API links a card by the pair
// (dictionarySlug, sourceId). Getting that translation wrong is silent: the
// save still succeeds, it just lands an orphan card (docs/specs/srs.md §1.1),
// which is what every Reader card used to be.

async function postedBody(options: { lemma: string; entry?: string }): Promise<Record<string, unknown>> {
  const original = globalThis.fetch;
  let body: Record<string, unknown> = {};
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    body = JSON.parse(String(init?.body));
    return new Response(
      JSON.stringify({ card: { id: 1 }, created: true, word: { lemma: options.lemma, state: "new", decks: [] } }),
      { headers: { "Content-Type": "application/json" } },
    );
  }) as unknown as typeof fetch;
  try {
    const { ShirabeApi } = await import("../src/common/api.js");
    await new ShirabeApi({ apiBase: "https://shirabe.test", apiKey: "shr_test" } as never).save(options);
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
  const { Window } = await import("happy-dom");
  const window = new Window({ url: "https://reader.test/page" });
  const sent: Request[] = [];
  Object.assign(globalThis, {
    window, document: window.document, HTMLElement: window.HTMLElement,
    // The content bundle schedules its render work on a frame; nothing here waits
    // on one, so a plain task is enough to let the modules load.
    requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0) as unknown as number,
    cancelAnimationFrame: (handle: number) => clearTimeout(handle),
    chrome: globalThis.chrome ?? { runtime: { id: "test", sendMessage: async () => ({ ok: true }) } },
  });
  const { ext } = await import("../src/common/browser.js");
  ext.runtime.sendMessage = (async (message: Request) => {
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

  const request = sent.find((message) => message.type === "save") as Extract<Request, { type: "save" }>;
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
