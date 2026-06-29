import { ext } from "./browser.js";
import type { DeviceAuth } from "./api.js";
import type { Definition, ParsedToken, WordState } from "./types.js";

// A grade on Shirabe's 1–4 FSRS scale, matching POST /v1/srs/reviews.
export type Rating = 1 | 2 | 3 | 4;

// What the action popup needs to render the connection state without holding
// the key itself.
export type Status = {
  connected: boolean;
  account: string;
  canWrite: boolean; // key carries WRITE_SRS → mining buttons are usable
  connecting: boolean; // a device-login handshake is mid-flight
  apiBase: string;
};

// Content scripts and the action popup never touch the network or storage
// directly — the background worker owns the API key, the device-login
// handshake, and rate limiting. Everything goes through these.
export type Request =
  | { type: "parse"; text: string }
  | { type: "lookup"; query: string }
  | { type: "save"; lemma: string; rating?: Rating } // rating → mine + grade in one call
  | { type: "setState"; lemma: string; state: "known" | "reviewing" }
  | { type: "connect" } // begin device login; resolves with the code to show
  | { type: "disconnect" }
  | { type: "status" };

export type Response =
  | { ok: true; type: "parse"; tokens: ParsedToken[] }
  | { ok: true; type: "lookup"; definition: Definition | null }
  | { ok: true; type: "save"; state: WordState }
  | { ok: true; type: "setState"; state: WordState }
  | { ok: true; type: "connect"; auth: DeviceAuth }
  | { ok: true; type: "disconnect" }
  | { ok: true; type: "status"; status: Status }
  | { ok: false; error: string };

// Narrow the reply to the request that produced it, so `res.tokens` is only
// reachable after a "parse" request, etc.
type ResponseFor<T extends Request["type"]> = Extract<Response, { ok: true; type: T }> | { ok: false; error: string };

export function send<R extends Request>(request: R): Promise<ResponseFor<R["type"]>> {
  return ext.runtime.sendMessage(request) as Promise<ResponseFor<R["type"]>>;
}
