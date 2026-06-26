import { ext } from "./browser.js";
import type { Definition, ParsedToken, WordState } from "./types.js";

// Content scripts never touch the network or storage directly — the background
// worker owns the API key and rate limiting. Everything goes through these.
export type Request =
  | { type: "parse"; text: string }
  | { type: "lookup"; query: string }
  | { type: "save"; lemma: string }
  | { type: "setState"; lemma: string; state: WordState };

export type Response =
  | { ok: true; type: "parse"; tokens: ParsedToken[] }
  | { ok: true; type: "lookup"; definition: Definition | null }
  | { ok: true; type: "save" }
  | { ok: true; type: "setState" }
  | { ok: false; error: string };

// Narrow the reply to the request that produced it, so `res.tokens` is only
// reachable after a "parse" request, etc.
type ResponseFor<T extends Request["type"]> = Extract<Response, { ok: true; type: T }> | { ok: false; error: string };

export function send<R extends Request>(request: R): Promise<ResponseFor<R["type"]>> {
  return ext.runtime.sendMessage(request) as Promise<ResponseFor<R["type"]>>;
}
