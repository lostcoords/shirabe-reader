import { send, type Rating } from "../common/messages.js";
import { applyStateEverywhere } from "./word.js";

// Mining + review actions shared by the popup buttons and the keyboard
// shortcuts. Each performs the network call, recolours every occurrence of the
// word on success, and returns a human message for the caller to surface
// (inline in the popup, or as a toast when fired from the keyboard).
export type Outcome = { ok: boolean; message: string };

export const GRADES: Record<Rating, string> = { 1: "Again", 2: "Hard", 3: "Good", 4: "Easy" };

const lemmaOf = (word: HTMLElement) => word.dataset.lemma ?? word.dataset.surface ?? "";

// Grade (and mine if new) on Shirabe's 1–4 scale. POST /v1/srs/saves
// find-or-creates the card by lemma, so this both mines and reviews.
export async function grade(word: HTMLElement, rating: Rating): Promise<Outcome> {
  const lemma = lemmaOf(word);
  const res = await send({ type: "save", lemma, rating });
  if (res.ok) applyStateEverywhere(lemma, res.state);
  return { ok: res.ok, message: res.ok ? `${lemma} → ${GRADES[rating]}` : res.error };
}

// Add to the deck without grading.
export async function save(word: HTMLElement): Promise<Outcome> {
  const lemma = lemmaOf(word);
  const res = await send({ type: "save", lemma });
  if (res.ok) applyStateEverywhere(lemma, res.state);
  return { ok: res.ok, message: res.ok ? `Saved ${lemma}` : res.error };
}

// Park as learned (out of review rotation).
export async function markKnown(word: HTMLElement): Promise<Outcome> {
  const lemma = lemmaOf(word);
  const res = await send({ type: "setState", lemma, state: "known" });
  if (res.ok) applyStateEverywhere(lemma, res.state);
  return { ok: res.ok, message: res.ok ? `${lemma} marked known` : res.error };
}
