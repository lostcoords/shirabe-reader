import assert from "node:assert/strict";
import test from "node:test";
import type { Definition, ParsedToken } from "../src/common/types.js";
import type { Request } from "../src/common/messages.js";

// The picker, and the reason it exists: きみ is 君, 黄身 or 黍, and only the
// reader knows which they meant. Every rung the parser could climb has been
// climbed, so the last word belongs to the person reading.
//
// What these pin is not how it looks. It is that **the pick is what gets
// carded**: choosing writes `dataset.entry`, which `actions.entryFor` reads and
// the save posts as `dictionarySlug` + `sourceId`. Without that the save
// re-derives the word from the lemma and can land on the one just rejected.
//
// ONE page for the whole file, because the popup is one reused shell held in
// module state: a second window would render into the first one's shadow root
// and every assertion after it would be about an element nobody can see.

const HOST = "https://reader.test/page";

// The popup renders after an async round trip (and a pick after a second one),
// so a test lets the queue drain rather than assuming one tick.
const settle = async () => { for (let index = 0; index < 5; index += 1) await new Promise((resolve) => setTimeout(resolve, 0)); };

function definition(entry: string, headword: string, reading: string, gloss: string): Definition {
  return {
    headword, reading, url: `https://shirabe.org/word/${headword}`, entry,
    senses: [ { position: 0, source: "English · JMdict", partsOfSpeech: [ "Noun" ], tags: [], glosses: [ gloss ] } ],
    pitch: [], examples: [],
  } as unknown as Definition;
}

const candidate = (entry: string, headword: string, reading: string) => ({ entry, headword, reading, common: true });

// What the background worker would answer, keyed by the question asked, so a
// test can assert on what was ASKED as well as on what rendered.
const answers: Record<string, Definition | null> = {
  "lookup:きみ": definition("jmdict:1226580", "きみ", "きみ", "millet"),
  "entry:jmdict:1247250": definition("jmdict:1247250", "君", "きみ", "you"),
  "lookup:きみ2": definition("jmdict:1226580", "きみ", "きみ", "millet"),
  "lookup:本": definition("jmdict:1522150", "本", "ほん", "book"),
};
const asked: Request[] = [];

type Page = {
  window: { document: Document };
  word: typeof import("../src/content/word.js");
  popup: typeof import("../src/content/popup.js");
};

// Built on first use, not at import: the suite bundles to CJS, where a
// top-level await will not compile.
let pending: Promise<Page> | null = null;
const page = (): Promise<Page> => (pending ??= buildPage());

async function buildPage(): Promise<Page> {
  const { Window } = await import("happy-dom");
  const window = new Window({ url: HOST });
  Object.assign(globalThis, {
    window, document: window.document, HTMLElement: window.HTMLElement,
    Node: window.Node, DOMRect: window.DOMRect, getComputedStyle: window.getComputedStyle.bind(window),
    chrome: globalThis.chrome ?? { runtime: { id: "test", sendMessage: async () => ({ ok: true }) } },
  });

  const { ext } = await import("../src/common/browser.js");
  ext.runtime.sendMessage = (async (message: Request) => {
    asked.push(message);
    if (message.type === "lookup") return { ok: true, type: "lookup", definition: answers[`lookup:${message.query}`] ?? null };
    if (message.type === "lookupEntry") return { ok: true, type: "lookupEntry", definition: answers[`entry:${message.entry}`] ?? null };
    if (message.type === "states") return { ok: true, type: "states", states: {}, details: {} };
    return { ok: true };
  }) as typeof ext.runtime.sendMessage;

  return {
    window: window as unknown as { document: Document },
    word: await import("../src/content/word.js"),
    popup: await import("../src/content/popup.js"),
  };
}

async function hover(token: Partial<ParsedToken>): Promise<HTMLElement> {
  const { window, word: words, popup } = await page();
  const node = words.renderToken({
    start: 0, length: 2, surface: "きみ", reading: null, lemma: "きみ",
    pos: "noun", content: true, state: "none", ...token,
  } as ParsedToken, false);
  window.document.body.append(node as never);

  const word = node as unknown as HTMLElement;
  popup.showNow(word);
  await settle();
  return word;
}

async function chips(): Promise<HTMLElement[]> {
  const { window } = await page();
  const host = window.document.querySelector(".sb-host") as unknown as { shadowRoot: ShadowRoot } | null;
  return [ ...(host?.shadowRoot.querySelectorAll(".sb-candidate") ?? []) ] as HTMLElement[];
}

test("a span several words claim offers them all, the parser's answer marked", async () => {
  await hover({ entry: "jmdict:1226580", candidates: [ candidate("jmdict:1226580", "きみ", "きみ"), candidate("jmdict:1247250", "君", "きみ") ] });

  const offered = await chips();
  assert.deepEqual(offered.map((chip) => chip.dataset.entry), [ "jmdict:1226580", "jmdict:1247250" ],
    "best first, and every word the spelling can name");
  assert.equal(offered[0]?.getAttribute("aria-current"), "true", "the word the parser landed on says so");
  assert.equal(offered[1]?.getAttribute("aria-current"), null);
});

// The load-bearing one. `entryFor` reads `dataset.entry` and the save posts it,
// so this is the difference between carding 君 and carding the millet.
test("picking a word writes the entry the save will travel under", async () => {
  const word = await hover({
    lemma: "きみ2", // a different key, so the popup re-renders rather than reusing the open card
    entry: "jmdict:1226580",
    candidates: [ candidate("jmdict:1226580", "きみ", "きみ"), candidate("jmdict:1247250", "君", "きみ") ],
  });
  (await chips())[1]?.click();
  await settle();

  assert.equal(word.dataset.entry, "jmdict:1247250", "the pick is what gets carded");
  assert.ok(asked.some((message) => message.type === "lookupEntry" && message.entry === "jmdict:1247250"),
    "asked for the word by HANDLE: re-looking-up きみ would answer the millet again");
});

// A span that names one word is not a question, so it gets no row: a client (and
// a reader) tests for the picker rather than counting a list of one.
test("a span only one word claims shows no picker", async () => {
  await hover({ entry: "jmdict:1522150", surface: "本", lemma: "本" });

  assert.equal((await chips()).length, 0);
});
