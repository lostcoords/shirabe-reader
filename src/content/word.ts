import type { ParsedToken, WordState } from "../common/types.js";

// Every interactive word renders into a `.sb-word` span and registers here,
// keyed by lemma, so a single review can recolour *every* occurrence on the
// page at once (jpd-breader's reverseIndex idea, kept tiny). Sets are pruned
// lazily — detached nodes are skipped on recolour, not tracked for removal.
const byLemma = new Map<string, Set<HTMLElement>>();

const STATE_CLASS = /sb-(none|new|learning|due|known)/;

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

  if (showFurigana && token.reading) {
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
