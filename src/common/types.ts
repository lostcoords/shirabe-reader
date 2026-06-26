// Shared shapes that cross the content ↔ background boundary.

// A word's learning status, mirroring Shirabe's SRS vocabulary. Until the
// server exposes a per-user state endpoint, every parsed word comes back as
// "unknown" and the UI treats it as not-yet-tracked.
export type WordState =
  | "new"
  | "learning"
  | "known"
  | "due"
  | "ignored"
  | "unknown";

// One token as the content script needs it: where it sits in the source text
// (UTF-16 offsets, matching the DOM), how to render furigana, and its state.
export type ParsedToken = {
  start: number;
  length: number;
  surface: string;
  reading: string | null; // hiragana reading, or null when no furigana needed
  lemma: string; // dictionary form — what we look up / save
  pos: string; // short POS label: "noun", "verb", "prt", …
  content: boolean; // true for meaning-bearing words (not particles/punctuation)
  state: WordState;
};

// A definition as shown in the hover popup. Flattened from /v1/search.
export type Definition = {
  headword: string;
  reading: string | null;
  senses: Array<{ glosses: string[]; partsOfSpeech: string[] }>;
};
