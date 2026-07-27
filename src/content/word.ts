import type { ParsedToken, WordState } from "../common/types.js";

// Every interactive word renders into a `.sb-word` span and registers here,
// keyed by lemma, so a single review can recolour *every* occurrence on the
// page at once (jpd-breader's reverseIndex idea, kept tiny). Sets are pruned
// lazily — detached nodes are skipped on recolour, not tracked for removal.
const byLemma = new Map<string, Set<HTMLElement>>();

const STATE_CLASS = /sb-(none|new|learning|due|retired)/;

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

  // The surface is fully aligned. Any leftover reading is the inflectional
  // okurigana the dictionary form carries but the inflected surface dropped
  // (考える→考え: token reading かんがえる, surface reading only かんがえ). It can only
  // trail a final kana run — a trailing kanji run already consumes to the end —
  // so keep furigana over the kanji and let the unused tail (る) fall away,
  // instead of smearing the whole dictionary reading over the word.
  return segments;
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
  if (token.pos) word.dataset.pos = token.pos; // i+1 reads this to tell context words from copulas
  if (token.frequency != null) word.dataset.frequency = String(token.frequency);
  if (token.reading) word.dataset.reading = token.reading;

  if (showFurigana && token.reading && hasKanji(token.surface)) {
    const reading = surfaceReading(token.surface, token.lemma, token.reading);
    if (reading) appendFurigana(word, token.surface, reading);
    else word.textContent = token.surface; // irregular reading we can't align — plain
  } else {
    word.textContent = token.surface;
  }

  register(token.lemma, word);
  return word;
}

// The kanji stem of 来る/為る changes reading by conjugation (来る く, 来て き, 来ない
// こ), so an inflected surface can't be aligned from the dictionary reading alone —
// unlike every regular verb, where the stem reading is invariant.
const IRREGULAR_STEM_LEMMAS = new Set(["来る", "來る", "為る"]);

// The reading of the INFLECTED surface, derived from the dictionary form, or null
// when it can't be trusted (skip furigana rather than show a wrong reading). A
// token carries the dictionary reading (授ける → さずける), but furigana must sit over
// the on-screen surface (授けて → さずけて), or an inflected okurigana won't align and
// the whole reading floats over the word. When the surface and the lemma share
// their kanji stem and differ only in trailing okurigana — the ordinary verb /
// adjective inflection — swap the dictionary okurigana for the surface's. Anything
// else (no kanji stem, mismatched stem) keeps the dictionary reading.
function surfaceReading(surface: string, lemma: string, reading: string): string | null {
  if (!lemma || surface === lemma) return reading;
  if (IRREGULAR_STEM_LEMMAS.has(lemma)) return null; // 来て etc. — reading isn't derivable
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
  for (let i = 0; i < chars.length; i++) if (KANJI.test(chars[i])) last = i;
  return last === -1 ? "" : chars.slice(0, last + 1).join("");
}

// Render `surface` into `target` with furigana over the kanji runs only — each
// kanji run gets a <ruby>, okurigana and other kana render as plain text, so the
// reading sits where it belongs instead of floating over the whole word (食べる
// → 食[た]べる, not たべる over 食べる). Shared with the popup's headword furigana.
export function appendFurigana(target: HTMLElement, surface: string, reading: string): void {
  for (const segment of furiganaSegments(surface, reading)) {
    if (!segment.ruby) {
      target.append(segment.text);
      continue;
    }
    const ruby = document.createElement("ruby");
    ruby.append(segment.text);
    const rt = document.createElement("rt");
    rt.textContent = segment.ruby;
    ruby.append(rt);
    target.append(ruby);
  }
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
    const aligned = surfaceReading(surface, word.dataset.lemma ?? surface, reading);
    if (!aligned) continue; // irregular reading — leave it as plain text
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
