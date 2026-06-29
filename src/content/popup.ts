import { send, type Rating } from "../common/messages.js";
import type { Definition } from "../common/types.js";
import { grade, GRADES, markKnown, save, type Outcome } from "./actions.js";

// One reused popup, shown next to whichever word the pointer (or keyboard) is
// over. It lives in a shadow root so the host page's CSS can never reach in —
// definitions render the same on every site. Lookups are fetched lazily (and
// cached in the background worker).
let host: HTMLElement | null = null;
let root: ShadowRoot | null = null;
let box: HTMLElement | null = null;
let currentWord: HTMLElement | null = null;
let showTimer: number | undefined;
let hideTimer: number | undefined;
let token = 0; // guards against a slow lookup landing after we've moved on
let canWrite = false; // key carries WRITE_SRS → render the mining controls

export function setCanWrite(value: boolean): void {
  canWrite = value;
}

function element(): HTMLElement {
  if (box) return box;
  host = document.createElement("div");
  host.className = "sb-host";
  root = host.attachShadow({ mode: "open" });
  const style = document.createElement("style");
  style.textContent = CSS;
  box = document.createElement("div");
  box.className = "sb-popup";
  box.addEventListener("mouseenter", () => window.clearTimeout(hideTimer));
  box.addEventListener("mouseleave", () => scheduleHide());
  root.append(style, box);
  document.body.append(host);
  return box;
}

export function scheduleShow(word: HTMLElement): void {
  window.clearTimeout(hideTimer);
  window.clearTimeout(showTimer);
  showTimer = window.setTimeout(() => show(word), 180);
}

// Show immediately (e.g. the modifier key was pressed while already hovering).
export function showNow(word: HTMLElement): void {
  window.clearTimeout(hideTimer);
  window.clearTimeout(showTimer);
  show(word);
}

export function scheduleHide(): void {
  window.clearTimeout(showTimer);
  hideTimer = window.setTimeout(hide, 200);
}

function hide(): void {
  box?.classList.remove("sb-visible");
  currentWord = null;
}

async function show(word: HTMLElement): Promise<void> {
  if (word === currentWord && box?.classList.contains("sb-visible")) return;
  currentWord = word;
  const lemma = word.dataset.lemma ?? word.dataset.surface ?? "";
  const mine = ++token;

  const el = element();
  el.replaceChildren(loadingRow(lemma));
  position(word);
  el.classList.add("sb-visible");

  const res = await send({ type: "lookup", query: lemma });
  if (mine !== token) return; // user moved to another word meanwhile

  if (!res.ok) {
    el.replaceChildren(messageRow(res.error));
    return;
  }
  el.replaceChildren(...definitionRows(res.definition, lemma, word));
  position(word);
}

function position(word: HTMLElement): void {
  if (!host) return;
  const rect = word.getBoundingClientRect();
  const margin = 8;
  host.style.visibility = "hidden";
  host.style.left = "0px";
  host.style.top = "0px";
  const { width, height } = host.getBoundingClientRect();

  let left = window.scrollX + rect.left;
  left = Math.min(left, window.scrollX + document.documentElement.clientWidth - width - margin);
  left = Math.max(left, window.scrollX + margin);

  // Prefer below the word; flip above when there isn't room.
  const below = rect.bottom + margin;
  const top = below + height > document.documentElement.clientHeight ? rect.top - height - margin : below;

  host.style.left = `${left}px`;
  host.style.top = `${window.scrollY + top}px`;
  host.style.visibility = "";
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
  if (!def) {
    const rows: Node[] = [messageRow(`No entry for 「${lemma}」`)];
    if (canWrite) rows.push(actions(word));
    return rows;
  }

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

  const rows: Node[] = [head, list];
  if (canWrite) rows.push(actions(word));
  return rows;
}

// Mining + review controls. The grade row both mines a new word and reviews an
// existing one (POST /v1/srs/saves with a rating). Save adds without grading;
// Known parks it. Each recolours the word in place and surfaces any error
// (e.g. the Pro card cap) inline rather than pretend.
function actions(word: HTMLElement): Node {
  const wrap = document.createElement("div");
  wrap.className = "sb-actions";

  const grades = document.createElement("div");
  grades.className = "sb-grades";
  for (const r of [1, 2, 3, 4] as Rating[]) {
    grades.append(button(`${GRADES[r]}`, `sb-grade sb-g${r}`, `${r}`, () => run(wrap, () => grade(word, r))));
  }

  const extra = document.createElement("div");
  extra.className = "sb-extra";
  extra.append(
    button("＋ Save", "sb-btn-save", "S", () => run(wrap, () => save(word))),
    button("✓ Known", "sb-btn-known", "K", () => run(wrap, () => markKnown(word))),
  );

  const note = document.createElement("span");
  note.className = "sb-feedback";

  wrap.append(grades, extra, note);
  return wrap;
}

async function run(wrap: HTMLElement, action: () => Promise<Outcome>): Promise<void> {
  const { ok, message } = await action();
  const note = wrap.querySelector<HTMLElement>(".sb-feedback");
  if (note) {
    note.textContent = message;
    note.classList.toggle("sb-error", !ok);
  }
}

function button(label: string, className: string, hint: string, onClick: () => void): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.className = `sb-btn ${className}`;
  btn.title = `Shortcut: ${hint}`;
  const text = document.createElement("span");
  text.textContent = label;
  const kbd = document.createElement("kbd");
  kbd.textContent = hint;
  btn.append(text, kbd);
  btn.addEventListener("click", onClick);
  return btn;
}

const CSS = `
:host { all: initial; }
:host {
  position: absolute;
  top: 0;
  left: 0;
  z-index: 2147483647;
  display: block;
}
.sb-popup {
  box-sizing: border-box;
  max-width: 360px;
  min-width: 200px;
  padding: 12px 14px;
  background: #ffffff;
  color: #1f2937;
  border: 1px solid #e5e7eb;
  border-radius: 12px;
  box-shadow: 0 10px 30px rgba(15, 23, 42, 0.18);
  font-family: system-ui, -apple-system, "Hiragino Kaku Gothic ProN", "Noto Sans JP", sans-serif;
  font-size: 14px;
  line-height: 1.5;
  opacity: 0;
  visibility: hidden;
  transform: translateY(4px);
  transition: opacity 0.12s ease, transform 0.12s ease;
}
.sb-popup.sb-visible { opacity: 1; visibility: visible; transform: translateY(0); }

.sb-popup-head { font-size: 20px; font-weight: 700; color: #111827; }
.sb-popup-reading { margin-left: 8px; font-size: 14px; font-weight: 500; color: #4f46e5; }
.sb-popup-message { color: #6b7280; }

.sb-senses { margin: 8px 0 0; padding-left: 18px; }
.sb-senses li { margin: 4px 0; }
.sb-pos {
  display: block; font-size: 11px; font-weight: 600; text-transform: uppercase;
  letter-spacing: 0.04em; color: #9ca3af;
}

.sb-actions { margin-top: 12px; padding-top: 10px; border-top: 1px solid #f3f4f6; }
.sb-grades { display: grid; grid-template-columns: repeat(4, 1fr); gap: 6px; }
.sb-extra { display: flex; gap: 6px; margin-top: 6px; }
.sb-extra .sb-btn { flex: 1; }

.sb-btn {
  display: inline-flex; align-items: center; justify-content: center; gap: 6px;
  font: 600 13px/1 system-ui, sans-serif;
  padding: 7px 8px; border-radius: 8px; border: 1px solid transparent; cursor: pointer;
  color: #fff;
}
.sb-btn kbd {
  font: 600 10px/1 ui-monospace, monospace;
  padding: 2px 4px; border-radius: 4px;
  background: rgba(255, 255, 255, 0.25);
}
.sb-g1 { background: #ef4444; } .sb-g1:hover { background: #dc2626; }
.sb-g2 { background: #f59e0b; } .sb-g2:hover { background: #d97706; }
.sb-g3 { background: #22c55e; } .sb-g3:hover { background: #16a34a; }
.sb-g4 { background: #3b82f6; } .sb-g4:hover { background: #2563eb; }
.sb-btn-save { background: #4f46e5; } .sb-btn-save:hover { background: #4338ca; }
.sb-btn-known { background: #6b7280; } .sb-btn-known:hover { background: #4b5563; }
.sb-btn-known kbd, .sb-btn-save kbd { background: rgba(255, 255, 255, 0.22); }

.sb-feedback { display: block; margin-top: 8px; font-size: 12px; color: #6b7280; }
.sb-feedback.sb-error { color: #b91c1c; }
`;
