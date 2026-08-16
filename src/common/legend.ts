import book from "./resources/legend.json" with { type: "json" };
import { uiLanguagesFrom, type GlossLanguage } from "./languages.js";

// The Legend, as the popup carries it: the same entries the website's Legend
// book shows, so tapping "Na-adjective" on a sense chip explains it in the card
// instead of sending the reader to a tab they have to come back from.
//
// Both halves are GENERATED from the server (`bin/rails extension:legend`,
// Extension::Legend), and that is the point rather than a convenience. Which
// entry explains a code is `SearchHelper#legend_slug`, forty-odd cases and four
// regex families; the text is `legend.terms.*` in the locale files. A hand-kept
// TypeScript copy of either is a copy that drifts, and a drifted legend is a
// confident wrong explanation, which is worse than no chip at all. So the codes
// arrive expanded (`adj-na` → `na-adjective`, every code the dictionary
// actually carries) and the terms arrive translated.
//
// A code with no entry is not a failure: the book explains what a learner can
// tell apart, and JMdict splits far finer than that. Those chips stay plain.

export type LegendTerm = { label: string; jp?: string; body: string; example?: string };

/** Which lookup names the entry for a code. The two are separate tables and
    must stay that way: the server's part-of-speech rules end in a catch-all for
    the verb classes, which reads the usage tag `vulg` as a verb. A chip always
    knows which kind of annotation it came from, so it never has to guess. */
export type LegendKind = "pos" | "usage";

type Book = { codes: Record<LegendKind, Record<string, string>>; terms: Record<string, Record<string, LegendTerm>> };

const legend = book as Book;

/** The entry explaining a JMdict code, in the first of the reader's languages
    that has one, or null where the book has nothing to say about it. */
export function legendTerm(code: string, kind: LegendKind, languages: readonly GlossLanguage[]): LegendTerm | null {
  const slug = legend.codes[kind]?.[code];
  if (!slug) return null;

  const translations = legend.terms[slug];
  if (!translations) return null;

  // English last, always: it is the language every entry is written in, so a
  // reader whose own language is missing an entry still gets an explanation.
  for (const locale of [ ...uiLanguagesFrom(languages), "en" ]) {
    const term = translations[locale];
    if (term) return term;
  }
  return null;
}
