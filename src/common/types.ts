// The page parser's own type, plus the card vocabulary re-exported from the SDK.
// `Definition` and everything under it belong to the card contract three
// surfaces share (packages/card/src/word-card/types.ts); this file is where the
// extension reads them from, so its importers do not each reach across.
export type {
  Definition, DeckMembership, Example, GlossRow, IntervalPreviews, KanjiDetail,
  PitchPattern, Sense, SenseChip, SenseScope, SenseXref, SourceHeadword, SourceTag, StudyDetails, TokenCandidate,
  WordForm, WordState,
} from "@shirabe-org/card/word-card";

import type { TokenCandidate, WordState } from "@shirabe-org/card/word-card/index";

export type ParsedToken = {
  start: number;
  length: number;
  surface: string;
  reading: string | null; // hiragana reading, or null when no furigana needed
  lemma: string; // dictionary form: what we look up / save
  inflection?: string[];
  inflectionBase?: string;
  components?: Array<{ surface: string; start: number; end: number; lemma?: string; reading?: string; pos?: string[] }>;
  entry?: string;
  /** Ordered card groups for this exact parsed span. */
  groups?: string[][];
  /** Same-span choices shown when the reader can pick another entry. */
  candidates?: TokenCandidate[];
  pos: string; // short POS label: "noun", "verb", "prt", …
  kind?: string;
  content: boolean; // true for meaning-bearing words (not particles/punctuation)
  state: WordState;
  frequency?: number | null; // corpus rank, used for local i+1 filtering
};

// One pitch-accent pattern: the downstep (0 = heiban), a type name, and the
// pre-generated clip to play (null when we have no audio for it).
