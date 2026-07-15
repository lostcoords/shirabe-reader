import { parse } from "../parser.js";
type ParseTarget = (root: Node, showFurigana: boolean) => Promise<number>;

// YouTube captions parser. The generic page parser can't handle YouTube: the
// on-screen subtitle text is injected into an overlay that's rebuilt on every
// cue, so there's nothing static to parse on load. Instead we watch the caption
// container and parse each new subtitle segment as it appears. Segments are
// short and transient, so we parse eagerly (lazy/viewport parsing would be
// pointless for text that's already on screen and about to be replaced).
const PLAYER = ".html5-video-player";
const CONTAINER = ".ytp-caption-window-container, .caption-window";
const SEGMENT = ".ytp-caption-segment, .captions-text .caption-visual-line";

export function startYouTubeCaptions(showFurigana: boolean): void {
  const root = document.querySelector(PLAYER) ?? document.body;
  let container: Element | null = null;
  let captionObserver: MutationObserver | null = null;
  let debounce: number | undefined;

  const attach = (el: Element): void => {
    captionObserver?.disconnect();
    container = el;
    captionObserver = new MutationObserver(() => {
      window.clearTimeout(debounce);
      debounce = window.setTimeout(() => void parseYouTubeSegments(el, showFurigana), 60);
    });
    // Cues change via childList and text updates, so watch both.
    captionObserver.observe(el, { childList: true, subtree: true, characterData: true });
    void parseYouTubeSegments(el, showFurigana);
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

export async function parseYouTubeSegments(container: Element, showFurigana: boolean, parseTarget: ParseTarget = parse): Promise<number> {
  let parsed = 0;
  for (const segment of container.querySelectorAll(SEGMENT)) {
    // Skip a segment we've already wrapped; YouTube swaps in fresh nodes per cue.
    if (segment.querySelector(".sb-word") || (segment as HTMLElement).querySelector("[data-sb-parsed]")) continue;
    const context = segment as HTMLElement;
    context.dataset.integration = "youtube_captions";
    const video = document.querySelector("video");
    if (video) context.dataset.mediaTimestamp = String(Math.round(video.currentTime * 1000));
    parsed += await parseTarget(segment, showFurigana);
  }
  return parsed;
}
