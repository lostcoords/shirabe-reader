import { send } from "../common/messages.js";
import type { Definition } from "../common/types.js";
import { applyState } from "./word.js";

// A single reused popup element, shown next to whichever word the pointer is
// over. Lives in the page's light DOM and is styled by the injected
// content.css. Definitions are fetched lazily (and cached in the background).
let popup: HTMLElement | null = null;
let currentWord: HTMLElement | null = null;
let showTimer: number | undefined;
let hideTimer: number | undefined;
let token = 0; // guards against a slow lookup landing after we've moved on

function element(): HTMLElement {
  if (popup) return popup;
  popup = document.createElement("div");
  popup.className = "sb-popup";
  popup.addEventListener("mouseenter", () => window.clearTimeout(hideTimer));
  popup.addEventListener("mouseleave", () => scheduleHide());
  document.body.append(popup);
  return popup;
}

export function scheduleShow(word: HTMLElement): void {
  window.clearTimeout(hideTimer);
  window.clearTimeout(showTimer);
  showTimer = window.setTimeout(() => show(word), 180);
}

export function scheduleHide(): void {
  window.clearTimeout(showTimer);
  hideTimer = window.setTimeout(hide, 200);
}

function hide(): void {
  popup?.classList.remove("sb-visible");
  currentWord = null;
}

async function show(word: HTMLElement): Promise<void> {
  if (word === currentWord) return;
  currentWord = word;
  const lemma = word.dataset.lemma ?? word.dataset.surface ?? "";
  const mine = ++token;

  const el = element();
  el.replaceChildren(loadingRow(lemma));
  position(el, word);
  el.classList.add("sb-visible");

  const res = await send({ type: "lookup", query: lemma });
  if (mine !== token) return; // user moved to another word meanwhile

  if (!res.ok) {
    el.replaceChildren(messageRow(res.error));
    return;
  }
  el.replaceChildren(...definitionRows(res.definition, lemma, word));
  position(el, word);
}

function position(el: HTMLElement, word: HTMLElement): void {
  const rect = word.getBoundingClientRect();
  const margin = 8;
  el.style.visibility = "hidden";
  el.style.left = "0px";
  el.style.top = "0px";
  const { width, height } = el.getBoundingClientRect();

  let left = window.scrollX + rect.left;
  left = Math.min(left, window.scrollX + document.documentElement.clientWidth - width - margin);
  left = Math.max(left, window.scrollX + margin);

  // Prefer below the word; flip above when there isn't room.
  const below = rect.bottom + margin;
  const top = below + height > document.documentElement.clientHeight ? rect.top - height - margin : below;

  el.style.left = `${left}px`;
  el.style.top = `${window.scrollY + top}px`;
  el.style.visibility = "";
}

function loadingRow(lemma: string): Node {
  const div = document.createElement("div");
  div.className = "sb-popup-head";
  div.textContent = lemma;
  return div;
}

function messageRow(text: string): Node {
  const div = document.createElement("div");
  div.className = "sb-popup-message";
  div.textContent = text;
  return div;
}

function definitionRows(def: Definition | null, lemma: string, word: HTMLElement): Node[] {
  if (!def) return [messageRow(`No entry for 「${lemma}」`)];

  const head = document.createElement("div");
  head.className = "sb-popup-head";
  head.textContent = def.headword;
  if (def.reading) {
    const reading = document.createElement("span");
    reading.className = "sb-popup-reading";
    reading.textContent = def.reading;
    head.append(reading);
  }

  const list = document.createElement("ol");
  list.className = "sb-senses";
  for (const sense of def.senses.slice(0, 6)) {
    const li = document.createElement("li");
    if (sense.partsOfSpeech.length) {
      const pos = document.createElement("span");
      pos.className = "sb-pos";
      pos.textContent = sense.partsOfSpeech.join(", ");
      li.append(pos);
    }
    li.append(sense.glosses.join("; "));
    list.append(li);
  }

  return [head, list, actions(lemma, word)];
}

// Mining controls. These hit /v1 endpoints that are still being built
// server-side; on failure we show the error inline rather than pretend.
function actions(lemma: string, word: HTMLElement): Node {
  const bar = document.createElement("div");
  bar.className = "sb-actions";

  const save = button("＋ Save", "sb-btn-save", async () => {
    const res = await send({ type: "save", lemma });
    feedback(bar, res.ok ? "Saved" : res.error);
  });

  const known = button("✓ Known", "sb-btn-known", async () => {
    const res = await send({ type: "setState", lemma, state: "known" });
    if (res.ok) applyState(word, "known");
    feedback(bar, res.ok ? "Marked known" : res.error);
  });

  bar.append(save, known);
  return bar;
}

function button(label: string, className: string, onClick: () => void): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.className = `sb-btn ${className}`;
  btn.textContent = label;
  btn.addEventListener("click", onClick);
  return btn;
}

function feedback(bar: HTMLElement, text: string): void {
  let note = bar.querySelector<HTMLElement>(".sb-feedback");
  if (!note) {
    note = document.createElement("span");
    note.className = "sb-feedback";
    bar.append(note);
  }
  note.textContent = text;
}
