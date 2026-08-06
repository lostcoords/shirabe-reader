// Shared shapes that cross the content ↔ background boundary.

// A word's learning status, mirroring Shirabe's Card::STATES. `/v1/parse`
// stamps each word with the caller's state; "none" means the user has no card
// for it yet (not-yet-tracked). Ordered weakest → strongest, like the server.
export type WordState = "none" | "new" | "learning" | "due" | "retired";

// One token as the content script needs it: where it sits in the source text
// (UTF-16 offsets, matching the DOM), how to render furigana, and its state.
export type ParsedToken = {
  start: number;
  length: number;
  surface: string;
  reading: string | null; // hiragana reading, or null when no furigana needed
  lemma: string; // dictionary form: what we look up / save
  /** The dictionary entry this token resolved to, as the pack's stable
      `slug:sourceId` handle ("jmdict:1009470"): the same handle
      `Definition.entry` carries on a lookup, and the same `(dictionary,
      sourceId)` pair `/v1/parse` answers with. A lemma is what a form REDUCES
      to and the two tokenizers disagree about it by design, so this is what a
      save should travel under and what cross-engine parity is asserted on.
      Absent where the token resolved to no entry (a numeral, an unknown run). */
  entry?: string;
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
  /** 0-based sense position in the entry: sent back as `sensePositions` to scope a save. */
  position: number;
  source: string;
  /** Learner-facing labels ("Godan verb"): what the popup prints. */
  partsOfSpeech: string[];
  /** Raw JMdict codes (v5b, adj-i, prt): what styling and metrics match on.
      Offline packs carry them; the API path returns entity strings only. */
  posCodes?: string[];
  tags: string[];
  glosses: string[];
};

// An example sentence with its translation, from the pack's own sentence
// records. Plain text: shipping a token stream per sentence to make the words
// clickable would have cost several megabytes, and the parser can tokenize one
// locally if that ever earns its place.
export type Example = { japanese: string; translation: string | null };

// A definition as shown in the hover popup: a faithful slice of the shirabe.org
// word card. Flattened from /v1/search (which already returns all of this).
export type Definition = {
  headword: string;
  reading: string | null;
  /** The dictionary entry this hit came from, as the pack's stable
      `slug:sourceId` handle ("jmdict:2517580"). Sent back when the word is saved
      so the card LINKS to that entry (enrichment, drift-tracking) instead of
      landing as an orphan the learner has to relink by hand. Absent for a kanji,
      which is not a dictionary word. */
  entry?: string;
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
