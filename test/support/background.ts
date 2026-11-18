import type { Request, Response as WorkerResponse } from "../../src/common/messages.js";

// The background worker registers its listeners and crash handlers on import,
// so each suite that drives it runs in a process of its own: stub the browser,
// seed storage and fetch, then start the worker.

type Listener = (request: Request, sender: object, respond: (response: WorkerResponse) => void) => unknown;

export type BackgroundOptions = {
  /** What `permissions.contains` answers: whether optional data collection was granted. */
  permissions?: boolean;
  /** The tabs `tabs.query` lists. */
  tabs?: Array<{ id: number }>;
  /** Firefox exposes the same API as `browser`, and the worker answers it with promises. */
  firefox?: boolean;
  /** Extra extension namespaces, such as `alarms`. */
  apis?: Record<string, unknown>;
};

export type Background = {
  storage: Record<string, unknown>;
  /** Every message the worker sent to a tab. */
  tabMessages: unknown[];
  /**
   * Import the worker and return its message listener as a function. Each call
   * also holds the listener to its browser's contract: Chrome keeps the channel
   * open by returning `true`, Firefox answers with a promise.
   */
  start(): Promise<(request: Request) => Promise<WorkerResponse>>;
};

export function stubBackground({ permissions = false, tabs = [], firefox = false, apis = {} }: BackgroundOptions = {}): Background {
  const storage: Record<string, unknown> = {};
  const tabMessages: unknown[] = [];
  const event = { addListener() {} };
  let listener: Listener | undefined;
  const chrome = {
    runtime: {
      onMessage: { addListener(callback: Listener) { listener = callback; } },
      onConnect: event, onInstalled: event, getURL: (path: string) => path,
    },
    storage: {
      local: {
        get: async (keys?: string | string[]) => keys == null ? storage : Object.fromEntries([keys].flat().map((key) => [key, storage[key]])),
        set: async (values: Record<string, unknown>) => { Object.assign(storage, values); },
        remove: async (keys: string | string[]) => { for (const key of [keys].flat()) delete storage[key]; },
      },
      onChanged: event,
    },
    tabs: { onRemoved: event, query: async () => tabs, sendMessage: async (_tabId: number, message: unknown) => { tabMessages.push(message); } },
    scripting: { unregisterContentScripts: async () => {} },
    permissions: { contains: async () => permissions },
    ...apis,
  };
  Object.assign(globalThis, { self: { addEventListener() {} }, chrome, ...(firefox ? { browser: chrome } : {}) });
  return {
    storage,
    tabMessages,
    async start() {
      await import("../../src/background/background.js");
      return (request) => new Promise<WorkerResponse>((resolve, reject) => {
        const result = listener!(request, {}, resolve);
        if (firefox && result instanceof Promise) void result.then(resolve);
        else if (firefox || result !== true) reject(new Error(`the listener answered ${request.type} with ${String(result)}, outside the ${firefox ? "Firefox" : "Chrome"} contract`));
      });
    },
  };
}
