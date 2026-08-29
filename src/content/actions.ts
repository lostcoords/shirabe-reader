import { isProRequired, send, type Failure, type Rating, type SentenceCapture, type StudyDetails } from "../common/messages.js";
import { loadConfig } from "../common/config.js";
import { captureSentenceAudio } from "./sentence-audio.js";
import { type Cue, cueFor } from "./cues.js";
import { applyStateEverywhere, shownCut } from "./word.js";

// Mining + review actions shared by the popup buttons and the keyboard
// shortcuts. Each performs the network call, recolours every occurrence of the
// word on success, and returns a human message for the caller to surface
// (inline in the popup, or as a toast when fired from the keyboard).
export type Outcome = { ok: boolean; message: string; cardUrl?: string; proRequired?: boolean };

// Every write shares one refusal: the server's own sentence, plus the flag that
// turns "needs Pro" from an error into an offer. Free accounts read and look up
// all day: saving is the line (specs/browser-extension.md §1).
function refusal(res: Failure): Outcome {
  return isProRequired(res)
    ? { ok: false, message: "Saving to your reviews is part of Pro.", proRequired: true }
    : { ok: false, message: res.error };
}

export const GRADES: Record<Rating, string> = { 1: "Again", 2: "Hard", 3: "Good", 4: "Easy" };

// Reviewing stays on the site for now, so the reader matches what a dictionary
// result there offers: what the word is, and a way into its card. Grading wants
// the review history and interval previews around it to mean anything, and the
// popup is the wrong size for that argument. `grade` and its callers stay wired
// up behind this: flipping it back on is the whole change.
export const REVIEW_IN_READER = false;
const INTERVAL_KEYS = { 1: "again", 2: "hard", 3: "good", 4: "easy" } as const;

// Four callers feed this: a save response, a state change, and two reads of a
// cache that outlives the build that wrote it. `decks` is only ever a label, so
// none of them is worth throwing over: a missing list means no deck line, not a
// dead Save button. (It threw here for real: a snapshot written back when the
// field was `memberships` deserializes without it.)
export function applyStudyDetails(word: HTMLElement, details: StudyDetails): void {
  word.dataset.state = details.state;
  word.dataset.deckNames = (details.decks ?? []).map((deck) => deck.name).join(", ");
  if (details.intervals) word.dataset.intervals = JSON.stringify(details.intervals);
  else delete word.dataset.intervals;
  // Never clear an existing cardId: a later states payload without one would
  // hide the "Open in Shirabe" link after a successful save.
  if (details.cardId != null) word.dataset.cardId = String(details.cardId);
  // Which meanings are taken, for the sense picker. Written as a plain list so
  // the picker reads it without parsing JSON, and cleared when nothing is
  // covered: a stale list would grey out a meaning you can still save.
  const covered = details.savedWholeWord ? "all" : (details.savedSenses ?? []).join(",");
  if (covered) word.dataset.savedSenses = covered;
  else delete word.dataset.savedSenses;
  if (details.cardCount != null && details.cardCount !== Number(word.dataset.cardCount)) {
    word.dataset.cardCount = String(details.cardCount);
    // Saving a second meaning turns a deep link into a half-truth; re-resolve it.
    delete word.dataset.cardUrl;
  }
}

/** Absolute URL of the card in Shirabe's study browser (card + mined context). */
export async function cardUrlFor(cardId: number | string): Promise<string> {
  const config = await loadConfig();
  const base = config.apiBase.replace(/\/$/, "");
  return `${base}/study/cards?card_id=${encodeURIComponent(String(cardId))}`;
}

/** Best URL for this word: exact card inspector, else search the card browser. */
// Where Manage goes. One card: straight to it, with its mined sentence context.
// Several (a card per meaning): the card browser filtered by the word, because
// `cardId` names whichever card was touched last and deep-linking it would leave
// the others unreachable: the reader would show you a word and reach one of it.
export async function studyUrlForWord(word: HTMLElement): Promise<string> {
  if (word.dataset.cardUrl) return word.dataset.cardUrl;
  const single = Number(word.dataset.cardCount ?? "1") <= 1;
  if (word.dataset.cardId && single) {
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

// A raw-text scan hands us a detached `<span>`: it never entered the page: so
// `closest()` on it finds nothing: no caption context, no source URL, no media
// timestamp. The popup registers where the scan actually came from, so mining a
// subtitle the caption parser hasn't wrapped yet still resolves its integration
// and timestamp instead of silently saving as a plain web page.
const scanOrigin = new WeakMap<HTMLElement, Element>();

export function setScanOrigin(word: HTMLElement, origin: Element | null | undefined): void {
  if (origin) scanOrigin.set(word, origin);
}

const contextOf = (word: HTMLElement): Element | null => (word.isConnected ? word : scanOrigin.get(word) ?? null);

async function sentenceOf(word: HTMLElement, cue?: Cue | null): Promise<SentenceCapture | undefined> {
  const text = word.dataset.sentence?.trim();
  if (!text) return;
  // Our cut of the line, and which chip of it the learner mined. We are the only
  // thing that ever held this page, so this is the only tokenization of the
  // sentence that exists: send none and the server reads it again with Sudachi,
  // and the card ends up pointing into a sentence cut differently from the one
  // on screen.
  //
  // The cut the reader SAW first, off the record the renderer left; a re-parse
  // only where there is none (a raw-text scan, a caption adapter, a rewritten
  // line). Best-effort either way: a failure here must never cost the card.
  //
  // The character offsets this used to send went with it: the server filed them
  // in a blob nothing read, and an index into the cut answers the same question
  // exactly, against an array both sides hold.
  const cut = cutOf(word, text) ?? await reparsedCut(text, numberFrom(word.dataset.targetStart));
  // Both ends of the line, so the card can point back at the moment it came
  // from: and so a clip can be re-cut later without mining the word again.
  // The cue wins where there is one: it knows the sentence may have spanned
  // several caption lines, which the element's own stamp does not.
  const mediaTimestampMs = cue?.startMs ?? numberFrom(contextOf(word)?.closest<HTMLElement>("[data-media-timestamp]")?.dataset.mediaTimestamp);
  const mediaEndMs = cue?.endMs;
  return {
    text,
    ...(word.dataset.translation ? { translation: word.dataset.translation } : {}),
    url: contextOf(word)?.closest<HTMLElement>("[data-source-url]")?.dataset.sourceUrl || location.href,
    title: document.title,
    capturedAt: new Date().toISOString(),
    integration: contextOf(word)?.closest<HTMLElement>("[data-integration]")?.dataset.integration || "web_page",
    ...(mediaTimestampMs == null ? {} : { mediaTimestampMs }),
    ...(mediaEndMs == null ? {} : { mediaEndMs }),
    ...(cut ? cut : {}),
  };
}

// The line as we read it, plus which token starts at `targetStart`. Returns
// nothing rather than throwing: the cut is advisory, the server drops one that
// does not rebuild the text anyway, and no save is worth losing over it.
type Cut = { tokens: { surface: string }[]; targetIndex?: number };

// The cut the reader actually saw, recorded when the line was drawn. Preferred
// over re-parsing for the reason the re-parse exists to serve: the card should
// point into the sentence that was ON SCREEN. `dataset.sentence` read on its own
// can come back cut differently, because the parse that drew it had the rest of
// the text node to look ahead into, and the mismatch dropped `targetIndex`
// silently in exactly the lines that read two ways.
//
// Guarded on the text, so a caption that rewrote itself under a stale record
// falls through to the re-parse rather than describing a line nobody read.
function cutOf(word: HTMLElement, text: string): Cut | undefined {
  const shown = shownCut(word);
  if (!shown || shown.surfaces.join("") !== text) return;

  return { tokens: shown.surfaces.map((surface) => ({ surface })), targetIndex: shown.index };
}

async function reparsedCut(text: string, targetStart: number | undefined): Promise<Cut | undefined> {
  try {
    // Through the worker: the pack lives in ITS IndexedDB, not the page's.
    const res = await send({ type: "parseBatch", texts: [text] });
    if (!res.ok || res.type !== "parseBatch") return;

    const tokens = (res.tokens[0] ?? []).map((token) => ({ surface: token.surface }));
    if (!tokens.length || tokens.map((token) => token.surface).join("") !== text) return;

    // UTF-16 code units, because that is what `targetStart` counts: it comes from
    // a DOM text-node offset. Counting code points here instead would drift by
    // one per astral character (𠮟, an emoji, a variation selector) and point at
    // the wrong word in exactly the lines where surrogate pairs turn up.
    let at = 0;
    let targetIndex: number | undefined;
    for (const [index, token] of tokens.entries()) {
      if (at === targetStart) { targetIndex = index; break; }
      at += token.surface.length;
    }
    return targetIndex == null ? { tokens } : { tokens, targetIndex };
  } catch {
    return;
  }
}

function numberFrom(value: string | undefined): number | undefined {
  if (value == null || value === "") return;
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : undefined;
}

// Everything a save carries about the page: the mined line, the frame it was on,
// and the clip of it being spoken. The full capture form needs the same bundle
// the quick save posts, so it is collected once here and used by both.
export async function captureFor(word: HTMLElement): Promise<{ sentence?: SentenceCapture; imageDataUrl?: string; audioDataUrl?: string }> {
  const video = videoFrameFor(word);
  const imageDataUrl = await captureScreenshot(video);
  const cue = video ? cueOf(word, video) : null;
  const audioDataUrl = cue && video ? await captureSentenceAudio(video, cue) : undefined;
  return { sentence: (await sentenceOf(word, cue)) ?? undefined, imageDataUrl, audioDataUrl };
}

// The dictionary entry to link the card to. The popup stamps it on the word it
// resolved, but a shortcut fires on whatever is HOVERED: and in modifier mode
// that word's popup may never have opened, so nothing looked it up. Ask then:
// the background answers from the installed pack through its own LRU, which is
// nothing beside the screenshot this save is already taking, and it is the whole
// difference between a linked card and an orphan.
async function entryFor(word: HTMLElement): Promise<string | undefined> {
  if (word.dataset.entry) return word.dataset.entry;
  const res = await send({ type: "lookup", query: lemmaOf(word) });
  const entry = res.ok ? res.definition?.entry : undefined;
  if (entry) word.dataset.entry = entry;
  return entry;
}

async function saveRequest(word: HTMLElement, senseRefs?: string[]) {
  const config = await loadConfig();
  // Snap the source image for the mined card (Shirabe chrome hidden). Sentence
  // text can be edited later in Shirabe. For a video subtitle that's the video
  // frame: the surrounding page (comments, sidebar, browser chrome) isn't the
  // scene the learner mined.
  const video = videoFrameFor(word);
  const imageDataUrl = await captureScreenshot(video);
  // Resolved once and shared: the clip and the range the card records have to
  // describe the same span, and the range is worth storing even when the audio
  // isn't recorded: it is what makes a clip re-cuttable later.
  const cue = video ? cueOf(word, video) : null;
  // Then the line as it was spoken. After the frame, never in parallel: the
  // replay moves the playhead, so a screenshot racing it would catch some other
  // moment of the video.
  const audioDataUrl = cue && video ? await captureSentenceAudio(video, cue) : undefined;
  const sentence = await sentenceOf(word, cue);
  return send({
    type: "save",
    lemma: lemmaOf(word),
    surface: word.dataset.surface,
    reading: word.dataset.reading,
    entry: await entryFor(word),
    ...(config.preferredDeckId == null ? {} : { deckId: config.preferredDeckId }),
    ...(sentence ? { sentence } : {}),
    ...(senseRefs?.length ? { senses: senseRefs } : {}),
    ...(imageDataUrl ? { imageDataUrl } : {}),
    ...(audioDataUrl ? { audioDataUrl } : {}),
  });
}

// The video a mined subtitle plays over, or null for an ordinary page word.
// data-media-timestamp is set on the caption context only when a video is
// present (YouTube/asbplayer/Netflix), so it's the signal that a frame applies.
function videoFrameFor(word: HTMLElement): HTMLVideoElement | null {
  if (!contextOf(word)?.closest("[data-media-timestamp]")) return null;
  // A page can hold several players at once: YouTube keeps an ad slot and hover
  // previews around the real one: so take the biggest one actually on screen
  // rather than whichever comes first in the DOM.
  const onScreen = [...document.querySelectorAll("video")]
    .map((video) => ({ video, rect: video.getBoundingClientRect() }))
    .filter(({ rect }) => rect.width >= 1 && rect.height >= 1);
  onScreen.sort((a, b) => b.rect.width * b.rect.height - a.rect.width * a.rect.height);
  return onScreen[0]?.video ?? null;
}

/** The span this word's sentence occupies in the video, if it came off a caption. */
function cueOf(word: HTMLElement, video: HTMLVideoElement): Cue | null {
  const caption = contextOf(word)?.closest<HTMLElement>("[data-media-timestamp]");
  return caption ? cueFor(caption, video, word.dataset.sentence) : null;
}

/**
 * The image for a mined card: the video frame when the word came off a subtitle,
 * else a screenshot of the page with our own UI hidden.
 */
async function captureScreenshot(video: HTMLVideoElement | null): Promise<string | undefined> {
  return (video ? drawVideoFrame(video) : undefined) ?? (await capturePageScreenshot(video));
}

const MAX_FRAME_EDGE = 1920;

// Read the frame straight off the <video>. Better than cropping a tab capture on
// every count: it's the frame's own resolution rather than however small the
// player is on screen, it needs no host permission, and nothing painted over the
// video: our popup included: can end up in it.
//
// Returns undefined when the frame can't be read: no decoded frame yet, or a
// canvas tainted by DRM (Netflix), where drawing "works" and reading back
// throws. The caller then falls back to capturing the tab.
function drawVideoFrame(video: HTMLVideoElement): string | undefined {
  if (!video.videoWidth || !video.videoHeight) return undefined;

  // Nothing resizes these later and a card shows the image a few hundred pixels
  // wide, so a 4K frame would be megabytes of detail nobody sees.
  const scale = Math.min(1, MAX_FRAME_EDGE / Math.max(video.videoWidth, video.videoHeight));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(video.videoWidth * scale);
  canvas.height = Math.round(video.videoHeight * scale);
  const context = canvas.getContext("2d");
  if (!context) return undefined;

  try {
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    // Protected media composites as black rather than failing, so a frame with
    // no light anywhere in it is a capture that didn't happen.
    if (isBlank(context, canvas)) return undefined;
    return canvas.toDataURL("image/jpeg", 0.82);
  } catch {
    return undefined;
  }
}

/** True when every sampled pixel is pure black: a protected or undecoded frame. */
function isBlank(context: CanvasRenderingContext2D, canvas: HTMLCanvasElement): boolean {
  // max(1) or a tiny frame divides down to a zero step and never advances.
  const step = { x: Math.max(1, Math.floor(canvas.width / 4)), y: Math.max(1, Math.floor(canvas.height / 4)) };
  for (let x = step.x; x < canvas.width; x += step.x) {
    for (let y = step.y; y < canvas.height; y += step.y) {
      const [r, g, b] = context.getImageData(x, y, 1, 1).data;
      if (r || g || b) return false;
    }
  }
  return true;
}

/** Hide extension UI, snapshot the visible tab, restore UI, crop if asked. */
async function capturePageScreenshot(cropTo?: HTMLVideoElement | null): Promise<string | undefined> {
  const chrome = [...document.querySelectorAll<HTMLElement>(".sb-host, .sb-toast")];
  for (const el of chrome) el.classList.add("sb-capturing");
  await nextPaint();
  try {
    const res = await send({ type: "captureTab" });
    if (!res.ok) return undefined;
    if (!cropTo) return res.imageDataUrl;
    return (await cropToElement(res.imageDataUrl, cropTo)) ?? res.imageDataUrl;
  } finally {
    for (const el of chrome) el.classList.remove("sb-capturing");
  }
}

// captureVisibleTab returns the whole viewport at device resolution. Map the
// element's CSS-pixel viewport rect onto that image (scale = image px per CSS
// px, so any zoom/DPR is handled) and redraw just that region. Returns undefined
// if the element isn't laid out or the crop can't be produced: the caller then
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

// Grade a due card on Shirabe's 1–4 scale via POST /api/v1/srs/reviews, which rejects
// a word that isn't currently due. Grading lives apart from saving now.
export async function grade(word: HTMLElement, rating: Rating): Promise<Outcome> {
  const lemma = lemmaOf(word);
  if (word.dataset.state !== "due") return { ok: false, message: `${lemma} is not due for review` };
  const res = await send({ type: "grade", lemma, reading: word.dataset.reading, rating });
  let cardUrl: string | undefined;
  if (res.ok) {
    applyStateEverywhere(lemma, res.result.state);
    // Grading returns no deck list (membership is unchanged), so update state +
    // interval previews + cardId directly rather than via applyStudyDetails.
    word.dataset.state = res.result.state;
    word.dataset.intervals = JSON.stringify(res.result.intervals);
    cardUrl = await rememberCard(word, res.result.cardId);
  }
  const interval = res.ok ? res.result.intervals?.[INTERVAL_KEYS[rating]] : undefined;
  if (!res.ok) return { ...refusal(res), cardUrl };
  return { ok: true, message: `${lemma} → ${GRADES[rating]}${interval ? ` · ${interval}` : ""}`, cardUrl };
}

// Add to the deck without grading. `senses` scopes the card to a subset
// of the word's senses (empty/undefined = the whole word).
export async function save(word: HTMLElement, senseRefs?: string[]): Promise<Outcome> {
  const lemma = lemmaOf(word);
  const res = await saveRequest(word, senseRefs);
  let cardUrl: string | undefined;
  if (res.ok) {
    applyStateEverywhere(lemma, res.result.state);
    applyStudyDetails(word, res.result);
    // Prefer explicit cardId; also accept a nested card.id if the envelope shape drifts.
    const cardId = res.result.cardId ?? (res.result as { card?: { id?: number } }).card?.id;
    cardUrl = await rememberCard(word, cardId);
  }
  if (!res.ok) return { ...refusal(res), cardUrl };
  const decks = (res.result.decks ?? []).map((deck) => deck.name).join(", ");
  return {
    ok: true,
    message: `${res.result.created ? "Saved" : "Already saved"} ${lemma}${decks ? ` · ${decks}` : ""}`,
    cardUrl,
  };
}

// Park as learned (out of review rotation).
export async function markKnown(word: HTMLElement): Promise<Outcome> {
  const lemma = lemmaOf(word);
  const res = await send({ type: "setState", lemma, state: "retired" });
  if (res.ok) {
    applyStateEverywhere(lemma, res.state);
    // The answer describes the whole word: its state, its decks, how many cards
    // it holds: so Manage re-points itself without a second lookup.
    applyStudyDetails(word, res.details);
    delete word.dataset.intervals;
  }
  if (!res.ok) return refusal(res);
  return { ok: true, message: `${lemma} marked known` };
}
