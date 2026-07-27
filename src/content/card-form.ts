import { send } from "../common/messages.js";
import type { SentenceCapture } from "../common/messages.js";
import type { Definition } from "../common/types.js";

// The full capture form — the extension's front door to the same Card the web
// app's save modal and new-card page build (docs/specs/srs.md §1.0, and
// docs/plans/extension-card-form.md for why each rule below exists). Quick Save
// still posts a bare identity; this is what you open when the card is worth
// composing: deck, meanings, examples, hint, notes, picture.
//
// Every rule here came out of a real trap on the web form, not taste:
//   · a typed deck name beats the picker, so a card can arrive with its own deck;
//   · ticking nothing and ticking everything both mean "the whole word", so an
//     all-covered word ticks everything rather than offering an empty selection
//     that would build a second whole-word card;
//   · sentence picks live in state, never in the list's DOM, so re-rendering the
//     list (show more, a new pick) cannot silently drop them.

export type CardCapture = {
  /** The line the reader mined off the page, if this word came from one. */
  sentence?: SentenceCapture;
  /** Screenshot taken at capture time (the video frame for a subtitle). */
  imageDataUrl?: string;
  /** The mined line's audio, when the page was playing media. */
  audioDataUrl?: string;
};

export type CardFormOptions = {
  word: HTMLElement;
  definition: Definition;
  capture: CardCapture;
  preferredDeckId?: number;
  onCancel: () => void;
  onSaved: (message: string) => void;
};

type Pick = { key: string; sentence: SentenceCapture };

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
};

// A labelled row. Deliberately NOT a <label> wrapper: the examples row holds
// buttons, and a button inside a label activates twice — the click bubbles to the
// label, which activates its control, which is the button (happy-dom recurses on
// it until the stack gives out; a browser just double-fires). So the label points
// at the control by id when there is a single real one, and is plain text when
// the row is a composite.
let fieldSeq = 0;
function field(text: string, control: HTMLElement, hint?: string): HTMLElement {
  const row = el("div", "sb-field");
  // By tag, not `instanceof`: a content script shares the page's globals, and
  // those constructors are not guaranteed to be the ones this node was built from.
  const labelable = [ "SELECT", "INPUT", "TEXTAREA" ].includes(control.tagName);
  if (labelable) {
    control.id ||= `sb-field-${(fieldSeq += 1)}`;
    const label = el("label", "sb-field-label", text);
    label.htmlFor = control.id;
    row.append(label);
  } else {
    row.append(el("span", "sb-field-label", text));
  }
  row.append(control);
  if (hint) row.append(el("span", "sb-field-hint", hint));
  return row;
}

export async function renderCardForm(host: HTMLElement, options: CardFormOptions): Promise<void> {
  const { word, definition, capture } = options;
  host.replaceChildren();
  const form = el("div", "sb-form");

  // ── Deck ───────────────────────────────────────────────────────────────────
  // Picking an existing deck is the common case, so the name field hides behind
  // a `+` — same shape as the web form.
  const deckSelect = el("select", "sb-input");
  const newDeckName = el("input", "sb-input");
  newDeckName.type = "text";
  newDeckName.placeholder = "New deck name";
  newDeckName.hidden = true;
  const newDeckToggle = el("button", "sb-btn sb-btn-ghost", "＋");
  newDeckToggle.type = "button";
  newDeckToggle.title = "Save into a new deck";
  newDeckToggle.setAttribute("aria-label", "Save into a new deck");
  newDeckToggle.addEventListener("click", () => {
    newDeckName.hidden = !newDeckName.hidden;
    deckSelect.disabled = !newDeckName.hidden;
    if (!newDeckName.hidden) newDeckName.focus();
  });
  const deckRow = el("div", "sb-row");
  deckRow.append(deckSelect, newDeckToggle);
  const deckField = field("Deck", deckRow);
  deckField.append(newDeckName);
  form.append(deckField);

  const addDeckOption = (label: string, value: string, selected = false): void => {
    const option = el("option", undefined, label);
    option.value = value;
    option.selected = selected;
    deckSelect.append(option);
  };
  const decks = await send({ type: "decks" });
  if (decks.ok) {
    for (const deck of decks.decks) addDeckOption(deck.name, String(deck.id), deck.id === options.preferredDeckId);
  }
  if (!deckSelect.options.length) addDeckOption("Saved words (default)", "");

  // ── Meanings ───────────────────────────────────────────────────────────────
  // A word with one meaning shows it as a line, not a checkbox: ticking its only
  // sense and ticking none both save the whole word, so the control could not
  // change the outcome.
  const covered = coveredSenses(word);
  const senses = definition.senses.map((sense, index) => ({ position: index, sense }));
  const pickable = senses.length > 1;
  const senseBoxes: HTMLInputElement[] = [];
  if (senses.length) {
    const list = el("ul", "sb-form-senses");
    for (const { position, sense } of senses) {
      const row = el("li");
      const isSaved = covered === "all" || covered.has(position);
      if (pickable && !isSaved) {
        const box = el("input", "sb-sense-pick");
        box.type = "checkbox";
        box.checked = true;
        box.dataset.position = String(position);
        box.setAttribute("aria-label", `Include "${sense.glosses.join("; ")}" when saving`);
        senseBoxes.push(box);
        row.append(box);
      } else if (pickable) {
        row.append(el("span", "sb-sense-saved-mark", "Saved"));
      }
      row.append(el("span", "sb-form-gloss", sense.glosses.join("; ")));
      list.append(row);
    }
    form.append(field("Meanings", list));
  }

  // ── Examples ───────────────────────────────────────────────────────────────
  // Picks live here, not in the list — the list re-renders and the DOM would
  // take the picks with it.
  const picks = new Map<string, Pick>();
  const chipRow = el("div", "sb-form-picks");

  const renderPicks = (): void => {
    chipRow.replaceChildren();
    for (const [key, pick] of picks) {
      const chip = el("span", "sb-form-chip");
      chip.append(el("span", "sb-form-chip-text", pick.sentence.text));
      const drop = el("button", "sb-form-chip-x", "×");
      drop.type = "button";
      drop.title = "Remove this example";
      drop.setAttribute("aria-label", `Remove "${pick.sentence.text}"`);
      drop.addEventListener("click", () => {
        picks.delete(key);
        renderPicks();
      });
      chip.append(drop);
      chipRow.append(chip);
    }
  };

  const offer = (key: string, sentence: SentenceCapture, label: string): HTMLElement => {
    const button = el("button", "sb-form-offer", label);
    button.type = "button";
    button.addEventListener("click", () => {
      picks.set(key, { key, sentence });
      renderPicks();
    });
    return button;
  };

  const offers = el("div", "sb-form-offers");
  // The mined line arrives already picked — it is why the reader opened this.
  if (capture.sentence) {
    picks.set("mined", { key: "mined", sentence: capture.sentence });
    offers.append(offer("mined", capture.sentence, "The line you mined"));
  }
  // Then the word's own examples, which the offline pack now carries.
  definition.examples.forEach((example, index) => {
    const sentence: SentenceCapture = {
      text: example.japanese,
      translation: example.translation ?? undefined,
      origin: "tatoeba",
      capturedAt: new Date().toISOString(),
    };
    // A single-meaning word has no meaning to choose first, so its common save
    // should still carry a sentence without a second decision.
    if (index === 0 && !capture.sentence && senses.length === 1) picks.set(`example:${index}`, { key: `example:${index}`, sentence });
    offers.append(offer(`example:${index}`, sentence, example.japanese));
  });

  const ownText = el("textarea", "sb-input");
  ownText.rows = 2;
  ownText.placeholder = "Write your own sentence";
  ownText.hidden = true;
  const ownToggle = el("button", "sb-btn sb-btn-ghost", "＋ Write your own");
  ownToggle.type = "button";
  ownToggle.addEventListener("click", () => {
    ownText.hidden = !ownText.hidden;
    if (!ownText.hidden) ownText.focus();
  });
  ownText.addEventListener("change", () => {
    const text = ownText.value.trim();
    if (!text) return picks.delete("own"), renderPicks();
    picks.set("own", { key: "own", sentence: { text, origin: "manual", capturedAt: new Date().toISOString() } });
    renderPicks();
  });

  const examples = el("div", "sb-form-examples");
  examples.append(chipRow, offers, ownToggle, ownText);
  form.append(field("Examples", examples));
  renderPicks();

  // ── The learner's own fields ───────────────────────────────────────────────
  const hint = el("input", "sb-input");
  hint.type = "text";
  hint.placeholder = "Shown on the front";
  const notes = el("textarea", "sb-input");
  notes.rows = 2;
  notes.placeholder = "Shown on the back";
  form.append(field("Hint", hint), field("Notes", notes));

  // ── Picture ────────────────────────────────────────────────────────────────
  // Only offered when there is one: the screenshot is taken at capture time, and
  // an empty frame is not a decision worth showing.
  const keepImage = el("input");
  keepImage.type = "checkbox";
  keepImage.checked = true;
  if (capture.imageDataUrl) {
    const preview = el("img", "sb-form-shot");
    preview.src = capture.imageDataUrl;
    preview.alt = "Captured screenshot";
    const row = el("div", "sb-row");
    row.append(keepImage, preview);
    form.append(field("Picture", row));
  }

  // ── Save ───────────────────────────────────────────────────────────────────
  const feedback = el("span", "sb-feedback");
  const submit = el("button", "sb-btn sb-btn-save", "Save card");
  submit.type = "button";
  const cancel = el("button", "sb-btn sb-btn-ghost", "Cancel");
  cancel.type = "button";
  cancel.addEventListener("click", options.onCancel);

  submit.addEventListener("click", async () => {
    submit.disabled = true;
    feedback.textContent = "Saving…";
    const ticked = senseBoxes.filter((box) => box.checked).map((box) => Number(box.dataset.position));
    // Ticking every meaning is the whole word, and so is ticking none — but an
    // all-covered word must not send an empty pick, which would build a second
    // whole-word card rather than the nothing the learner intended.
    const scoped = pickable && ticked.length > 0 && ticked.length < senseBoxes.length;
    const sentences = [...picks.values()].map((pick) => pick.sentence);

    const response = await send({
      type: "save",
      lemma: word.dataset.lemma || word.textContent || "",
      surface: word.dataset.surface,
      reading: word.dataset.reading,
      entry: definition.entry ?? word.dataset.entry,
      ...(newDeckName.hidden || !newDeckName.value.trim()
        ? deckSelect.value ? { deckId: Number(deckSelect.value) } : {}
        : { newDeckName: newDeckName.value.trim() }),
      ...(scoped ? { sensePositions: ticked } : {}),
      ...(sentences.length ? { sentences } : {}),
      hint: hint.value.trim(),
      notes: notes.value.trim(),
      ...(capture.imageDataUrl && keepImage.checked ? { cardImageDataUrl: capture.imageDataUrl } : {}),
    });

    if (!response.ok) {
      submit.disabled = false;
      feedback.textContent = response.error;
      return;
    }
    options.onSaved(response.result.created ? "Card saved" : "Card updated");
  });

  const actions = el("div", "sb-form-actions");
  actions.append(submit, cancel, feedback);
  form.append(actions);
  host.append(form);
  deckSelect.focus();
}

// Which meanings already have a card, as the state cache wrote them onto the
// word (`applyStudyDetails`): "all" when a whole-word card covers everything.
function coveredSenses(word: HTMLElement): Set<number> | "all" {
  const raw = word.dataset.savedSenses;
  if (!raw) return new Set();
  if (raw === "all") return "all";
  return new Set(raw.split(",").map(Number).filter(Number.isInteger));
}
