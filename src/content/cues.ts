// When a subtitle line started and ended.
//
// Everything mined off a video needs this: the clip to record, the moment to
// deep-link back to: and getting it wrong is what makes an audio clip play the
// wrong sentence. Two sources of truth, in order of preference:
//
//   observed: watch the caption overlay mutate and read the playhead. Always
//              available, never exact: the caption is drawn a beat after the
//              words, our parse debounce lands on top, and a line's end isn't
//              knowable until the next line replaces it.
//   refined: the player's own cue list, where a surface has one. YouTube
//              fetches a timed-text track; asbplayer parsed a subtitle file;
//              Netflix has TTML. Exact, and known before the line is on screen.
//
// A surface registers a CueSource and refines the observation. Returning null
// means "can't say", and the observation stands: so a source that breaks
// against a site redesign degrades to the old behaviour instead of failing.

export type Cue = {
  startMs: number;
  endMs: number;
  text: string;
  /** True when the timing came from the player rather than from watching it. */
  exact: boolean;
  /** Silence either side of the span, so a clip can breathe without bleeding. */
  roomBeforeMs?: number;
  roomAfterMs?: number;
};

export interface CueSource {
  /** Sharpen an observed cue, or null when this source can't place it. */
  refine(observed: Cue, element: HTMLElement): Cue | null;
  /** The whole track, when there is one: a sentence can span several cues. */
  list?(): Cue[];
  stop(): void;
}

let source: CueSource | null = null;
let open: { element: HTMLElement; startMs: number; jumped: boolean; detach: () => void } | null = null;

// Every cue we watched go by, most recent last. A refined source has the whole
// track and doesn't need this; without one it is the only way to know a line had
// a line before it: which is what a clip needs to cover a whole sentence.
const timeline: Cue[] = [];
const TIMELINE_MAX = 40;

export function setCueSource(next: CueSource | null): void {
  if (source && source !== next) source.stop();
  source = next;
}

/**
 * The span to record for a mined word: the cues holding `sentence`, timed as
 * precisely as any source can say.
 */
export function cueFor(element: HTMLElement, video: HTMLVideoElement, sentence?: string): Cue | null {
  const observed = observedCue(element, video);
  if (!observed) return null;
  const anchor = source?.refine(observed, element) ?? observed;
  if (!sentence) return anchor;
  // A source with no track (YouTube's, most days) must not shadow the timeline :
  // an empty list would leave every clip pinned to the single line it started on.
  const known = source?.list?.();
  return spanCovering(known?.length ? known : timeline, anchor, sentence);
}

// ── Sentence spans ───────────────────────────────────────────────────────────

// The card already says which sentence was mined: `sentenceAt` picked it out of
// the caption when the word was wrapped. The clip is the audio of exactly that
// text, so the two can never disagree, and no rule about punctuation, particles
// or pauses has to stand in for a decision that was already made.
//
// (Those rules were tried: terminators, then trailing-form patterns, then part
// of speech, then silence between cues. Each fixed one clip and broke another.
// Matching the text is the same answer without the guessing.)
const MAX_SPAN_CUES = 4;

/** The cues whose words contain the mined sentence. */
export function spanCovering(list: Cue[], anchor: Cue, sentence: string): Cue {
  const target = compact(sentence);
  const index = list.findIndex((cue) => cue.startMs === anchor.startMs);
  if (!target || index < 0) return anchor;
  const cues = list.map((cue, i) => (i === index ? { ...cue, endMs: anchor.endMs } : cue));

  let first = index;
  let last = index;
  const spans = (): string => compact(cues.slice(first, last + 1).map((cue) => cue.text).join(""));

  // A caption usually holds the whole sentence, so this loop normally doesn't
  // run. When the sentence was split across lines, reach outward until the text
  // is covered.
  while (!spans().includes(target) && last - first + 1 < MAX_SPAN_CUES) {
    if (first > 0) first -= 1;
    else if (last < cues.length - 1) last += 1;
    else break;
  }
  // Nothing matched: the caption has moved on since the word was wrapped. The
  // line the word sits on is still the safest thing to record.
  if (!spans().includes(target)) return anchor;

  // Reaching outward overshoots: a sentence that ran forwards is found only
  // after stepping back past lines it never included. Shrink to the smallest
  // window that still holds it, or the clip carries a line the card doesn't.
  while (first < last && compact(cues.slice(first + 1, last + 1).map((cue) => cue.text).join("")).includes(target)) first += 1;
  while (last > first && compact(cues.slice(first, last).map((cue) => cue.text).join("")).includes(target)) last -= 1;

  const span = cues.slice(first, last + 1);
  return {
    startMs: span[0].startMs,
    endMs: span[span.length - 1].endMs,
    text: span.map((cue) => cue.text).join(""),
    exact: anchor.exact,
    // How much silence there is to breathe into. Padding past it would bleed a
    // neighbouring line into the clip.
    ...(first > 0 ? { roomBeforeMs: Math.max(0, span[0].startMs - cues[first - 1].endMs) } : {}),
    ...(last < cues.length - 1 ? { roomAfterMs: Math.max(0, cues[last + 1].startMs - span[span.length - 1].endMs) } : {}),
  };
}

// Captions and cue lists disagree about spacing and line breaks; neither carries
// meaning in Japanese.
const compact = (text: string): string => text.replace(/\s+/g, "");

// ── Observation ──────────────────────────────────────────────────────────────

/**
 * Stamp when a cue *first appeared*, which is not when we last parsed it.
 * Auto-generated captions roll a line in word by word, and every added word is
 * another mutation, another parse, another "now": re-stamping would walk the
 * start of the line forward until it pointed at the end of it, and audio mined
 * from that cue would replay whatever came next.
 *
 * A line that grows keeps its original stamp; text that doesn't extend the
 * previous text is a new cue and takes a fresh one.
 */
export function stampCueStart(element: HTMLElement, timestamp: string | null): void {
  const text = cueText(element);
  const growing = element.dataset.mediaTimestamp && text.startsWith(element.dataset.sbCueText ?? "");
  if (!growing && timestamp != null) {
    element.dataset.mediaTimestamp = String(startOfSameLine(text) ?? timestamp);
  }
  element.dataset.sbCueText = text;
}

/**
 * When the line already on screen is the line in front of us.
 *
 * A player may rebuild its caption nodes mid-sentence: same words, a brand new
 * element carrying no stamp of ours. Stamping "now" moves the line's start to
 * wherever playback had reached, so a clip of it opens two thirds of the way
 * through the sentence. The words say it is the same line; take the start we
 * already recorded for them.
 *
 * Only ever moves a start earlier, and only to a moment already observed for
 * these words, so a line that genuinely is new stamps exactly as before.
 */
function startOfSameLine(text: string): number | undefined {
  const open = timeline[timeline.length - 1];
  if (!open) return undefined;
  const seen = compact(open.text);
  const now = compact(text);
  if (!seen || !now) return undefined;
  // Same words, or this node holding more of the line the last one started.
  return now.startsWith(seen) || seen.startsWith(now) ? open.startMs : undefined;
}

/**
 * A cue's own words, without the furigana we put on top of them. Plain
 * `textContent` splices every reading into the line: 新しい becomes あたらしい新しい
 * : which breaks both the "is this line still growing?" test and any attempt to
 * match the line against a player's cue list.
 */
export function cueText(element: HTMLElement): string {
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) =>
      node.parentElement?.closest("rt, rp") ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
  });
  let text = "";
  for (let node = walker.nextNode(); node; node = walker.nextNode()) text += node.nodeValue ?? "";
  return text.trim();
}

/**
 * Called by the caption parsers for each cue they stamp. Closing the previous
 * cue is the only moment its end is observable, since a caption never announces
 * its own duration.
 */
export function noteCue(element: HTMLElement, video: HTMLVideoElement | null): void {
  if (!video) return;
  const startMs = Number(element.dataset.mediaTimestamp);
  if (!Number.isFinite(startMs)) return;
  if (open?.startMs === startMs) {
    open.element = element; // same line, rebuilt node: follow it
    return;
  }

  closeOpenCue(video);
  remember({ startMs, endMs: startMs, text: cueText(element), exact: false });
  const cue = { element, startMs, jumped: false, detach: () => undefined as void };
  // A seek breaks the only thing that made the playhead meaningful for this
  // line: that it walked here from the line's start. Afterwards it's just where
  // the user happens to be, so the end is left unstamped rather than invented.
  const jump = (): void => {
    cue.jumped = true;
  };
  video.addEventListener("seeking", jump);
  cue.detach = () => video.removeEventListener("seeking", jump);
  open = cue;
}

/**
 * The caption window emptied. That usually means the line finished: the one
 * moment its real end is observable, rather than inheriting the next line's
 * arrival and the silence in between.
 *
 * But it also happens for an instant *within* a line: a player that swaps a cue
 * by removing the old node before adding the new one empties the container in
 * between, and an auto-caption does it on every word it adds. Closing on that
 * stamps an end in the middle of a sentence, which cuts the clip short and, by
 * inflating the gap to the next line, stops the sentence being reassembled at
 * all. So wait to see whether the emptiness lasts.
 */
export function noteCuesCleared(video: HTMLVideoElement | null): void {
  if (!open || clearing) return;
  const endMs = Math.round(video ? video.currentTime * 1000 : 0);
  clearing = window.setTimeout(() => {
    clearing = undefined;
    // Stamp the moment the caption went, not the moment we became sure of it.
    if (open && video) closeOpenCue(video, endMs);
  }, CLEAR_SETTLE_MS);
}

// Long enough to outlast a cue swap or a rolling caption's word-by-word
// redraw, short enough that a real pause is still measured as one.
const CLEAR_SETTLE_MS = 400;
let clearing: number | undefined;

/**
 * A cue's final text. Lines are stamped as they appear and auto-captions grow
 * afterwards, so what the timeline recorded at stamp time is a prefix of what
 * the learner actually read: and the sentence has to be matched against the
 * whole line.
 */
export function noteCueParsed(element: HTMLElement): void {
  const startMs = Number(element.dataset.mediaTimestamp);
  const entry = timeline.find((cue) => cue.startMs === startMs);
  if (entry) entry.text = cueText(element);
}

/** Forget the open cue: the reader was turned off, or the page is going away. */
export function forgetOpenCue(): void {
  closeOpenCue(null);
  timeline.length = 0;
}

function remember(cue: Cue): void {
  if (timeline[timeline.length - 1]?.startMs === cue.startMs) return;
  timeline.push(cue);
  if (timeline.length > TIMELINE_MAX) timeline.shift();
}

function closeOpenCue(video: HTMLVideoElement | null, at?: number): void {
  window.clearTimeout(clearing);
  clearing = undefined;
  if (!open) return;
  open.detach();
  if (video && !open.jumped) {
    const endMs = at ?? Math.round(video.currentTime * 1000);
    open.element.dataset.mediaEnd = String(endMs);
    // The line just ended: give the timeline entry its real end, so the next
    // cue can tell whether it followed on or came after a pause.
    const remembered = timeline[timeline.length - 1];
    if (remembered?.startMs === open.startMs && endMs > remembered.startMs) remembered.endMs = endMs;
  }
  open = null;
}

// A cue still on screen has no observed end, so the playhead stands in for one:
// someone who paused to mine paused at the end of the line they wanted.
function observedCue(element: HTMLElement, video: HTMLVideoElement): Cue | null {
  const startMs = Number(element.dataset.mediaTimestamp);
  if (!Number.isFinite(startMs)) return null;
  const ended = Number(element.dataset.mediaEnd);
  const endMs = Number.isFinite(ended) && ended > startMs ? ended : Math.round(video.currentTime * 1000);
  return { startMs, endMs, text: element.dataset.sbCueText ?? "", exact: false };
}
