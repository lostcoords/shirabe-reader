// Shared shapes that cross the content ↔ background boundary.

// A word's learning status, mirroring Shirabe's Card::STATES. `/api/v1/parse`
// stamps each word with the caller's state; "none" means the user has no card
// for it yet (not-yet-tracked). Ordered weakest → strongest, like the server.
export type WordState = "none" | "new" | "learning" | "due" | "retired";

// One token as the content script needs it: where it sits in the source text
// (UTF-16 offsets, matching the DOM), how to render furigana, and its state.
/** One word a span could be. Enough to render a choice and to save the one the
    reader picks: `entry` is the `(dictionary, sourceId)` identity the server
    calls `sourceId` + `dictionary`, and it is what a save travels under. */
export type TokenCandidate = {
  entry: string;
  headword: string;
  reading: string | null;
  common: boolean;
};

export type ParsedToken = {
  start: number;
  length: number;
  surface: string;
  reading: string | null; // hiragana reading, or null when no furigana needed
  lemma: string; // dictionary form: what we look up / save
  /** The dictionary entry this token resolved to, as the pack's stable
      `slug:sourceId` handle ("jmdict:1009470"): the same handle
      `Definition.entry` carries on a lookup, and the same `(dictionary,
      sourceId)` pair `/api/v1/parse` answers with. A lemma is what a form REDUCES
      to and the two tokenizers disagree about it by design, so this is what a
      save should travel under and what cross-engine parity is asserted on.
      Absent where the token resolved to no entry (a numeral, an unknown run). */
  entry?: string;
  /** Every word this span could be, best first, `candidates[0]` being the one
      `entry` names. The offline half of `POST /api/v1/words/identify`, and the
      same reason it exists: one answer is a claim we often cannot support. きみ
      is 君, 黄身 or 黍, and only the reader knows which they meant.

      Present only where the span resolved to something and more than one word
      claims it, so its absence means "no choice to offer" rather than "not
      computed". The parser has always had this list: `contextualCandidates`
      gathers it and greed threw the runners-up away at the last step.

      Read off the PRE-gate set, so it holds the words a spelling merely carries
      (君 for きみ) and not just the ones it names. The gate decides where to CUT
      and is right to refuse those; deciding which word this is, is the other
      question. See docs/specs/extension-parsing.md §3. */
  candidates?: TokenCandidate[];
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
// `tokens` is the cut the SITE read this line with, shipped in the pack. Mining
// this example carries it to the server, so the saved sentence keeps the words
// the learner was shown instead of being read again on arrival. Absent for a
// pack built before recipe 10.
export type Example = {
  japanese: string;
  translation: string | null;
  tokens?: { surface: string }[];
};

// A definition as shown in the hover popup: a faithful slice of the shirabe.org
// word card. Flattened from /api/v1/search (which already returns all of this).
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
