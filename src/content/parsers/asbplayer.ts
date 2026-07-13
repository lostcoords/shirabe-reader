import { parse } from "../parser.js";

// asbplayer subtitle parser. asbplayer injects an offscreen DOM cache of
// subtitle lines (`.asbplayer-offscreen > div`) on any streaming page or on
// app.asbplayer.dev — the same selectable text Yomitan/JitenReader mine. Those
// nodes are moved between the cache and the on-screen overlay, so wrapping them
// once keeps hover/save working when the line is visible.
//
// This is deliberately NOT a exclusive host rule: asbplayer runs on Netflix,
// YouTube, local files, etc. We always watch (cheap when the class never
// appears) so host-specific auto-parse for Wikipedia/Mokuro still works.

const OFFSCREEN = ".asbplayer-offscreen";
const LINE = ".asbplayer-offscreen > div";
// Visible overlay lines (in case a cue never hits the cache, or DOM differs).
const VISIBLE = ".asbplayer-subtitles, .asb-subtitles";
const POLL_MS = 2000;

let started = false;
let furigana = true;

export function startAsbplayer(showFurigana: boolean): void {
  furigana = showFurigana;
  if (started) return;
  started = true;

  let lineObserver: MutationObserver | null = null;
  let offscreen: Element | null = null;
  let debounce: number | undefined;

  const attach = (root: Element): void => {
    lineObserver?.disconnect();
    offscreen = root;
    lineObserver = new MutationObserver(() => {
      window.clearTimeout(debounce);
      debounce = window.setTimeout(() => parseLines(), 60);
    });
    lineObserver.observe(root, { childList: true, subtree: true, characterData: true });
    parseLines();
  };

  const tryAttach = (): boolean => {
    const found = document.querySelector(OFFSCREEN);
    if (found && found !== offscreen) {
      attach(found);
      return true;
    }
    return !!offscreen;
  };

  if (tryAttach()) return;

  // Lazy: asbplayer mounts when the user loads subs, often long after page load.
  const poll = window.setInterval(() => {
    if (tryAttach()) window.clearInterval(poll);
  }, POLL_MS);

  // Also catch a late-created offscreen via body mutations (faster than the poll).
  new MutationObserver(() => {
    tryAttach();
  }).observe(document.documentElement, { childList: true, subtree: true });
}

function parseLines(): void {
  const nodes = new Set<Element>();
  for (const el of document.querySelectorAll(LINE)) nodes.add(el);
  for (const el of document.querySelectorAll(VISIBLE)) nodes.add(el);

  for (const el of nodes) {
    if (el.querySelector(".sb-word") || (el as HTMLElement).dataset.sbParsed) continue;
    // Skip empty / non-Japanese shells the cache may hold briefly.
    if (!el.textContent?.trim()) continue;
    void parse(el, furigana);
  }
}
