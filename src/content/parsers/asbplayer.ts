import { mediaTimestamp, parseCaptionElement } from "../parser.js";
type ParseTarget = (root: HTMLElement, showFurigana: boolean) => Promise<number>;

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
let chain: Promise<void> = Promise.resolve();

export function startAsbplayer(showFurigana: boolean): void {
  furigana = showFurigana;
  if (started) return;
  started = true;

  let lineObserver: MutationObserver | null = null;
  let offscreen: Element | null = null;
  let debounce: number | undefined;

  const schedule = (): void => {
    window.clearTimeout(debounce);
    debounce = window.setTimeout(() => {
      // Serialize like YouTube so rapid cue updates don't double-wrap a line.
      chain = chain.then(() => parseAsbplayerLines(document, furigana)).then(() => undefined, () => undefined);
    }, 60);
  };

  const attach = (root: Element): void => {
    lineObserver?.disconnect();
    offscreen = root;
    lineObserver = new MutationObserver(() => schedule());
    lineObserver.observe(root, { childList: true, subtree: true, characterData: true });
    schedule();
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
    if (!tryAttach()) return;
    window.clearInterval(poll);
    watcher.disconnect();
  }, POLL_MS);

  // Also catch a late-created offscreen via body mutations (faster than the poll).
  // Stop both watchers on success — otherwise every mutation on every page the
  // content script touches keeps running a whole-document querySelector forever.
  const watcher = new MutationObserver(() => {
    if (!tryAttach()) return;
    watcher.disconnect();
    window.clearInterval(poll);
  });
  watcher.observe(document.documentElement, { childList: true, subtree: true });
}

export async function parseAsbplayerLines(root: Document | Element, showFurigana: boolean, parseTarget: ParseTarget = parseCaptionElement): Promise<number> {
  const nodes = new Set<HTMLElement>();
  for (const el of root.querySelectorAll(LINE)) nodes.add(el as HTMLElement);
  for (const el of root.querySelectorAll(VISIBLE)) nodes.add(el as HTMLElement);

  let parsed = 0;
  const timestamp = mediaTimestamp();
  for (const context of nodes) {
    // Skip empty / non-Japanese shells the cache may hold briefly. Do not skip
    // just because a prior wrap exists — progressive lines can grow in place.
    if (!context.textContent?.trim()) continue;
    context.dataset.integration = "asbplayer";
    if (timestamp != null) context.dataset.mediaTimestamp = timestamp;
    parsed += await parseTarget(context, showFurigana);
  }
  return parsed;
}
