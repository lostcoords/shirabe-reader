import { ext, type RuntimePort } from "./browser.js";
import type { Failure, Request, Response } from "./messages.js";

type DictionaryRequest = Extract<Request, { type: "dictionaryStatus" | "installDictionary" | "removeDictionary" | "cancelDictionaryInstall" }>;
type DictionaryReply = Extract<Response, { type: DictionaryRequest["type"] }> | Failure;
type DictionaryReplyFor<R extends DictionaryRequest> = Extract<Response, { type: R["type"] }> | Failure;

let port: RuntimePort | null = null;
let messageId = 0;
const replies = new Map<number, { resolve: (response: DictionaryReply) => void; timer: number }>();

export function sendDictionary<R extends DictionaryRequest>(request: R): Promise<DictionaryReplyFor<R>> {
  const id = ++messageId;
  const activePort = dictionaryPort();
  return new Promise((resolve) => {
    const timer = window.setTimeout(() => {
      replies.delete(id);
      resolve({ ok: false, error: `Dictionary background timed out while handling ${request.type}.` });
    }, request.type === "installDictionary" ? 10 * 60 * 1000 : 15_000);
    replies.set(id, { resolve: resolve as (response: DictionaryReply) => void, timer });
    activePort.postMessage({ id, request });
  });
}

function dictionaryPort(): RuntimePort {
  if (port) return port;
  port = ext.runtime.connect({ name: "shirabe-dictionary" });
  port.onMessage.addListener((message: { id?: unknown; response?: DictionaryReply }) => {
    if (!Number.isInteger(message.id) || !message.response) return;
    const id = message.id as number;
    const pending = replies.get(id);
    if (!pending) return;
    window.clearTimeout(pending.timer);
    replies.delete(id);
    pending.resolve(message.response);
  });
  port.onDisconnect.addListener(() => {
    port = null;
    for (const { resolve, timer } of replies.values()) {
      window.clearTimeout(timer);
      resolve({ ok: false, error: "Firefox disconnected the dictionary background port." });
    }
    replies.clear();
  });
  return port;
}
