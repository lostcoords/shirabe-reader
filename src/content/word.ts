import type { ParsedToken, WordState } from "../common/types.js";

// Every interactive word renders into a `.sb-word` span and registers here,
// keyed by lemma, so a single review can recolour *every* occurrence on the
// page at once (jpd-breader's reverseIndex idea, kept tiny). Sets are pruned
// lazily — detached nodes are skipped on recolour, not tracked for removal.
const byLemma = new Map<string, Set<HTMLElement>>();

const STATE_CLASS = /sb-(none|new|learning|due|known)/;

// Furigana only earns its place over words that actually contain kanji — a
// kana-only surface (この, では, アクセント) reads its own reading, so ruby there
// is just noise. 々〇〻 count as kanji so 人々 and the like keep their gloss.
const KANJI = /[\p{Script=Han}々〆〇〻]/u;
export const hasKanji = (surface: string): boolean => KANJI.test(surface);

export type FuriganaSegment = { text: string; ruby?: string };

// Distribute a reading across a surface so furigana sits ONLY over kanji runs,
// leaving okurigana and other kana as plain text (食べる → 食[た] + べる, not
// たべる floating over the whole word). Each surface run of kanji claims the
// stretch of reading up to where the following kana run reappears; kana runs
// pass through unchanged. If the reading can't be aligned (irregular/jukujikun
// readings, unexpected katakana), it falls back to one whole-word ruby — still
// correct, just not split. Katakana is folded to hiragana only for matching.
export function furiganaSegments(surface: string, reading: string): FuriganaSegment[] {
  const whole: FuriganaSegment[] = [{ text: surface, ruby: reading }];
  const runs = surfaceRuns(surface);
  const readingHira = kataToHira(reading);
  const segments: FuriganaSegment[] = [];
  let cursor = 0; // position within `reading`

  for (let i = 0; i < runs.length; i++) {
    const run = runs[i];
    if (!run.kanji) {
      const kana = kataToHira(run.text);
      if (readingHira.slice(cursor, cursor + kana.length) !== kana) return whole;
      segments.push({ text: run.text });
      cursor += kana.length;
      continue;
    }
    const next = runs[i + 1]; // always a kana run when present
    let end: number;
    if (!next) {
      end = reading.length;
    } else {
      const at = readingHira.indexOf(kataToHira(next.text), cursor + 1);
      if (at === -1) return whole;
      end = at;
    }
    if (end <= cursor) return whole; // a kanji with no reading of its own — bail
    segments.push({ text: run.text, ruby: reading.slice(cursor, end) });
    cursor = end;
  }

  return cursor === reading.length ? segments : whole;
}

// Split a surface into maximal runs of kanji vs. everything else, iterating by
// code point so astral-plane kanji stay intact.
function surfaceRuns(surface: string): Array<{ text: string; kanji: boolean }> {
  const runs: Array<{ text: string; kanji: boolean }> = [];
  for (const ch of surface) {
    const kanji = hasKanji(ch);
    const last = runs[runs.length - 1];
    if (last && last.kanji === kanji) last.text += ch;
    else runs.push({ text: ch, kanji });
  }
  return runs;
}

const kataToHira = (text: string): string =>
  text.replace(/[ァ-ヶ]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0x60));

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
  if (token.frequency != null) word.dataset.frequency = String(token.frequency);
  if (token.reading) word.dataset.reading = token.reading;

  if (showFurigana && token.reading && hasKanji(token.surface)) {
    const ruby = document.createElement("ruby");
    ruby.append(token.surface);
    const rt = document.createElement("rt");
    rt.textContent = token.reading;
    ruby.append(rt);
    word.append(ruby);
  } else {
    word.textContent = token.surface;
  }

  register(token.lemma, word);
  return word;
}

// A page parsed while furigana was Off contains plain word spans, but every
// span retains its reading in data-reading. Switching to a visible mode can
// therefore add ruby in place without reparsing or changing token boundaries.
export function ensureFurigana(): void {
  for (const word of document.querySelectorAll<HTMLElement>(".sb-word[data-reading]")) {
    if (word.querySelector("ruby")) continue;
    const reading = word.dataset.reading;
    const surface = word.dataset.surface;
    if (!reading || !surface || !hasKanji(surface)) continue;
    const ruby = document.createElement("ruby");
    ruby.append(surface);
    const rt = document.createElement("rt");
    rt.textContent = reading;
    ruby.append(rt);
    word.replaceChildren(ruby);
  }
}

function register(lemma: string, word: HTMLElement): void {
  let set = byLemma.get(lemma);
  if (!set) byLemma.set(lemma, (set = new Set()));
  set.add(word);
}

// Reflect a freshly-set learning state on one already-rendered word.
export function applyState(word: HTMLElement, state: WordState): void {
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
