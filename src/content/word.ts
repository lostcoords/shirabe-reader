import type { ParsedToken, TokenCandidate, WordState } from "../common/types.js";
import { appendFurigana, furiganaSegments, hasKanji, type FuriganaSegment } from "shirabe-sdk/word-card/furigana.js";

export { appendFurigana, furiganaSegments, hasKanji, type FuriganaSegment };

// Every interactive word renders into a `.sb-word` span and registers here,
// keyed by lemma, so a single review can recolour *every* occurrence on the
// page at once (jpd-breader's reverseIndex idea, kept tiny). Sets are pruned
// lazily: detached nodes are skipped on recolour, not tracked for removal.
const byLemma = new Map<string, Set<HTMLElement>>();

const STATE_CLASS = /sb-(none|new|learning|due|retired)/;

// The other words each span could be, for the popup's picker. A WeakMap rather
// than a `data-` attribute: a long page has thousands of ambiguous spans and
// this is a list of objects, so serializing it onto the DOM would cost bytes
// and a JSON round trip per hover for something only the popup ever reads.
// Keyed on the element, so it is collected with the element.
const candidatesByWord = new WeakMap<HTMLElement, TokenCandidate[]>();

// Every word the tapped span can name, best first, `[0]` being the one the
// parser chose. Empty where the span names one word, which is most of them.
export function candidatesFor(word: HTMLElement): TokenCandidate[] {
  return candidatesByWord.get(word) ?? [];
}

/** The cut of one sentence as the reader saw it, and which chip they mined. */
export type ShownCut = { surfaces: readonly string[]; index: number };

// The cut a mined line ACTUALLY carried, recorded when it was drawn. A save
// re-parsed `dataset.sentence` on its own instead, and that is a different
// question: the page tokenized the whole text node, with lookahead across the
// sentence boundary, so re-reading one sentence in isolation can come back cut
// differently. `targetIndex` was then dropped silently, which is exactly the
// case where the card most needs it: a line that reads two ways.
//
// Shared per sentence, so a twenty-word line holds one array and twenty
// references to it, and it dies with the page.
const cutByWord = new WeakMap<HTMLElement, ShownCut>();

export function rememberShownCut(word: HTMLElement, cut: ShownCut): void {
  cutByWord.set(word, cut);
}

export function shownCut(word: HTMLElement): ShownCut | undefined {
  return cutByWord.get(word);
}




// Builds the DOM for one parsed token. Content words become interactive,
// state-colored spans (optionally with furigana); particles and punctuation
// stay as plain text so the page reads naturally and only meaningful words
// invite a hover.
export function renderToken(token: ParsedToken, showFurigana: boolean): Node {
  if (!token.content) return document.createTextNode(token.surface);

  const word = document.createElement("span");
  word.className = `sb-word sb-${token.state}`;
  word.dataset.lemma = token.lemma;
  word.dataset.surface = token.surface;
  word.dataset.state = token.state; // popup reads this to gate the review buttons
  // The entry the parser landed on, so a save carries the word's IDENTITY and not
  // just the form this engine reduced it to. Without it `entryFor` has to go back
  // to the dictionary keyed on the lemma, which is the one field the two
  // tokenizers disagree about by design: a save that travels under it can land on
  // a different word than the same save from the website, and the learner ends up
  // with two cards for one word.
  if (token.entry) word.dataset.entry = token.entry;
  // Present only where the span names more than one word, so the popup can test
  // for a picker rather than counting a list that is usually one long.
  if (token.candidates?.length) candidatesByWord.set(word, token.candidates);
  if (token.pos) word.dataset.pos = token.pos; // i+1 reads this to tell context words from copulas
  if (token.frequency != null) word.dataset.frequency = String(token.frequency);
  if (token.reading) word.dataset.reading = token.reading;

  if (showFurigana && token.reading && hasKanji(token.surface)) {
    const reading = surfaceReading(token.surface, token.lemma, token.reading);
    if (reading) appendFurigana(word, token.surface, reading);
    else word.textContent = token.surface; // irregular reading we can't align: plain
  } else {
    word.textContent = token.surface;
  }

  register(token.lemma, word);
  return word;
}

// The kanji stem of 来る/為る changes reading by conjugation (来る く, 来て き, 来ない
// こ), so an inflected surface can't be aligned from the dictionary reading alone :
// unlike every regular verb, where the stem reading is invariant.
const IRREGULAR_STEM_LEMMAS = new Set(["来る", "來る", "為る"]);

// The reading of the INFLECTED surface, derived from the dictionary form, or null
// when it can't be trusted (skip furigana rather than show a wrong reading). A
// token carries the dictionary reading (授ける → さずける), but furigana must sit over
// the on-screen surface (授けて → さずけて), or an inflected okurigana won't align and
// the whole reading floats over the word. When the surface and the lemma share
// their kanji stem and differ only in trailing okurigana: the ordinary verb /
// adjective inflection: swap the dictionary okurigana for the surface's. Anything
// else (no kanji stem, mismatched stem) keeps the dictionary reading.
function surfaceReading(surface: string, lemma: string, reading: string): string | null {
  if (!lemma || surface === lemma) return reading;
  if (IRREGULAR_STEM_LEMMAS.has(lemma)) return null; // 来て etc.: reading isn't derivable
  const stem = kanjiStem(lemma);
  if (!stem || !surface.startsWith(stem)) return reading;
  const dictOkurigana = lemma.slice(stem.length);
  if (!dictOkurigana || !reading.endsWith(dictOkurigana)) return reading;
  return reading.slice(0, reading.length - dictOkurigana.length) + surface.slice(stem.length);
}

// The word up to and including its last kanji, dropping trailing okurigana:
// 授ける → 授, 取り扱う → 取り扱, この → "" (no kanji).
function kanjiStem(word: string): string {
  const chars = [...word];
  let last = -1;
  for (let i = 0; i < chars.length; i++) if (hasKanji(chars[i])) last = i;
  return last === -1 ? "" : chars.slice(0, last + 1).join("");
}

// therefore add ruby in place without reparsing or changing token boundaries.
export function ensureFurigana(): void {
  for (const word of document.querySelectorAll<HTMLElement>(".sb-word[data-reading]")) {
    if (word.querySelector("ruby")) continue;
    const reading = word.dataset.reading;
    const surface = word.dataset.surface;
    if (!reading || !surface || !hasKanji(surface)) continue;
    const aligned = surfaceReading(surface, word.dataset.lemma ?? surface, reading);
    if (!aligned) continue; // irregular reading: leave it as plain text
    word.replaceChildren();
    appendFurigana(word, surface, aligned);
  }
}

function register(lemma: string, word: HTMLElement): void {
  let set = byLemma.get(lemma);
  if (!set) byLemma.set(lemma, (set = new Set()));
  set.add(word);
}

// Reflect a freshly-set learning state on one already-rendered word.
function applyState(word: HTMLElement, state: WordState): void {
  word.className = word.className.replace(STATE_CLASS, `sb-${state}`);
  word.dataset.state = state; // keep the popup's gating in sync after a review
}

// …and on every other occurrence of the same word, so the whole page agrees
// after a review. Returns detached nodes to its caller's GC by dropping them.
export function applyStateEverywhere(lemma: string, state: WordState): void {
  const set = byLemma.get(lemma);
  if (!set) return;
  for (const word of set) {
    if (word.isConnected) applyState(word, state);
    else set.delete(word);
  }
}
