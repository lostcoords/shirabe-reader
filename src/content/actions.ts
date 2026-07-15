import { send, type Rating, type SentenceCapture, type StudyDetails } from "../common/messages.js";
import { loadConfig } from "../common/config.js";
import { applyStateEverywhere } from "./word.js";

// Mining + review actions shared by the popup buttons and the keyboard
// shortcuts. Each performs the network call, recolours every occurrence of the
// word on success, and returns a human message for the caller to surface
// (inline in the popup, or as a toast when fired from the keyboard).
export type Outcome = { ok: boolean; message: string };
export type MediaCapture = { captureScreenshot?: boolean; imageDataUrl?: string; audioDataUrl?: string };
const mediaByWord = new WeakMap<HTMLElement, MediaCapture>();

export function setMediaCapture(word: HTMLElement, media: MediaCapture): void {
  mediaByWord.set(word, media);
}

export const GRADES: Record<Rating, string> = { 1: "Again", 2: "Hard", 3: "Good", 4: "Easy" };
const INTERVAL_KEYS = { 1: "again", 2: "hard", 3: "good", 4: "easy" } as const;

export function applyStudyDetails(word: HTMLElement, details: StudyDetails): void {
  word.dataset.state = details.state;
  word.dataset.deckNames = details.decks.map((deck) => deck.name).join(", ");
  if (details.intervals) word.dataset.intervals = JSON.stringify(details.intervals);
  else delete word.dataset.intervals;
}

const lemmaOf = (word: HTMLElement) => word.dataset.lemma ?? word.dataset.surface ?? "";

function sentenceOf(word: HTMLElement): SentenceCapture | undefined {
  const text = word.dataset.sentence?.trim();
  if (!text) return;
  const targetStart = numberFrom(word.dataset.targetStart);
  const targetEnd = numberFrom(word.dataset.targetEnd);
  const mediaTimestampMs = numberFrom(word.closest<HTMLElement>("[data-media-timestamp]")?.dataset.mediaTimestamp);
  return {
    text,
    ...(word.dataset.translation ? { translation: word.dataset.translation } : {}),
    url: word.closest<HTMLElement>("[data-source-url]")?.dataset.sourceUrl || location.href,
    title: document.title,
    capturedAt: new Date().toISOString(),
    integration: word.closest<HTMLElement>("[data-integration]")?.dataset.integration || "web_page",
    ...(mediaTimestampMs == null ? {} : { mediaTimestampMs }),
    ...(targetStart == null ? {} : { targetStart }),
    ...(targetEnd == null ? {} : { targetEnd }),
  };
}

function numberFrom(value: string | undefined): number | undefined {
  if (value == null || value === "") return;
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : undefined;
}

async function saveRequest(word: HTMLElement, rating?: Rating) {
  const config = await loadConfig();
  const sentence = sentenceOf(word);
  const media = mediaByWord.get(word) ?? {};
  return send({
    type: "save",
    lemma: lemmaOf(word),
    surface: word.dataset.surface,
    reading: word.dataset.reading,
    ...(config.preferredDeckId == null ? {} : { deckId: config.preferredDeckId }),
    ...(sentence ? { sentence } : {}),
    ...(rating == null ? {} : { rating }),
    ...media,
  });
}

// Grade (and mine if new) on Shirabe's 1–4 scale. POST /v1/srs/saves
// find-or-creates the card by lemma, so this both mines and reviews.
export async function grade(word: HTMLElement, rating: Rating): Promise<Outcome> {
  const lemma = lemmaOf(word);
  const res = await saveRequest(word, rating);
  if (res.ok) {
    applyStateEverywhere(lemma, res.result.state);
    applyStudyDetails(word, res.result);
  }
  const interval = res.ok ? res.result.intervals?.[INTERVAL_KEYS[rating]] : undefined;
  return { ok: res.ok, message: res.ok ? `${lemma} → ${GRADES[rating]}${interval ? ` · ${interval}` : ""}` : res.error };
}

// Add to the deck without grading.
export async function save(word: HTMLElement): Promise<Outcome> {
  const lemma = lemmaOf(word);
  const res = await saveRequest(word);
  if (res.ok) {
    applyStateEverywhere(lemma, res.result.state);
    applyStudyDetails(word, res.result);
  }
  const decks = res.ok ? res.result.decks.map((deck) => deck.name).join(", ") : "";
  return { ok: res.ok, message: res.ok ? `${res.result.created ? "Saved" : "Already saved"} ${lemma}${decks ? ` · ${decks}` : ""}` : res.error };
}

// Park as learned (out of review rotation).
export async function markKnown(word: HTMLElement): Promise<Outcome> {
  const lemma = lemmaOf(word);
  const res = await send({ type: "setState", lemma, state: "known" });
  if (res.ok) {
    applyStateEverywhere(lemma, res.state);
    word.dataset.state = res.state;
    delete word.dataset.intervals;
  }
  return { ok: res.ok, message: res.ok ? `${lemma} marked known` : res.error };
}
