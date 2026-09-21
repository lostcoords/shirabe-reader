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
