import assert from "node:assert/strict";
import test from "node:test";
import { hostOnly, parseFrames, scrub, toException, toPostHogBatch, MAX_MESSAGE, type PostHogIdentity, type TelemetrySignal } from "../src/common/telemetry.js";

test("scrub caps length and hostOnly keeps only the host", () => {
  assert.equal(scrub("x".repeat(1000)).length, MAX_MESSAGE);
  assert.equal(scrub(null), "");
  // Never the path/query: only the registrable host survives.
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
  const firefoxFrames = parseFrames(firefox);
  assert.equal(firefoxFrames.length, 2);
  assert.deepEqual(firefoxFrames[0], { function: "onClick", filename: "moz-extension://abc/content.js", lineno: 40, colno: 9 });
  assert.deepEqual(firefoxFrames[1], { function: "doThing", filename: "moz-extension://abc/content.js", lineno: 12, colno: 5 });

  assert.deepEqual(parseFrames(undefined), []);
});

const posthogIdentity: PostHogIdentity = {
  token: "phc_test",
  surface: "extension",
  appVersion: "0.2.3",
  environment: "production",
  sessionId: "session-1",
  userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/122.0.0.0 Safari/537.36",
  platform: { anki_version: "25.09.4" },
};

type Captured = { api_key: string; batch: Array<{ event: string; properties: Record<string, unknown> }> };

test("an exception arrives as $exception with a stack, which is what groups two reports into one issue", () => {
  const signals: TelemetrySignal[] = [{
    kind: "exception", type: "TypeError", value: "x is not a function",
    stack: "at parse (chrome-extension://abc/content.js:10:5)", context: "content", timestamp: 0,
  }];
  const sent = toPostHogBatch(signals, posthogIdentity) as Captured;

  assert.equal(sent.api_key, "phc_test");
  assert.equal(sent.batch[0]!.event, "$exception");
  const list = sent.batch[0]!.properties.$exception_list as Array<{ type: string; value: string; stacktrace: { frames: unknown[] } }>;
  assert.equal(list[0]!.type, "TypeError");
  assert.ok(list[0]!.stacktrace.frames.length > 0, "without frames PostHog cannot tell two crashes apart");
});

test("every event says which surface it came from, because they all send the same signals", () => {
  const signals: TelemetrySignal[] = [{ kind: "event", name: "word_saved", context: "content", timestamp: 0 }];
  const sent = toPostHogBatch(signals, posthogIdentity) as Captured;
  const props = sent.batch[0]!.properties;

  assert.equal(sent.batch[0]!.event, "word_saved");
  assert.equal(props.surface, "extension", "a chart that cannot separate the surfaces cannot answer 'is Anki broken'");
  assert.equal(props.distinct_id, "session-1");
  assert.equal(props.app_version, "0.2.3");
  assert.equal(props.anki_version, "25.09.4", "whatever the surface knows about where it runs rides along");
});

test("the reader is a session, never a person", () => {
  const signals: TelemetrySignal[] = [{ kind: "event", name: "x", context: "content", timestamp: 0 }];
  const props = (toPostHogBatch(signals, posthogIdentity) as Captured).batch[0]!.properties;
  assert.equal(props.distinct_id, posthogIdentity.sessionId);
  assert.equal(JSON.stringify(props).includes("@"), false, "no address ever reaches a property");
});

test("a measurement keeps its own name so it can be charted", () => {
  const signals: TelemetrySignal[] = [{ kind: "measurement", metric: "lookup_ms", value: 42, context: "background", timestamp: 0 }];
  const sent = toPostHogBatch(signals, posthogIdentity) as Captured;
  assert.equal(sent.batch[0]!.event, "lookup_ms");
  assert.equal(sent.batch[0]!.properties.value, 42);
});
