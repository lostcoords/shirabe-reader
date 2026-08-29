import { ext } from "../common/browser.js";
import {
  toException,
  toPostHogBatch,
  type ClientContext,
  type ClientReport,
  type PostHogIdentity,
  type SignalContext,
  type TelemetryEvent,
  type TelemetryMeasurement,
  type TelemetrySignal,
} from "../common/telemetry.js";

// The only context allowed to touch the network: content scripts and the popup
// forward their signals here, because they cannot reach a collector under a
// page's CSP and only the background holds the host permission that bypasses
// CORS. Signals are batched and POSTed as one capture request.
//
// PostHog rather than the self-hosted collector, which is where every other
// surface already reports. The site moved on 2026-08-22 and this did not, so
// until now the extension's crashes landed somewhere nothing else looked.

declare const __POSTHOG_HOST__: string;
declare const __POSTHOG_TOKEN__: string;
declare const __TELEMETRY_ENV__: string;
declare const __EXTENSION_VERSION__: string;

const FLUSH_DELAY_MS = 4000;
const FLUSH_AT = 20; // flush immediately once this many signals are queued
const MAX_QUEUE = 200; // hard cap so a failing collector can't grow memory unbounded
const SESSION_KEY = "telemetrySession"; // storage.local: one stable id across SW restarts

const queue: TelemetrySignal[] = [];
let flushTimer: ReturnType<typeof setTimeout> | undefined;
let sending = false;
let sessionId = "";
let sessionLoad: Promise<string> | undefined;

// The MV3 service worker is torn down and respawned constantly; an in-memory id
// would split one user's activity into a new "session" every few minutes. Keep
// a single id in storage.local so a session is stable across restarts (matching
// the web RUM's persistent session tracking). Falls back to an ephemeral id if
// storage is unavailable, so telemetry never fails on the session lookup.
function loadSession(): Promise<string> {
  if (!sessionLoad) {
    sessionLoad = (async () => {
      try {
        const stored = await ext.storage.local.get(SESSION_KEY);
        const existing = stored[SESSION_KEY];
        if (typeof existing === "string" && existing) return existing;
        const created = crypto.randomUUID();
        await ext.storage.local.set({ [SESSION_KEY]: created });
        return created;
      } catch {
        return crypto.randomUUID();
      }
    })();
  }
  return sessionLoad;
}

function identity(): PostHogIdentity {
  return {
    token: __POSTHOG_TOKEN__,
    surface: "extension",
    appVersion: __EXTENSION_VERSION__,
    environment: __TELEMETRY_ENV__,
    sessionId,
    userAgent: navigator.userAgent,
  };
}

// The reader's switch (Config#errorReports), not a sampling knob: off means
// nothing is queued and nothing already queued is sent. Firefox only allows
// technicalAndInteraction collection when it can be turned off, so this is what
// makes the manifest's declaration true rather than aspirational.
let enabled = true;

export function setTelemetryEnabled(on: boolean): void {
  enabled = on;
  if (!on) queue.length = 0;
}

function enqueue(...signals: TelemetrySignal[]): void {
  if (!enabled || !signals.length) return;
  queue.push(...signals);
  if (queue.length > MAX_QUEUE) queue.splice(0, queue.length - MAX_QUEUE);
  if (queue.length >= FLUSH_AT) {
    void flush();
    return;
  }
  if (flushTimer === undefined) flushTimer = setTimeout(() => void flush(), FLUSH_DELAY_MS);
}

async function flush(): Promise<void> {
  if (flushTimer !== undefined) {
    clearTimeout(flushTimer);
    flushTimer = undefined;
  }
  if (sending || queue.length === 0) return;
  sending = true;
  sessionId = await loadSession(); // resolve the stable id before tagging the batch
  const batch = queue.splice(0, queue.length);
  try {
    await fetch(`${__POSTHOG_HOST__}/batch/`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(toPostHogBatch(batch, identity())),
      keepalive: true, // best-effort delivery even as the service worker suspends
    });
  } catch {
    // Never turn a telemetry failure into more telemetry (infinite loop). The
    // batch is dropped: RUM is best-effort, not a durable log.
  } finally {
    sending = false;
    // More arrived while we were sending? Schedule another pass.
    if (queue.length > 0 && flushTimer === undefined) flushTimer = setTimeout(() => void flush(), FLUSH_DELAY_MS);
  }
}

// ── Public API used by background.ts ─────────────────────────────────────────

export function captureException(error: unknown, context: SignalContext = "background", extra?: Record<string, string>): void {
  enqueue(toException(error, context, extra));
}

export function captureEvent(name: string, attributes?: Record<string, string>, context: SignalContext = "background"): void {
  const event: TelemetryEvent = { kind: "event", name, context, timestamp: Date.now() };
  if (attributes) event.attributes = attributes;
  enqueue(event);
}

export function captureMeasurement(metric: string, value: number, context: SignalContext = "background"): void {
  const measurement: TelemetryMeasurement = { kind: "measurement", metric, value, context, timestamp: Date.now() };
  enqueue(measurement);
}

const CLIENT_CONTEXTS: readonly ClientContext[] = ["content", "popup", "options"];

// Ingest a batch forwarded from a page context. The page can only send its own
// origin's signals (client-reporter filters to our code), and we re-stamp the
// context here so a compromised page can't spoof "background". The report is
// attacker-shaped JSON, so its claimed context is checked rather than trusted;
// anything unrecognized is attributed to the least privileged context.
export function ingestClientReport(report: ClientReport): void {
  const context = CLIENT_CONTEXTS.includes(report.context) ? report.context : "content";
  enqueue(...report.signals.map((signal) => ({ ...signal, context })));
}

// Global crash handlers for the service worker itself: every unhandled error
// or rejection in the background becomes an exception signal.
export function installBackgroundErrorHandlers(): void {
  void loadSession(); // warm the persisted id so the first flush doesn't wait on storage
  self.addEventListener("error", (event) => captureException(event.error ?? event.message, "background", { via: "onerror" }));
  self.addEventListener("unhandledrejection", (event) => captureException(event.reason, "background", { via: "unhandledrejection" }));
}
