import assert from "node:assert/strict";
import test from "node:test";
import { installWindow, pageChrome } from "./support/dom.js";
import type { Request } from "../src/common/messages.js";

// The content script listens on the page's own document, so a page script can
// dispatch the events it acts on. A synthetic hover plus a bare `I` used to
// ignore a word in the signed-in reader's account.

// The stub goes in before any reader module binds `ext` to the global it finds.
const chrome = pageChrome({ config: {
  apiBase: "https://shirabe.test", accessToken: "access-token", accessTokenExpiresAt: "2999-01-01T00:00:00Z", refreshToken: "refresh-token",
  scopes: ["user:profile:read", "user:study:read", "user:study:write"], entitled: true, account: "Reader",
} });
const sent: Request[] = [];
chrome.runtime.sendMessage = (async (message: Request) => {
  sent.push(message);
  return message.type === "ignore" ? { ok: true, type: "ignore" } : { ok: false, error: "not in this test" };
}) as never;
globalThis.chrome = chrome as never;
const window = installWindow({ frames: true, html: `<p><span class="sb-word" data-lemma="猫" data-reading="ねこ" data-state="none">猫</span></p>` });
Object.assign(globalThis, { location: window.location });
const booted = import("../src/content/content.js").then(() => new Promise((resolve) => setTimeout(resolve, 20)));

// Browsers mark an event the page made with `isTrusted: false`; happy-dom has
// no such field, so each event here says which kind it is.
function dispatch(target: { dispatchEvent(event: never): unknown }, event: object, trusted: boolean): void {
  Object.defineProperty(event, "isTrusted", { value: trusted });
  target.dispatchEvent(event as never);
}

async function hoverAndPressI(trusted: boolean): Promise<void> {
  const word = window.document.querySelector(".sb-word")!;
  dispatch(word, new window.MouseEvent("mouseover", { bubbles: true }), trusted);
  dispatch(window, new window.KeyboardEvent("keydown", { code: "KeyI", key: "i", bubbles: true }), trusted);
  await new Promise((resolve) => setTimeout(resolve, 20));
}

test("a hover and a shortcut the page dispatched write nothing; the reader's own do", async () => {
  await booted;
  await hoverAndPressI(false);
  assert.deepEqual(sent.filter(({ type }) => type === "ignore"), []);

  await hoverAndPressI(true);
  assert.deepEqual(sent.filter(({ type }) => type === "ignore").map(({ type }) => type), ["ignore"]);
});

// The content script keeps page timers and observers for as long as the page
// lives; closing the page lets the process end.
test.after(() => window.happyDOM.close());
