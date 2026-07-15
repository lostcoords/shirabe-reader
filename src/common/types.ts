// Shared shapes that cross the content ↔ background boundary.

// A word's learning status, mirroring Shirabe's Card::STATES. `/v1/parse`
// stamps each word with the caller's state; "none" means the user has no card
// for it yet (not-yet-tracked). Ordered weakest → strongest, like the server.
export type WordState = "none" | "new" | "learning" | "due" | "known";

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
  frequency?: number | null; // corpus rank, used for local i+1 filtering
};

// One pitch-accent pattern: the downstep (0 = heiban), a type name, and the
// pre-generated clip to play (null when we have no audio for it).
export type PitchPattern = { downstep: number; audioUrl: string | null };

// One dictionary sense, mirroring how shirabe.org renders a meaning: a source
// label ("Español · JMdict"), POS chips, misc/field/dialect tags, and glosses.
export type Sense = {
  source: string;
  partsOfSpeech: string[];
  tags: string[];
  glosses: string[];
};

// One token of an example sentence. Content words carry a word-page `url` (so
// they're clickable); particles have `url: null` and render as plain text.
// `matched` marks the looked-up word so we can highlight it.
export type SentenceToken = { surface: string; url: string | null; matched: boolean };

// An example sentence with its translation (from ?include=sentences). `tokens`
// is the sentence rendered as clickable words; empty when the server didn't
// tokenize it (older server), in which case the popup shows plain `japanese`.
export type Example = { japanese: string; translation: string | null; tokens: SentenceToken[] };

// A definition as shown in the hover popup — a faithful slice of the shirabe.org
// word card. Flattened from /v1/search (which already returns all of this).
export type Definition = {
  headword: string;
  reading: string | null;
  url: string; // the word's page on shirabe.org
  common: boolean;
  jlpt: string | null; // e.g. "N3"
  frequency: number | null; // corpus rank (lower = more common)
  pitch: PitchPattern[];
  senses: Sense[];
  examples: Example[];
  sourceForm?: string;
  inflection?: string[];
  offline?: boolean;
};
