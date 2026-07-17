// Extension telemetry, shaped for the shared Grafana Faro receiver
// (o.shirabe.org/collect — the same collector the web app's RUM ships to).
//
// Privacy is the hard constraint. The extension's promise is local, offline
// lookup that sends no page text, so telemetry reports failure *shape* only —
// error class, message, our own stack frames, versions, browser — and never
// page content: no headwords, lookups, selections, page text, or URL paths.
// A page's registrable host is the most that may ever be attached, and only
// when a signal genuinely needs it. Everything here is pure so it can be unit
// tested; the actual network send lives in background/telemetry.ts.

export const MAX_MESSAGE = 300;
export const MAX_STACK = 4000;
const MAX_FRAMES = 40;

export type ClientContext = "content" | "popup" | "options";
export type SignalContext = ClientContext | "background";

export type TelemetryException = {
  kind: "exception";
  type: string;
  value: string;
  stack?: string;
  context: SignalContext;
  timestamp: number; // epoch ms
};
export type TelemetryEvent = {
  kind: "event";
  name: string;
  attributes?: Record<string, string>;
  context: SignalContext;
  timestamp: number;
};
export type TelemetryMeasurement = {
  kind: "measurement";
  metric: string;
  value: number;
  context: SignalContext;
  timestamp: number;
};
export type TelemetrySignal = TelemetryException | TelemetryEvent | TelemetryMeasurement;

// A batch forwarded from a page context (content/popup/options) to the
// background worker, which owns the network send.
export type ClientReport = { context: ClientContext; signals: TelemetrySignal[] };

export type FaroIdentity = {
  appVersion: string;
  environment: string; // "production" | "development" — mirrors web DEPLOYMENT_ENV
  sessionId: string;
  userAgent: string;
};

// Truncate any human-facing string that could carry content into a bounded,
// safe field. Callers still must not pass page text — this is defense in depth.
export const scrub = (value: unknown, max = MAX_MESSAGE): string => String(value ?? "").slice(0, max);

// Keep only the registrable host of a URL — never the path or query, which can
// reveal what the user is reading.
export function hostOnly(url: string | null | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
}

// Turn an unknown thrown value into a normalized exception signal.
export function toException(error: unknown, context: SignalContext, extra?: Record<string, string>): TelemetryException {
  const err = error instanceof Error ? error : undefined;
  const type = err?.name || (typeof error === "string" ? "Error" : (error as { name?: string })?.name) || "Error";
  const value = scrub(err?.message ?? (typeof error === "string" ? error : JSON.stringify(error)));
  const exception: TelemetryException = { kind: "exception", type: scrub(type, 80), value, context, timestamp: Date.now() };
  if (err?.stack) exception.stack = scrub(err.stack, MAX_STACK);
  if (extra) exception.value = scrub(`${value} ${JSON.stringify(extra)}`);
  return exception;
}

// Best-effort parse of a V8 ("at fn (file:line:col)") or Firefox ("fn@file:line:col")
// stack into Faro frames, ordered outermost-first as Faro expects.
export function parseFrames(stack: string | undefined): Array<{ filename: string; function: string; lineno: number; colno: number }> {
  if (!stack) return [];
  const frames: Array<{ filename: string; function: string; lineno: number; colno: number }> = [];
  for (const raw of stack.split("\n")) {
    const line = raw.trim();
    const v8 = line.match(/^at\s+(.+?)\s+\((.+?):(\d+):(\d+)\)$/) || line.match(/^at\s+()(.+?):(\d+):(\d+)$/);
    const ff = line.match(/^(.*?)@(.+?):(\d+):(\d+)$/);
    const m = v8 ?? ff;
    if (!m) continue;
    frames.push({ function: m[1] || "?", filename: m[2], lineno: Number(m[3]), colno: Number(m[4]) });
    if (frames.length >= MAX_FRAMES) break;
  }
  return frames.reverse();
}

function parseBrowser(userAgent: string): { name: string; version: string; os: string; mobile: boolean; userAgent: string } {
  const name = /Firefox\//.test(userAgent) ? "Firefox" : /Edg\//.test(userAgent) ? "Edge" : /Chrome\//.test(userAgent) ? "Chrome" : "Unknown";
  const os = /Windows/.test(userAgent) ? "Windows" : /Mac OS X|Macintosh/.test(userAgent) ? "macOS" : /Android/.test(userAgent) ? "Android" : /Linux/.test(userAgent) ? "Linux" : "Unknown";
  const version = userAgent.match(/(?:Firefox|Edg|Chrome)\/(\d+(?:\.\d+)?)/)?.[1] ?? "";
  return { name, version, os, mobile: /Mobile/.test(userAgent), userAgent: scrub(userAgent) };
}

// Build the Faro ingest payload the receiver accepts. Empty signal arrays are
// fine; the sender only calls this when there is at least one signal.
export function toFaroPayload(signals: TelemetrySignal[], identity: FaroIdentity): object {
  const iso = (ms: number) => new Date(ms).toISOString();
  const isException = (s: TelemetrySignal): s is TelemetryException => s.kind === "exception";
  const isEvent = (s: TelemetrySignal): s is TelemetryEvent => s.kind === "event";
  const isMeasurement = (s: TelemetrySignal): s is TelemetryMeasurement => s.kind === "measurement";

  return {
    meta: {
      sdk: { name: "shirabe-reader", version: identity.appVersion },
      app: { name: "shirabe-reader", version: identity.appVersion, environment: identity.environment },
      session: { id: identity.sessionId },
      browser: parseBrowser(identity.userAgent),
    },
    exceptions: signals.filter(isException).map((e) => ({
      type: e.type,
      value: e.value,
      timestamp: iso(e.timestamp),
      stacktrace: { frames: parseFrames(e.stack) },
      context: { source: e.context },
    })),
    logs: [],
    events: signals.filter(isEvent).map((e) => ({
      name: e.name,
      domain: "shirabe-reader",
      timestamp: iso(e.timestamp),
      attributes: { source: e.context, ...(e.attributes ?? {}) },
    })),
    measurements: signals.filter(isMeasurement).map((m) => ({
      type: "counter",
      timestamp: iso(m.timestamp),
      values: { [m.metric]: m.value },
      context: { source: m.context },
    })),
  };
}
