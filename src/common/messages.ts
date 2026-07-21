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
};
export type SaveResult = StudyDetails & { created: boolean };
export type SentenceCapture = {
  text: string;
  translation?: string;
  url?: string;
  title?: string;
  capturedAt: string;
  integration?: string;
  mediaTimestampMs?: number;
  targetStart?: number;
  targetEnd?: number;
};
export type LookupHistoryItem = { query: string; headword: string; reading: string | null; lookedUpAt: string };
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
      type: "save"; lemma: string; surface?: string; reading?: string; deckId?: number; sentence?: SentenceCapture; rating?: Rating;
      imageDataUrl?: string; audioDataUrl?: string;
    }
  | { type: "decks" }
  | { type: "states"; lemmas: string[] }
  | { type: "lookupHistory" }
  | { type: "clearLookupHistory" }
  | { type: "pageMetrics"; metrics: PageMetrics }
  | { type: "activePageMetrics" } // popup asks what the active tab last measured
  | { type: "setState"; lemma: string; state: "known" | "reviewing" }
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
  | { ok: true; type: "decks"; decks: Deck[] }
  | { ok: true; type: "states"; states: Record<string, WordState>; details: Record<string, StudyDetails> }
  | { ok: true; type: "lookupHistory"; history: LookupHistoryItem[] }
  | { ok: true; type: "clearLookupHistory" }
  | { ok: true; type: "pageMetrics" }
  | { ok: true; type: "activePageMetrics"; metrics: PageMetrics | null }
  | { ok: true; type: "setState"; state: WordState }
  | { ok: true; type: "connect" }
  | { ok: true; type: "disconnect" }
  | { ok: true; type: "updateLanguages"; languages: GlossLanguage[] }
  | { ok: true; type: "audioClip"; dataUrl: string }
  | { ok: true; type: "captureTab"; imageDataUrl: string }
  | { ok: true; type: "telemetry" }
  | { ok: true; type: "status"; status: Status }
  | { ok: false; error: string };

// Narrow the reply to the request that produced it, so `res.tokens` is only
// reachable after a "parse" request, etc.
type ResponseFor<T extends Request["type"]> = Extract<Response, { ok: true; type: T }> | { ok: false; error: string };

export async function send<R extends Request>(request: R): Promise<ResponseFor<R["type"]>> {
  try {
    return await ext.runtime.sendMessage(request) as ResponseFor<R["type"]>;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      error: detail || "The extension background stopped. Reopen Shirabe and try again.",
    } as ResponseFor<R["type"]>;
  }
}
