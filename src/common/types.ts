// Shared shapes that cross the content ↔ background boundary.

import type { GlossLanguage } from "./languages.js";

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

/** One label on a sense: the short text a reader sees, the raw JMdict code
    behind it, and which family it belongs to. The family decides the colour, and
    it is the difference between "Godan verb" and "Usually kana": one says what
    the word IS and the other how it is USED, and a single grey run of text made
    them look like the same kind of claim. */
export type SenseChip = { label: string; code: string; category: "pos" | "field" | "misc" | "dialect" };

/** A sense's meaning in ONE language, tagged with which. A word glossed in both
    shows both, EN over ES or ES over EN as the reader's stack says, rather than
    the whole entry twice over. `lang` is the language the TEXT is in, which is
    not always the one asked for: a sense JMdict only glosses in English is an
    English row inside a Spanish reader's card, and saying so is the honest
    version of a fallback that used to print English under "Español". */
export type GlossRow = { lang: GlossLanguage; tag: string; text: string };

// One dictionary sense, mirroring how shirabe.org renders a meaning: POS chips,
// misc/field/dialect chips, and the meaning in each language on its own row.
export type Sense = {
  /** 0-based sense position in the entry: sent back as `sensePositions` to scope a save. */
  position: number;
  /** Named only when it adds something. Every ordinary word is JMdict, and a
      dictionary line on every sense of every card is a label nobody reads. */
  dictionary?: string;
  partsOfSpeech: SenseChip[];
  /** Raw JMdict codes (v5b, adj-i, prt): what styling and metrics match on.
      Offline packs carry them; the API path returns entity strings only. */
  posCodes?: string[];
  tags: SenseChip[];
  glosses: GlossRow[];
  /** The usage notes on THIS sense: "usu. in kana", "after the -te form of a
      verb". The one thing on a sense that changes how the word is USED rather
      than saying what it means, and the reason it is per sense and never carried
      down to the next: "usu. in kana" on sense 3 and not on sense 4 is a real
      difference between those two senses. */
  notes?: string[];
  /** Words this sense points at: what it is related to, and what it is the
      opposite of. Absent where the dictionary records neither. */
  xrefs?: SenseXref[];
};

/** A cross reference: the word, its reading when the dictionary knows one, and
    what kind of link it is. */
export type SenseXref = { kind: "related" | "antonym"; text: string; reading?: string };

// An example sentence with its translation, from the pack's own sentence
// records. Plain text: shipping a token stream per sentence to make the words
// clickable would have cost several megabytes, and the parser can tokenize one
// locally if that ever earns its place.
// `tokens` is the cut the SITE read this line with, shipped in the pack. Mining
// this example carries it to the server, so the saved sentence keeps the words
// the learner was shown instead of being read again on arrival. Absent for a
// pack built before recipe 10.
//
// `lemma` is what makes the line READABLE rather than merely cut: it is how the
// example knows which of its words is the one being looked up (食べました is 食べる,
// and no comparison of surfaces can say so), and it rides along free because the
// pack already stores it. Mining still sends surfaces alone: see `card-form`.
export type Example = {
  japanese: string;
  translation: string | null;
  tokens?: { surface: string; lemma?: string }[];
};

// A definition as shown in the hover popup: a faithful slice of the shirabe.org
// word card. Flattened from /api/v1/search (which already returns all of this).
/** Another spelling of the same word. `rare` is JMdict's own judgement (`rK`,
    `oK`): shown, because a reader who met it needs to find it, but never as
    loudly as a spelling in ordinary use. */
export type WordForm = { text: string; common: boolean; rare: boolean };

/** What KANJIDIC knows about a character, on a card that IS a character. The
    single `reading` a word card carries cannot say it: a kanji has readings in
    the plural, and which kind they are is most of what a learner is asking. */
export type KanjiDetail = { on: string[]; kun: string[]; strokes?: number; grade?: number };

export type Definition = {
  headword: string;
  reading: string | null;
  /** Every other spelling this word is written with, headword and displayed
      reading excluded (they are already at the top of the card). Absent for a
      word written exactly one way, which is most of them. */
  forms?: WordForm[];
  kanji?: KanjiDetail;
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
