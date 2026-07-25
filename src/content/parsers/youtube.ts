import { mediaTimestamp, parseCaptionElement } from "../parser.js";
import { noteCue, noteCueParsed, noteCuesCleared, stampCueStart } from "../cues.js";
type ParseTarget = (root: HTMLElement, showFurigana: boolean) => Promise<number>;

// YouTube captions parser. The generic page parser can't handle YouTube: the
// on-screen subtitle text is injected into an overlay that's rebuilt on every
// cue, so there's nothing static to parse on load. Instead we watch the caption
// container and parse each new subtitle segment as it appears. Segments are
// short and transient, so we parse eagerly (lazy/viewport parsing would be
// pointless for text that's already on screen and about to be replaced).
//
// Progressive/auto captions often grow a line in nested spans. We never skip a
// segment just because it already has a word wrap — `parseCaptionElement`
// re-tokenizes the full flattened text whenever bare Japanese remains.
//
// Parse only `.ytp-caption-segment` when present. That node owns YouTube's
// inline styles (dark pill, white ink, font size). Also matching the parent
// `.caption-visual-line` and calling replaceChildren on it wiped the segment
// and left white text with no background — unreadable on light frames.
const PLAYER = ".html5-video-player";
const CONTAINER = ".ytp-caption-window-container, .caption-window";
const SEGMENT = ".ytp-caption-segment";
const SEGMENT_FALLBACK = ".captions-text .caption-visual-line";

export function startYouTubeCaptions(showFurigana: boolean): void {
  const root = document.querySelector(PLAYER) ?? document.body;
  let container: Element | null = null;
  let captionObserver: MutationObserver | null = null;
  let debounce: number | undefined;
  let chain: Promise<void> = Promise.resolve();

  const schedule = (el: Element): void => {
    window.clearTimeout(debounce);
    debounce = window.setTimeout(() => {
      // Serialize so overlapping cue updates don't double-wrap the same node.
      chain = chain.then(() => parseYouTubeSegments(el, showFurigana)).then(() => undefined, () => undefined);
    }, 60);
  };

  const attach = (el: Element): void => {
    captionObserver?.disconnect();
    container = el;
    captionObserver = new MutationObserver(() => schedule(el));
    // Cues change via childList and text updates, so watch both.
    captionObserver.observe(el, { childList: true, subtree: true, characterData: true });
    schedule(el);
  };

  const existing = root.querySelector(CONTAINER);
  if (existing) attach(existing);

  // The caption container appears/disappears as subtitles toggle and survives
  // SPA navigations, so watch the player for it to (re)appear.
  new MutationObserver(() => {
    const found = root.querySelector(CONTAINER);
    if (found && found !== container) attach(found);
  }).observe(root, { childList: true, subtree: true });
}

/** Prefer styled caption segments; fall back to visual lines only if needed. */
export function captionTargets(container: Element): HTMLElement[] {
  const segments = [...container.querySelectorAll<HTMLElement>(SEGMENT)];
  if (segments.length) return segments;
  return [...container.querySelectorAll<HTMLElement>(SEGMENT_FALLBACK)];
}

export async function parseYouTubeSegments(container: Element, showFurigana: boolean, parseTarget: ParseTarget = parseCaptionElement): Promise<number> {
  let parsed = 0;
  const timestamp = mediaTimestamp();
  const targets = captionTargets(container);
  // An empty caption window is the line ending, and the only chance to record
  // when it did.
  if (!targets.length) {
    noteCuesCleared(document.querySelector("video"));
    return 0;
  }
  for (const context of targets) {
    if (!context.textContent?.trim()) continue;
    context.dataset.integration = "youtube_captions";
    stampCueStart(context, timestamp);
    // A caption never says how long it lasts; the next one appearing is the only
    // signal. Hand each cue over as it arrives so its audio can be bounded.
    noteCue(context, document.querySelector("video"));
    parsed += await parseTarget(context, showFurigana);
    noteCueParsed(context); // the trailing part of speech only exists now
  }
  return parsed;
}
