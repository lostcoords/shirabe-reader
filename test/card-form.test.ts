import assert from "node:assert/strict";
import test from "node:test";
import type { Request } from "../src/common/messages.js";

// The capture form is the extension's front door to the same Card the website's
// save modal builds (docs/plans/extension-card-form.md). What it renders is a
// matter of taste; what it POSTs is a contract, so that is what these pin.

type SaveRequest = Extract<Request, { type: "save" }>;

async function mountForm(options: {
  senses: Array<{ glosses: string[] }>;
  examples?: Array<{ japanese: string; translation: string | null }>;
  savedSenses?: string;
  capture?: { sentence?: { text: string; capturedAt: string }; imageDataUrl?: string };
}) {
  const { Window } = await import("happy-dom");
  const window = new Window({ url: "https://reader.test/page" });
  const sent: Request[] = [];
  Object.assign(globalThis, {
    window, document: window.document, HTMLElement: window.HTMLElement, Option: window.Option,
    chrome: globalThis.chrome ?? { runtime: { id: "test", sendMessage: async () => ({ ok: true }) } },
  });
  // `ext` binds to whichever WebExtension global existed when browser.ts was
  // first imported: the bundle shares one: so answer through that object
  // rather than swapping the global out from under it.
  const { ext } = await import("../src/common/browser.js");
  ext.runtime.sendMessage = (async (message: Request) => {
    sent.push(message);
    if (message.type === "decks") return { ok: true, type: "decks", decks: [{ id: 7, name: "Reading pile" }, { id: 9, name: "Anime" }] };
    return { ok: true, type: "save", result: { state: "new", created: true, decks: [] } };
  }) as typeof ext.runtime.sendMessage;

  const { renderCardForm } = await import("../src/content/card-form.js");
  const word = window.document.createElement("span") as unknown as HTMLElement;
  word.dataset.lemma = "高い";
  word.dataset.reading = "たかい";
  if (options.savedSenses) word.dataset.savedSenses = options.savedSenses;
  const host = window.document.createElement("div") as unknown as HTMLElement;
  window.document.body.append(host as never);

  await renderCardForm(host, {
    word,
    definition: {
      headword: "高い", reading: "たかい", entry: "jmdict:1200430", url: "", common: true, jlpt: null, frequency: null,
      pitch: [], senses: options.senses.map((s) => ({ position: 0, source: "", partsOfSpeech: [], tags: [], glosses: s.glosses })),
      examples: (options.examples ?? []).map((e) => ({ japanese: e.japanese, translation: e.translation })),
      offline: true,
    },
    capture: options.capture ?? {},
    preferredDeckId: 9,
    onCancel: () => undefined,
    onSaved: () => undefined,
  });

  const submit = [...host.querySelectorAll("button")].find((b) => b.textContent === "Save card") as HTMLButtonElement;
  const saveRequest = async (): Promise<SaveRequest> => {
    submit.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    return sent.find((message) => message.type === "save") as SaveRequest;
  };
  return { host, window, saveRequest, sent };
}

test("the form saves into the preferred deck, or a deck it creates by name", async () => {
  const { host, saveRequest } = await mountForm({ senses: [{ glosses: ["expensive"] }] });

  const select = host.querySelector("select") as HTMLSelectElement;
  assert.equal(select.value, "9", "the deck the reader picked in settings is preselected");

  // A typed name wins over the picker: a card can arrive with its own deck.
  const name = host.querySelector("input[type='text']") as HTMLInputElement;
  name.value = "  Immersion  ";
  name.hidden = false;
  const request = await saveRequest();
  assert.equal(request.newDeckName, "Immersion", "trimmed, and it beats the picked deck");
  assert.equal(request.deckId, undefined);
});

test("the card carries the entry the reader was reading, so it lands linked", async () => {
  // An orphan card is free text: no enrichment, no drift-tracking, and the
  // learner has to relink it by hand. The definition already names its entry :
  // sending that handle is the whole difference (docs/specs/srs.md §1.1).
  const { saveRequest } = await mountForm({ senses: [{ glosses: ["expensive"] }] });
  assert.equal((await saveRequest()).entry, "jmdict:1200430");
});

test("ticking every meaning saves the whole word, not a scoped card", async () => {
  const { host, saveRequest } = await mountForm({
    senses: [{ glosses: ["high; tall"] }, { glosses: ["expensive"] }],
  });

  const boxes = [...host.querySelectorAll("input[type='checkbox']")] as HTMLInputElement[];
  assert.equal(boxes.length, 2, "a multi-meaning word offers a pick per meaning");
  // Every box ticked is the default, and it means the whole word: sending those
  // positions would build a scoped card that covers everything: a second card
  // beside the plain one, for the same thing.
  const whole = await saveRequest();
  assert.equal(whole.sensePositions, undefined);
});

test("a word whose meanings are all saved does not offer an empty selection", async () => {
  // An empty pick means "the whole word", so an all-covered word must not render
  // an unticked picker: that save would build a second whole-word card.
  const { host, saveRequest } = await mountForm({
    senses: [{ glosses: ["high; tall"] }, { glosses: ["expensive"] }],
    savedSenses: "all",
  });

  assert.equal(host.querySelectorAll("input[type='checkbox']").length, 0, "nothing left to tick");
  assert.equal(host.querySelectorAll(".sb-sense-saved-mark").length, 2, "each meaning says it is already saved");
  const request = await saveRequest();
  assert.equal(request.sensePositions, undefined);
});

test("examples are picked into state, so removing one survives the list re-rendering", async () => {
  const { host, saveRequest } = await mountForm({
    senses: [{ glosses: ["expensive"] }],
    examples: [{ japanese: "この本は高い。", translation: "This book is expensive." },
               { japanese: "家賃が高い。", translation: "The rent is high." }],
  });

  // A single-meaning word arrives with its first example already picked: there is
  // no meaning to choose first, so the common save carries a sentence.
  assert.equal(host.querySelectorAll(".sb-form-chip").length, 1);

  // Add the second, drop the first: the chips are the picks, and dropping one
  // re-renders the row without touching the other.
  const offers = [...host.querySelectorAll(".sb-form-offer")] as HTMLButtonElement[];
  offers[1].click();
  assert.equal(host.querySelectorAll(".sb-form-chip").length, 2);
  (host.querySelector(".sb-form-chip-x") as HTMLButtonElement).click();

  const request = await saveRequest();
  assert.deepEqual(request.sentences?.map((s) => s.text), ["家賃が高い。"]);
  assert.deepEqual(request.sentences?.map((s) => s.origin), ["tatoeba"], "a corpus line is not the reader's own");
});

test("the mined line leads the examples and keeps its page origin", async () => {
  const { host, saveRequest } = await mountForm({
    senses: [{ glosses: ["expensive"] }],
    examples: [{ japanese: "この本は高い。", translation: "This book is expensive." }],
    capture: { sentence: { text: "この街は家賃が高い。", capturedAt: "2026-07-27T00:00:00Z" }, imageDataUrl: "data:image/png;base64,AA" },
  });

  const request = await saveRequest();
  assert.deepEqual(request.sentences?.map((s) => s.text), ["この街は家賃が高い。"],
    "the line the reader mined is why they opened the form; the word's own examples are offers");
  assert.equal(request.sentences?.[0]?.origin, undefined, "no origin means the server reads it as a page mine");
  assert.equal(request.cardImageDataUrl, "data:image/png;base64,AA", "the captured frame becomes the card's picture");
});

test("hint and notes are always sent, so clearing them is a real edit", async () => {
  const { host, saveRequest } = await mountForm({ senses: [{ glosses: ["expensive"] }] });

  const [hint, notes] = [...host.querySelectorAll("input[type='text'], textarea")] as HTMLInputElement[];
  void hint;
  const fields = [...host.querySelectorAll(".sb-field")] as HTMLElement[];
  (fields.find((f) => f.textContent?.startsWith("Hint"))?.querySelector("input") as HTMLInputElement).value = "money, not height";
  (fields.find((f) => f.textContent?.startsWith("Notes"))?.querySelector("textarea") as HTMLTextAreaElement).value = "watch this one";
  void notes;

  const request = await saveRequest();
  assert.equal(request.hint, "money, not height");
  assert.equal(request.notes, "watch this one");
});
