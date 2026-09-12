import { dictionaryStatus, installDictionary, lookupOffline, lookupEntryOffline, parseOffline } from "../src/common/offline-dictionary.js";
import { renderToken, candidatesFor } from "../src/content/word.js";
import type { Definition, ParsedToken } from "../src/common/types.js";
import { dismissPopup, setCardHost, showNow } from "@shirabe-org/card/word-card/card";

function container(id: string): HTMLElement {
  let element = document.getElementById(id);
  if (!element) {
    element = document.createElement("div");
    element.id = id;
    document.body.append(element);
  }
  return element;
}

function render(tokens: ParsedToken[]) {
  const text = container("parity-text");
  text.replaceChildren(...tokens.map((token) => renderToken(token, true)));
  const source = text.cloneNode(true) as HTMLElement;
  source.querySelectorAll("rt, rp").forEach((element) => element.remove());
  return {
    text: source.textContent,
    words: Array.from(text.querySelectorAll<HTMLElement>(".sb-word"), (word) => ({
      surface: word.dataset.surface, lemma: word.dataset.lemma, entry: word.dataset.entry ?? null,
      candidates: candidatesFor(word).map((candidate) => candidate.entry),
    })),
  };
}

function showDefinition(definition: Definition): void {
  dismissPopup();
  setCardHost({
    lookup: async (query) => ({ status: "found", definition: await lookupOffline(query, ["eng"], location.origin) }),
    lookupEntry: async (entry, surface) => ({ status: "found", definition: await lookupEntryOffline(entry, surface, ["eng"], location.origin) }),
    notify: () => {},
  });
  const target = document.createElement("span");
  target.className = "sb-word";
  target.dataset.lemma = definition.baseForm ?? definition.inflectionBase ?? definition.headword;
  if (definition.entry) target.dataset.entry = definition.entry;
  target.dataset.surface = definition.sourceForm ?? definition.headword;
  target.textContent = target.dataset.surface;
  container("parity-popup-target").replaceChildren(target);
  showNow(target);
}

async function showCandidateLookup(query: string): Promise<void> {
  dismissPopup();
  const tokens = await parseOffline(query, ["eng"], location.origin);
  const candidates = tokens[0]?.candidates;
  if (!candidates || candidates.length < 2) throw new Error(`No candidate ambiguity for ${query}`);
  setCardHost({
    lookup: async (text) => ({ status: "found", definition: await lookupOffline(text, ["eng"], location.origin), candidates }),
    lookupEntry: async (entry, surface) => ({ status: "found", definition: await lookupEntryOffline(entry, surface, ["eng"], location.origin) }),
    notify: () => {},
  });
  const target = document.createElement("span");
  target.className = "sb-word";
  target.dataset.lemma = query;
  target.dataset.surface = query;
  target.textContent = query;
  container("parity-popup-target").replaceChildren(target);
  showNow(target);
}

function reopenDefinition(): void {
  const target = document.querySelector<HTMLElement>("#parity-popup-target .sb-word");
  if (!target) throw new Error("No popup target to reopen");
  dismissPopup();
  showNow(target);
}

Object.assign(globalThis, { parity: { dictionaryStatus, installDictionary, lookupOffline, lookupEntryOffline, parseOffline, render, showDefinition, showCandidateLookup, reopenDefinition } });
