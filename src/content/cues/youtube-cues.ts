import { cueText, type Cue, type CueSource } from "../cues.js";

// Exact cue timings for YouTube, from the player's own timed-text track.
//
// Watching the caption overlay can only ever say "a line appeared around now".
// The track says 「新しい車です」 runs 12.480 → 15.100, before it is on screen and
// regardless of how the overlay renders it — which is what makes auto-generated
// captions (rolled in word by word) minable at all.
//
// The track list lives in the watch page's own player-response payload. On a
// fresh load that is already in the DOM; after an SPA navigation the DOM copy
// describes the previous video, so the page is re-fetched for the new id. Every
// failure path returns null and leaves the observation in charge.
//
// As of 2026-07 that last step usually fails: YouTube answers the signed
// timedtext URL with 200 and an empty body unless the request carries a
// proof-of-origin token the player mints internally. Verified against the live
// endpoint — bare, json3, srv3, vtt, and four InnerTube clients all come back
// empty. The code stays because it costs one request per video, disables itself
// when that request is empty, and starts working again the day the endpoint
// does. Reading the caption data the *player* fetches, from a MAIN-world hook,
// is the escalation if observed timings ever prove too coarse.

const PLAYER_RESPONSE = "ytInitialPlayerResponse";
// The observation trails the truth, never leads it, so a matching cue starts at
// or before it. The window covers a slow parse chain without reaching the line
// before last.
const LOOKBACK_MS = 4_000;
const TOLERANCE_MS = 500;

type PlayerResponse = {
  videoDetails?: { videoId?: string };
  captions?: {
    playerCaptionsTracklistRenderer?: {
      captionTracks?: Array<{ baseUrl?: string; languageCode?: string; kind?: string }>;
    };
  };
};

type Json3 = {
  events?: Array<{ tStartMs?: number; dDurationMs?: number; segs?: Array<{ utf8?: string }> }>;
};

export function youTubeCueSource(): CueSource {
  let cues: Cue[] = [];
  let loadedFor = "";
  let loading = false;

  function ensureLoaded(): void {
    const id = videoId();
    if (!id || id === loadedFor || loading) return;
    loading = true;
    // Claim the id up front: a video whose track can't be read must not be
    // retried on every hover for the rest of the page's life.
    loadedFor = id;
    cues = [];
    void loadCues(id)
      .then((report) => {
        cues = report.cues;
        // Every step named, because each one fails silently and each one costs
        // exact timing on every line of the video.
        console.info("[Shirabe scanner] YouTube cue track", {
          videoId: id, ...report, cues: report.cues.length,
          timing: report.cues.length ? "exact" : "observed (watching the overlay)",
        });
      })
      .catch((error) => {
        cues = [];
        console.warn("[Shirabe scanner] YouTube cue track failed", { videoId: id, error });
      })
      .finally(() => {
        loading = false;
      });
  }

  // Start fetching now, not on the first mine — a track that arrives after the
  // save has already begun is a track that did nothing for it. `refine` asks
  // again so an SPA navigation to another video reloads.
  ensureLoaded();

  return {
    refine(observed: Cue, element: HTMLElement): Cue | null {
      ensureLoaded();
      if (!cues.length) return null;
      // Which line the observation was looking at. Growing that into the mined
      // sentence is `cues.ts`'s job, over the list below.
      return snap(cues, observed, cueText(element));
    },
    list: (): Cue[] => cues,
    stop(): void {
      cues = [];
      loadedFor = "";
    },
  };
}

/**
 * Which real cue the observation was looking at. Time alone is not enough:
 * auto-generated captions are drawn seconds after the words they transcribe, so
 * the playhead at stamp time can already be inside the *next* cue. When the text
 * on screen matches a nearby cue, that answer beats the clock.
 */
function snap(cues: Cue[], observed: Cue, onScreen: string): Cue | null {
  const nearby: Cue[] = [];
  for (const cue of cues) {
    if (cue.startMs > observed.startMs + TOLERANCE_MS) break; // sorted; past the observation
    if (cue.endMs < observed.startMs - LOOKBACK_MS) continue; // too old to be this line
    nearby.push(cue);
  }
  if (!nearby.length) return null;

  const wanted = compact(onScreen);
  if (wanted) {
    // A rolling caption shows a growing prefix of its cue, so containment either
    // way counts as a match. Latest wins: cues repeat their text more than once.
    const matched = nearby.filter((cue) => {
      const text = compact(cue.text);
      return text && (text.includes(wanted) || wanted.includes(text));
    });
    if (matched.length) return matched[matched.length - 1];
  }
  return nearby[nearby.length - 1];
}

// Captions and tracks disagree about spacing and line breaks; neither carries
// meaning in Japanese.
const compact = (text: string): string => text.replace(/\s+/g, "");

const videoId = (): string => new URL(location.href).searchParams.get("v") ?? "";

type LoadReport = { cues: Cue[]; via: string; tracks: string[]; format: string };

async function loadCues(id: string): Promise<LoadReport> {
  const fromDom = playerResponseFromDom(id);
  const response = fromDom ?? (await playerResponseFromWatchPage(id));
  const via = fromDom ? "dom" : response ? "watch-page" : "none";
  const tracks = (response?.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? [])
    .map((track) => `${track.languageCode ?? "?"}${track.kind === "asr" ? "/asr" : ""}`);

  const track = japaneseTrack(response);
  if (!track) return { cues: [], via, tracks, format: "no-track" };

  // json3 first, then the legacy XML the same endpoint still serves. Which one
  // answers moves with YouTube's own plumbing, and a track we can't read costs
  // exact timing on every line of the video — worth the second request.
  const json = await json3Cues(track);
  const parsed = json ?? (await xmlCues(track));
  const format = json ? "json3" : parsed ? "xml" : "unreadable";
  const cues = (parsed ?? [])
    .filter((cue) => cue.text && cue.endMs > cue.startMs)
    .sort((a, b) => a.startMs - b.startMs);
  return { cues, via, tracks, format };
}

async function json3Cues(track: string): Promise<Cue[] | null> {
  const json = (await fetchText(`${track}&fmt=json3`).then(parseJson)) as Json3 | null;
  if (!json?.events?.length) return null;
  return json.events.map((event) => ({
    startMs: event.tStartMs ?? 0,
    endMs: (event.tStartMs ?? 0) + (event.dDurationMs ?? 0),
    text: (event.segs ?? []).map((seg) => seg.utf8 ?? "").join("").trim(),
    exact: true,
  }));
}

async function xmlCues(track: string): Promise<Cue[] | null> {
  const xml = await fetchText(track);
  if (!xml) return null;
  const texts = [...new DOMParser().parseFromString(xml, "text/xml").querySelectorAll("text")];
  if (!texts.length) return null;
  return texts.map((node) => {
    const startMs = Math.round(Number(node.getAttribute("start") ?? 0) * 1000);
    return {
      startMs,
      endMs: startMs + Math.round(Number(node.getAttribute("dur") ?? 0) * 1000),
      text: (node.textContent ?? "").trim(),
      exact: true,
    };
  });
}

// Manual captions over auto-generated ones — same timings either way, but a
// human track is the one whose text matches what is on screen.
function japaneseTrack(response: PlayerResponse | null): string | undefined {
  const tracks = response?.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? [];
  const japanese = tracks.filter((track) => track.languageCode?.startsWith("ja"));
  const preferred = japanese.find((track) => track.kind !== "asr") ?? japanese[0] ?? tracks[0];
  return preferred?.baseUrl;
}

// The payload the page was served with. Only usable while it still describes the
// video being watched — YouTube navigates without replacing it.
function playerResponseFromDom(id: string): PlayerResponse | null {
  for (const script of document.scripts) {
    if (!script.textContent?.includes("ytInitialPlayerResponse")) continue;
    const parsed = parsePlayerResponse(script.textContent);
    if (parsed?.videoDetails?.videoId === id) return parsed;
  }
  return null;
}

async function playerResponseFromWatchPage(id: string): Promise<PlayerResponse | null> {
  // Same-origin, with the page's own cookies: a cookie-less request is answered
  // with a consent wall in some regions, and that page carries no player data.
  const html = await fetch(`https://www.youtube.com/watch?v=${encodeURIComponent(id)}`, { credentials: "same-origin" })
    .then((res) => (res.ok ? res.text() : ""))
    .catch(() => "");
  return html ? parsePlayerResponse(html) : null;
}

function parsePlayerResponse(text: string): PlayerResponse | null {
  const assignment = text.indexOf(PLAYER_RESPONSE);
  if (assignment < 0) return null;
  const json = balancedObjectAt(text, text.indexOf("{", assignment));
  if (!json) return null;
  try {
    return JSON.parse(json) as PlayerResponse;
  } catch {
    return null;
  }
}

// Read one JSON object by balancing its braces, rather than matching to some
// guessed terminator. The payload is a megabyte of minified JSON on one line
// with `};` inside its own strings; a regex that ends at the first of those
// silently loses the caption tracks and drops us back to guessing timings.
function balancedObjectAt(text: string, start: number): string | null {
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const char = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "{") depth += 1;
    else if (char === "}" && --depth === 0) return text.slice(start, i + 1);
  }
  return null;
}

async function fetchText(url: string): Promise<string> {
  try {
    const response = await fetch(url, { credentials: "same-origin" });
    return response.ok ? await response.text() : "";
  } catch {
    return "";
  }
}

function parseJson(text: string): unknown {
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}
