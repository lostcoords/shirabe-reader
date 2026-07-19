import { send, type Rating, type SentenceCapture, type StudyDetails } from "../common/messages.js";
import { loadConfig } from "../common/config.js";
import { applyStateEverywhere } from "./word.js";

// Mining + review actions shared by the popup buttons and the keyboard
// shortcuts. Each performs the network call, recolours every occurrence of the
// word on success, and returns a human message for the caller to surface
// (inline in the popup, or as a toast when fired from the keyboard).
export type Outcome = { ok: boolean; message: string; cardUrl?: string };

export const GRADES: Record<Rating, string> = { 1: "Again", 2: "Hard", 3: "Good", 4: "Easy" };
const INTERVAL_KEYS = { 1: "again", 2: "hard", 3: "good", 4: "easy" } as const;

export function applyStudyDetails(word: HTMLElement, details: StudyDetails): void {
  word.dataset.state = details.state;
  word.dataset.deckNames = details.decks.map((deck) => deck.name).join(", ");
  if (details.intervals) word.dataset.intervals = JSON.stringify(details.intervals);
  else delete word.dataset.intervals;
  // Never clear an existing cardId — a later states payload without one would
  // hide the "Open in Shirabe" link after a successful save.
  if (details.cardId != null) word.dataset.cardId = String(details.cardId);
}

/** Absolute URL of the card in Shirabe's study browser (card + mined context). */
export async function cardUrlFor(cardId: number | string): Promise<string> {
  const config = await loadConfig();
  const base = config.apiBase.replace(/\/$/, "");
  return `${base}/study/cards?card_id=${encodeURIComponent(String(cardId))}`;
}

/** Best URL for this word: exact card inspector, else search the card browser. */
export async function studyUrlForWord(word: HTMLElement): Promise<string> {
  if (word.dataset.cardUrl) return word.dataset.cardUrl;
  if (word.dataset.cardId) {
    const url = await cardUrlFor(word.dataset.cardId);
    word.dataset.cardUrl = url;
    return url;
  }
  const config = await loadConfig();
  const base = config.apiBase.replace(/\/$/, "");
  const lemma = word.dataset.lemma || word.dataset.surface || "";
  return `${base}/study/cards?q=${encodeURIComponent(lemma)}`;
}

async function rememberCard(word: HTMLElement, cardId: number | undefined): Promise<string | undefined> {
  if (cardId == null || !Number.isFinite(cardId)) return undefined;
  word.dataset.cardId = String(cardId);
  const url = await cardUrlFor(cardId);
  word.dataset.cardUrl = url;
  return url;
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
  // Snap the source image for the mined card (Shirabe chrome hidden). Sentence
  // text can be edited later in Shirabe. For a video subtitle, crop to the video
  // frame — the surrounding page (comments, sidebar, browser chrome) isn't the
  // scene the learner mined.
  const imageDataUrl = await capturePageScreenshot(videoFrameFor(word));
  return send({
    type: "save",
    lemma: lemmaOf(word),
    surface: word.dataset.surface,
    reading: word.dataset.reading,
    ...(config.preferredDeckId == null ? {} : { deckId: config.preferredDeckId }),
    ...(sentence ? { sentence } : {}),
    ...(rating == null ? {} : { rating }),
    ...(imageDataUrl ? { imageDataUrl } : {}),
  });
}

// The video a mined subtitle plays over, or null for an ordinary page word.
// data-media-timestamp is set on the caption context only when a video is
// present (YouTube/asbplayer/Netflix), so it's the signal that a crop applies.
function videoFrameFor(word: HTMLElement): HTMLVideoElement | null {
  if (!word.closest("[data-media-timestamp]")) return null;
  return document.querySelector("video");
}

/** Hide extension UI, snapshot the visible tab, restore UI, crop if asked. */
async function capturePageScreenshot(cropTo?: HTMLVideoElement | null): Promise<string | undefined> {
  const chrome = [...document.querySelectorAll<HTMLElement>(".sb-host, .sb-status-bar, .sb-toast")];
  const previous = chrome.map((el) => el.style.getPropertyValue("visibility"));
  for (const el of chrome) el.style.setProperty("visibility", "hidden", "important");
  await nextPaint();
  try {
    const res = await send({ type: "captureTab" });
    if (!res.ok) return undefined;
    if (!cropTo) return res.imageDataUrl;
    return (await cropToElement(res.imageDataUrl, cropTo)) ?? res.imageDataUrl;
  } finally {
    chrome.forEach((el, i) => {
      if (previous[i]) el.style.setProperty("visibility", previous[i]);
      else el.style.removeProperty("visibility");
    });
  }
}

// captureVisibleTab returns the whole viewport at device resolution. Map the
// element's CSS-pixel viewport rect onto that image (scale = image px per CSS
// px, so any zoom/DPR is handled) and redraw just that region. Returns undefined
// if the element isn't laid out or the crop can't be produced — the caller then
// keeps the full-frame shot rather than losing the image entirely.
async function cropToElement(dataUrl: string, element: HTMLElement): Promise<string | undefined> {
  const rect = element.getBoundingClientRect();
  if (rect.width < 1 || rect.height < 1) return undefined;
  const image = await loadImage(dataUrl).catch(() => undefined);
  if (!image) return undefined;

  const scaleX = image.naturalWidth / window.innerWidth;
  const scaleY = image.naturalHeight / window.innerHeight;
  const sx = Math.max(0, rect.left * scaleX);
  const sy = Math.max(0, rect.top * scaleY);
  const sw = Math.min(image.naturalWidth - sx, rect.width * scaleX);
  const sh = Math.min(image.naturalHeight - sy, rect.height * scaleY);
  if (sw < 1 || sh < 1) return undefined;

  const canvas = document.createElement("canvas");
  canvas.width = Math.round(sw);
  canvas.height = Math.round(sh);
  const context = canvas.getContext("2d");
  if (!context) return undefined;
  context.drawImage(image, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/jpeg", 0.82);
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("screenshot decode failed"));
    image.src = src;
  });
}

function nextPaint(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  });
}

// Grade a due card on Shirabe's 1–4 scale. POST /v1/srs/saves rejects new,
// early, and already-graded cards; saving is a separate action.
export async function grade(word: HTMLElement, rating: Rating): Promise<Outcome> {
  const lemma = lemmaOf(word);
  if (word.dataset.state !== "due") return { ok: false, message: `${lemma} is not due for review` };
  const res = await saveRequest(word, rating);
  let cardUrl: string | undefined;
  if (res.ok) {
    applyStateEverywhere(lemma, res.result.state);
    applyStudyDetails(word, res.result);
    cardUrl = await rememberCard(word, res.result.cardId);
  }
  const interval = res.ok ? res.result.intervals?.[INTERVAL_KEYS[rating]] : undefined;
  return { ok: res.ok, message: res.ok ? `${lemma} → ${GRADES[rating]}${interval ? ` · ${interval}` : ""}` : res.error, cardUrl };
}

// Add to the deck without grading.
export async function save(word: HTMLElement): Promise<Outcome> {
  const lemma = lemmaOf(word);
  const res = await saveRequest(word);
  let cardUrl: string | undefined;
  if (res.ok) {
    applyStateEverywhere(lemma, res.result.state);
    applyStudyDetails(word, res.result);
    // Prefer explicit cardId; also accept a nested card.id if the envelope shape drifts.
    const cardId = res.result.cardId ?? (res.result as { card?: { id?: number } }).card?.id;
    cardUrl = await rememberCard(word, cardId);
  }
  const decks = res.ok ? res.result.decks.map((deck) => deck.name).join(", ") : "";
  return {
    ok: res.ok,
    message: res.ok ? `${res.result.created ? "Saved" : "Already saved"} ${lemma}${decks ? ` · ${decks}` : ""}` : res.error,
    cardUrl,
  };
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
