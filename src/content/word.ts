import type { ParsedToken } from "../common/types.js";

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
  return word;
}

// Reflect a freshly-set learning state on an already-rendered word.
export function applyState(word: HTMLElement, state: ParsedToken["state"]): void {
  word.className = word.className.replace(/sb-(new|learning|known|due|ignored|unknown)/, `sb-${state}`);
}
