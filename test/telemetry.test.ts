import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { hostOnly, parseFrames, scrub, toException, toFaroPayload, MAX_MESSAGE, type FaroIdentity, type TelemetrySignal } from "../src/common/telemetry.js";

const identity: FaroIdentity = {
  appVersion: "0.2.0",
  environment: "development",
  sessionId: "sess-1",
  userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36",
};

test("scrub caps length and hostOnly keeps only the host", () => {
  assert.equal(scrub("x".repeat(1000)).length, MAX_MESSAGE);
  assert.equal(scrub(null), "");
  // Never the path/query — only the registrable host survives.
  assert.equal(hostOnly("https://ja.wikipedia.org/wiki/秘密のページ?q=読んでいる"), "ja.wikipedia.org");
  assert.equal(hostOnly("not a url"), undefined);
});

test("toException normalizes any thrown value and truncates the stack", () => {
  const err = new TypeError("boom");
  err.stack = "TypeError: boom\n" + "  at f (x.js:1:1)\n".repeat(2000);
  const ex = toException(err, "background");
  assert.equal(ex.kind, "exception");
  assert.equal(ex.type, "TypeError");
  assert.equal(ex.value, "boom");
  assert.ok(ex.stack && ex.stack.length <= 4000);

  const fromString = toException("plain failure", "content");
  assert.equal(fromString.type, "Error");
  assert.equal(fromString.value, "plain failure");
});

test("parseFrames reads V8 and Firefox stacks, outermost-first", () => {
  const v8 = "Error: x\n    at doThing (chrome-extension://abc/content.js:12:5)\n    at onClick (chrome-extension://abc/content.js:40:9)";
  const frames = parseFrames(v8);
  assert.equal(frames.length, 2);
  // Reversed to outermost-first: onClick (outer) before doThing (inner).
  assert.deepEqual(frames[0], { function: "onClick", filename: "chrome-extension://abc/content.js", lineno: 40, colno: 9 });

  const firefox = "doThing@moz-extension://abc/content.js:12:5\nonClick@moz-extension://abc/content.js:40:9";
  assert.equal(parseFrames(firefox).length, 2);
  assert.deepEqual(parseFrames(undefined), []);
});

test("toFaroPayload produces the receiver's shape and tags app/environment", () => {
  const signals: TelemetrySignal[] = [
    { kind: "exception", type: "Error", value: "nope", stack: "Error: nope\n    at f (chrome-extension://abc/content.js:1:1)", context: "content", timestamp: 0 },
    { kind: "event", name: "dictionary_install_failed", attributes: { stage: "download" }, context: "background", timestamp: 0 },
    { kind: "measurement", metric: "parse_failed", value: 1, context: "content", timestamp: 0 },
  ];
  const payload = toFaroPayload(signals, identity) as {
    meta: { app: { name: string; environment: string }; browser: { name: string }; session: { id: string } };
    exceptions: Array<{ type: string; stacktrace: { frames: unknown[] }; context: { source: string } }>;
    events: Array<{ name: string; domain: string; attributes: Record<string, string> }>;
    measurements: Array<{ type: string; values: Record<string, number> }>;
  };

  assert.equal(payload.meta.app.name, "shirabe-reader");
  assert.equal(payload.meta.app.environment, "development");
  assert.equal(payload.meta.browser.name, "Chrome");
  assert.equal(payload.meta.session.id, "sess-1");
  assert.equal(payload.exceptions.length, 1);
  assert.equal(payload.exceptions[0].stacktrace.frames.length, 1);
  assert.equal(payload.exceptions[0].context.source, "content");
  assert.equal(payload.events[0].name, "dictionary_install_failed");
  assert.equal(payload.events[0].attributes.stage, "download");
  assert.deepEqual(payload.measurements[0].values, { parse_failed: 1 });
});

test("named failure counters are wired at their choke points", () => {
  const background = readFileSync("src/background/background.ts", "utf8");
  // Onboarding + backend-health counters ride the central errorResponse hook.
  assert.match(background, /captureEvent\("dictionary_install_failed"/);
  assert.match(background, /err instanceof ApiError && err\.status >= 500/);
  assert.match(background, /captureEvent\("api_error"/);
  // Core-functionality + feature counters at their own sites.
  assert.match(background, /captureMeasurement\("parse_failed", 1\)/);
  assert.match(background, /captureEvent\("audio_fetch_failed"/);
});

test("the client reporter only forwards our own errors, never the host page's", () => {
  const reporter = readFileSync("src/common/client-reporter.ts", "utf8");
  // The extension-origin gate is what keeps a page's own JS errors out.
  assert.match(reporter, /ext\.runtime\.getURL\(""\)/);
  assert.match(reporter, /stack\.includes\(extBase\)/);
});
