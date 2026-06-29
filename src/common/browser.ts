// One promise-based extension API for both browsers.
//
// Firefox exposes the standard `browser.*` (promises). Chrome exposes
// `chrome.*`, which in MV3 also returns promises when you omit the callback.
// So a single reference works everywhere — we just need a type for it without
// pulling in @types/firefox-webext-browser or @types/chrome.
type StorageArea = {
  get(keys?: string | string[] | Record<string, unknown> | null): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string | string[]): Promise<void>;
};

type WebExt = {
  runtime: {
    sendMessage(message: unknown): Promise<unknown>;
    onMessage: {
      addListener(
        fn: (message: any, sender: unknown, sendResponse: (response?: unknown) => void) => boolean | void | Promise<unknown>,
      ): void;
    };
    openOptionsPage?(): Promise<void>;
    getURL(path: string): string;
  };
  storage: { local: StorageArea; onChanged: { addListener(fn: (changes: Record<string, { newValue?: unknown }>, area: string) => void): void } };
  tabs: {
    query(info: Record<string, unknown>): Promise<Array<{ id?: number }>>;
    sendMessage(tabId: number, message: unknown): Promise<unknown>;
    create(props: { url: string; active?: boolean }): Promise<{ id?: number }>;
  };
  contextMenus?: {
    create(props: Record<string, unknown>): void;
    onClicked: { addListener(fn: (info: { menuItemId: string | number }, tab?: { id?: number }) => void): void };
    removeAll(): Promise<void>;
  };
};

declare const browser: WebExt | undefined;
declare const chrome: WebExt | undefined;

export const ext: WebExt =
  (typeof browser !== "undefined" && browser) ||
  (typeof chrome !== "undefined" && chrome) ||
  (() => {
    throw new Error("No WebExtension API available");
  })();
