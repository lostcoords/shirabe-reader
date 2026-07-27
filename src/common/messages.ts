import { ext } from "./browser.js";
import type { Definition, ParsedToken, WordState } from "./types.js";
import type { DictionaryStatus, PackManifest } from "./offline-dictionary.js";
import type { GlossLanguage } from "./languages.js";
import type { ClientReport } from "./telemetry.js";

// A grade on Shirabe's 1–4 FSRS scale, matching POST /v1/srs/reviews.
export type Rating = 1 | 2 | 3 | 4;
export type Deck = { id: number; name: string; visibility: "personal" | "school" };
export type DeckMembership = { id: number; name: string };
export type IntervalPreviews = { again: string; hard: string; good: string; easy: string };
export type StudyDetails = {
  state: WordState;
  decks: DeckMembership[];
  intervals?: IntervalPreviews;
  /** Shirabe card id — open `/study/cards?card_id=` to view card + mined context. */
  cardId?: number;
  /**
   * How many cards this word holds. A word can carry one per meaning, so `> 1`
   * means `cardId` reaches only one of them and the word deserves the card
   * browser filtered by lemma instead of a deep link.
   */
  cardCount?: number;
  /** 0-based sense positions this word already has cards for. */
  savedSensePositions?: number[];
  /** A card covers the whole word, so every meaning is already taken. */
  savedWholeWord?: boolean;
};
export type SaveResult = StudyDetails & { created: boolean };
// Grading returns the card's new state + next-grade previews, but not deck
// membership (grading a card never changes which decks hold it).
export type GradeResult = { state: WordState; intervals: IntervalPreviews; cardId?: number };
export type SentenceCapture = {
  text: string;
  translation?: string;
  /**
   * Where the line came from: omitted for one mined off the page (the server
   * reads that as `browser_extension`), `tatoeba` for one picked off the word's
   * example list, `manual` for one the learner typed.
   */
  origin?: "tatoeba" | "manual";
  url?: string;
  title?: string;
  capturedAt: string;
  integration?: string;
  mediaTimestampMs?: number;
  /** End of the mined line, so the card holds a range and not just a cue-in. */
  mediaEndMs?: number;
  targetStart?: number;
  targetEnd?: number;
  /** This line's own screenshot / clip — a written sentence can carry both. */
  imageDataUrl?: string;
  audioDataUrl?: string;
};
export type StateCounts = { known: number; learning: number; due: number; unknown: number };
export type PageMetrics = {
  occurrenceCoverage: number;
  uniqueCoverage: number;
  total: number;
  unique: number;
  occurrences: StateCounts;
  uniques: StateCounts;
  iPlusOne: number; // blocks on the page with exactly one unknown word
};

// What the action popup needs to render the connection state without holding
// the key itself.
export type Status = {
  connected: boolean;
  account: string;
  canWrite: boolean; // WRITE_SRS + entitled → mining buttons are usable
  entitled: boolean; // owner is SRS-entitled (Pro or a school member)
  connecting: boolean; // a device-login handshake is mid-flight
  apiBase: string;
};

// Content scripts and the action popup never touch the network or storage
// directly — the background worker owns the API key, the device-login
// handshake, and rate limiting. Everything goes through these.
export type Request =
  // `requestId` lets the content script cancel a batch whose blocks all scrolled
  // out of view before the local worker finished looking their words up.
  | { type: "parseBatch"; texts: string[]; requestId?: number }
  | { type: "cancelParse"; requestId: number }
  // Words and kanji are separate corpora, as on the web: a word search never
  // answers with a kanji. `kind: "kanji"` is the explicit kanji-breakdown path.
  | { type: "lookup"; query: string; kind?: "word" | "kanji" }
  | { type: "dictionaryStatus" }
  | { type: "installDictionary" }
  | { type: "removeDictionary" }
  | { type: "cancelDictionaryInstall" }
  | {
      type: "save"; lemma: string; surface?: string; reading?: string; deckId?: number; sentence?: SentenceCapture;
      // The dictionary entry the lemma came from ("jmdict:2517580"), so the saved
      // card links to it rather than landing as an orphan. Omitted when the word
      // was never looked up (nothing to link to), and the save still succeeds.
      entry?: string;
      // 0-based sense positions to scope the card to (empty/omitted = whole word).
      sensePositions?: number[];
      imageDataUrl?: string; audioDataUrl?: string;
      // The full capture form's extras (docs/plans/extension-card-form.md): a deck
      // typed instead of picked, the learner's own fields, every example the card
      // should link, and the card's own picture. A quick save sends none of them,
      // which is what leaves an existing card's notes and examples alone.
      newDeckName?: string;
      hint?: string;
      notes?: string;
      sentences?: SentenceCapture[];
      cardImageDataUrl?: string;
    }
  // Grade a due card on the 1–4 FSRS scale, by lemma (+reading). POST /v1/srs/reviews.
  | { type: "grade"; lemma: string; reading?: string; rating: Rating }
  | { type: "decks" }
  | { type: "states"; lemmas: string[] }
  | { type: "pageMetrics"; metrics: PageMetrics }
  | { type: "activePageMetrics" } // popup asks what the active tab last measured
  | { type: "setState"; lemma: string; state: "retired" | "reviewing" }
  | { type: "connect" } // begin device login; resolves with the code to show
  | { type: "disconnect" }
  | { type: "updateLanguages"; languages: GlossLanguage[] }
  // Fetch a pronunciation clip in the background (bypasses the page CSP that
  // blocks cross-origin media) and get it back as a playable data: URL.
  | { type: "audioClip"; url: string }
  // Capture the visible tab as a data URL. Content scripts hide Shirabe chrome
  // (popup + status bar) before requesting this so the mine image is clean.
  | { type: "captureTab" }
  // Page contexts can't reach the collector under a page CSP, so they forward
  // captured errors to the background worker, which batches and ships them.
  | { type: "telemetry"; report: ClientReport }
  | { type: "status" };

export type Response =
  | { ok: true; type: "parseBatch"; tokens: ParsedToken[][]; dictionaryInstalling?: boolean }
  | { ok: true; type: "cancelParse" }
  | { ok: true; type: "lookup"; definition: Definition | null; dictionaryInstalling?: boolean }
  | { ok: true; type: "dictionaryStatus"; dictionary: DictionaryStatus }
  // `manifest` is set when install finished immediately (already current).
  // Long installs return without it; the popup polls dictionaryStatus instead.
  | { ok: true; type: "installDictionary"; manifest?: PackManifest }
  | { ok: true; type: "removeDictionary" }
  | { ok: true; type: "cancelDictionaryInstall" }
  | { ok: true; type: "save"; result: SaveResult }
  | { ok: true; type: "grade"; result: GradeResult }
  | { ok: true; type: "decks"; decks: Deck[] }
  | { ok: true; type: "states"; states: Record<string, WordState>; details: Record<string, StudyDetails> }
  | { ok: true; type: "pageMetrics" }
  | { ok: true; type: "activePageMetrics"; metrics: PageMetrics | null }
  | { ok: true; type: "setState"; state: WordState; details: StudyDetails }
  | { ok: true; type: "connect" }
  | { ok: true; type: "disconnect" }
  | { ok: true; type: "updateLanguages"; languages: GlossLanguage[] }
  | { ok: true; type: "audioClip"; dataUrl: string }
  | { ok: true; type: "captureTab"; imageDataUrl: string }
  | { ok: true; type: "telemetry" }
  | { ok: true; type: "status"; status: Status }
  | Failure;

// A failed request. `error` is the sentence a *person* reads — it goes straight
// into the popup — while `detail` carries the exception dump for the options
// page and the console. They were one field, which is how a stack trace ended
// up rendered under a Save button. `status`/`code` come from the API response
// so callers can branch on the answer instead of pattern-matching prose.
export type Failure = { ok: false; error: string; detail?: string; status?: number; code?: string };

// Narrow the reply to the request that produced it, so `res.tokens` is only
// reachable after a "parse" request, etc.
type ResponseFor<T extends Request["type"]> = Extract<Response, { ok: true; type: T }> | Failure;

// "You need Pro to do that" is the one failure that isn't a failure: the request
// was understood and refused, and the honest UI is an upgrade offer. Saving,
// grading and marking known all answer this way for a free account
// (docs/specs/api.md §2 · specs/browser-extension.md §1).
export const isProRequired = (res: Failure): boolean => res.code === "PRO_REQUIRED" || res.status === 402;

export async function send<R extends Request>(request: R): Promise<ResponseFor<R["type"]>> {
  try {
    return await ext.runtime.sendMessage(request) as ResponseFor<R["type"]>;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      error: "The extension background stopped. Reopen Shirabe and try again.",
      ...(detail ? { detail } : {}),
    } as ResponseFor<R["type"]>;
  }
}
