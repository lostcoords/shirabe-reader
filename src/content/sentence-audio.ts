// Sentence audio for a mined subtitle: the line as it was actually spoken,
// attached to the card next to the video frame.
//
// Audio can't be grabbed the way a frame can — a frame exists right now, a
// sentence only exists over its own duration. So mining replays it: seek back to
// the cue, record it through `captureStream`, and put the video back where it
// was. That costs the length of the line, out loud, which is the price of
// getting the line the learner actually asked for.
//
// (A rolling per-cue recorder was tried instead — instant and silent, but it
// only holds what already played, and pausing the moment a line appears is
// exactly when people mine. It also ran an encoder on every captioned page.
// Dropped 2026-07-26; the tracker's Not-MVP list has it.)
//
// Protected media can't be read: captureStream on a DRM element yields no audio
// track, the same wall the video frame hits on Netflix.
//
// Where the line starts and ends is not this module's problem — `cues.ts` owns
// that, and says whether its answer is exact or observed.

import { type Cue, forgetOpenCue } from "./cues.js";

// A clip shorter than this is the user pausing as the line appeared, not a
// line; stretch it. The ceiling matches the sentence-span cap plus its padding.
const MIN_CLIP_MS = 1_500;
const MAX_CLIP_MS = 16_000;
// Breathing room either side, so a clip doesn't start on a half-swallowed first
// mora — but never more silence than there actually is, or the line before
// bleeds into the recording.
const PAD_MS = 500;
// An observed start is stamped when the caption was drawn, which is after the
// words began, so that much of the padding is spent getting back to the line
// rather than eating into the pause before it.
const STAMP_LAG_MS = 250;

let enabled = true;

export function setSentenceAudioEnabled(next: boolean): void {
  enabled = next;
  if (!enabled) forgetOpenCue();
}

/** The mined line as a data URL, or undefined when there's no audio to be had. */
export async function captureSentenceAudio(video: HTMLVideoElement, cue: Cue): Promise<string | undefined> {
  if (!enabled) return undefined;
  const range = clipRange(cue);
  // What the clip was cut from, so the boundary rules can be judged against real
  // material rather than argued about: how much silence there was to work with
  // says whether the gap is carrying any weight on this surface at all.
  console.debug("[Shirabe scanner] sentence audio", {
    timing: cue.exact ? "exact" : "observed",
    cue: `${cue.startMs}–${cue.endMs}`,
    clip: `${range.startMs}–${range.endMs}`,
    roomBeforeMs: cue.roomBeforeMs, roomAfterMs: cue.roomAfterMs,
    text: cue.text,
  });
  return replayClip(video, range);
}

// The sentence plus half a second either side — or as much of that as the
// silence allows. Where the gap to the next line is shorter than the padding,
// the padding gives way: a clip that runs into the following sentence is worse
// than one that starts a fraction late.
function clipRange(cue: Cue): { startMs: number; endMs: number } {
  const lag = cue.exact ? 0 : STAMP_LAG_MS;
  const before = Math.min(PAD_MS, (cue.roomBeforeMs ?? PAD_MS) + lag);
  const after = Math.min(PAD_MS, cue.roomAfterMs ?? PAD_MS);

  const startMs = Math.max(0, cue.startMs - before);
  const endMs = Math.max(cue.endMs + after, startMs + MIN_CLIP_MS);
  return { startMs, endMs: Math.min(endMs, startMs + MAX_CLIP_MS) };
}

async function replayClip(video: HTMLVideoElement, range: { startMs: number; endMs: number }): Promise<string | undefined> {
  // Ask before moving the playhead: no audio track means no clip, and the video
  // shouldn't jump around to discover that.
  if (!audioTracksOf(video)?.length) return undefined;

  const resumeAt = video.currentTime;
  const wasPaused = video.paused;
  let recorder: CueRecorder | undefined;
  try {
    // Seek first, record second — a recorder started before the seek lands
    // opens the clip with whatever was playing at the old position.
    await seek(video, range.startMs / 1000);
    recorder = startRecording(video);
    if (!recorder) return undefined;
    await video.play();
    await playedThrough(video, range.endMs);
    const clip = await finish(recorder);
    return clip.size ? await blobToDataUrl(clip) : undefined;
  } catch {
    if (recorder) void finish(recorder);
    return undefined;
  } finally {
    // Put the video back exactly as it was found, whatever went wrong above.
    if (wasPaused) video.pause();
    await seek(video, resumeAt).catch(() => undefined);
  }
}

type CueRecorder = { recorder: MediaRecorder; done: Promise<Blob> };

function startRecording(video: HTMLVideoElement): CueRecorder | undefined {
  const tracks = audioTracksOf(video);
  if (!tracks?.length) return undefined;

  const mimeType = supportedMimeType();
  if (!mimeType) return undefined;

  try {
    const recorder = new MediaRecorder(new MediaStream(tracks), { mimeType });
    const chunks: Blob[] = [];
    recorder.addEventListener("dataavailable", (event) => {
      if (event.data.size) chunks.push(event.data);
    });
    const done = new Promise<Blob>((resolve) => {
      recorder.addEventListener("stop", () => resolve(new Blob(chunks, { type: mimeType })), { once: true });
    });
    recorder.start();
    return { recorder, done };
  } catch {
    return undefined; // no capture on this element (protected media, or no audio yet)
  }
}

function finish(cue: CueRecorder): Promise<Blob> {
  if (cue.recorder.state !== "inactive") cue.recorder.stop();
  return cue.done;
}

// captureStream is prefixed in Firefox and absent where media is protected.
// Calling it twice on one element returns the same stream, so no bookkeeping.
function audioTracksOf(video: HTMLVideoElement): MediaStreamTrack[] | undefined {
  const capture = (video as VideoWithCapture).captureStream ?? (video as VideoWithCapture).mozCaptureStream;
  try {
    return capture?.call(video).getAudioTracks();
  } catch {
    return undefined;
  }
}

type VideoWithCapture = HTMLVideoElement & {
  captureStream?: () => MediaStream;
  mozCaptureStream?: () => MediaStream;
};

// MP4 first, because a clip has to survive being a *file*, not just a stream.
// MediaRecorder's WebM ships no duration in its header and no seek cues, so the
// clip reads as `Infinity` long and the first seek kills the demuxer — it can be
// played start-to-finish and nothing else, anywhere (Shirabe's own player has to
// decode it whole to draw a timeline; an Anki export or a phone's player just
// can't scrub it). The same capture recorded as MP4 carries a real duration and
// seeks, measured through this exact path (element → captureStream → recorder).
// Ogg-Opus sits ahead of WebM as the Firefox fallback for the same reason.
//
// Every candidate's bare type is on the save endpoint's accepted list
// (MEDIA_TYPES in saves_controller.rb), which reads the type off the front and
// ignores the `;codecs=` parameter.
const MIME_CANDIDATES = ["audio/mp4", "audio/ogg;codecs=opus", "audio/webm;codecs=opus", "audio/webm"];
const supportedMimeType = (): string | undefined =>
  MIME_CANDIDATES.find((type) => MediaRecorder.isTypeSupported?.(type));

function seek(video: HTMLVideoElement, seconds: number): Promise<void> {
  if (Math.abs(video.currentTime - seconds) < 0.05) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error("seek timed out")), 3_000);
    video.addEventListener("seeked", () => {
      window.clearTimeout(timer);
      resolve();
    }, { once: true });
    video.currentTime = seconds;
  });
}

// Playback is the clock: poll rather than trust a timer, so a buffering stall
// lengthens the wait instead of truncating the line. The ceiling is the clip's
// own length plus slack, so a video that stops advancing can't hang the save.
function playedThrough(video: HTMLVideoElement, endMs: number): Promise<void> {
  const deadline = performance.now() + (endMs - video.currentTime * 1000) + 4_000;
  return new Promise((resolve) => {
    const tick = (): void => {
      if (video.currentTime * 1000 >= endMs || video.ended || performance.now() > deadline) resolve();
      else window.setTimeout(tick, 100);
    };
    tick();
  });
}

function blobToDataUrl(blob: Blob): Promise<string | undefined> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : undefined);
    reader.onerror = () => resolve(undefined);
    reader.readAsDataURL(blob);
  });
}
