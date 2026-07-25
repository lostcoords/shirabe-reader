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

export type RuntimePort = {
  name: string;
  sender?: { tab?: { id?: number } };
  postMessage(message: unknown): void;
  disconnect(): void;
  onMessage: { addListener(fn: (message: any) => void): void };
  onDisconnect: { addListener(fn: () => void): void };
};

type WebExt = {
  action?: {
    setBadgeText(details: { text: string; tabId?: number }): Promise<void>;
    setBadgeBackgroundColor(details: { color: string; tabId?: number }): Promise<void>;
  };
  runtime: {
    sendMessage(message: unknown): Promise<unknown>;
    connect(connectInfo?: { name?: string }): RuntimePort;
    onConnect: { addListener(fn: (port: RuntimePort) => void): void };
    onMessage: {
      addListener(
        fn: (message: any, sender: { tab?: { id?: number; windowId?: number } }, sendResponse: (response?: unknown) => void) => boolean | void | Promise<unknown>,
      ): void;
    };
    onInstalled?: { addListener(fn: (details: { reason: "install" | "update" | "chrome_update" | "shared_module_update" }) => void): void };
    openOptionsPage?(): Promise<void>;
    getURL(path: string): string;
    // Used as a light keep-alive ping while a long dictionary install runs without
    // an open popup (MV3 service workers otherwise suspend and drop in-memory state).
    getPlatformInfo?(): Promise<unknown>;
    // Watch builds only, to reload themselves after a rebuild (`dev-reload.ts`).
    reload?(): void;
  };
  storage: {
    local: StorageArea;
    session?: StorageArea;
    onChanged: { addListener(fn: (changes: Record<string, { newValue?: unknown }>, area: string) => void): void };
  };
  tabs: {
    query(info: Record<string, unknown>): Promise<Array<{ id?: number; url?: string; windowId?: number }>>;
    sendMessage(tabId: number, message: unknown): Promise<unknown>;
    create(props: { url: string; active?: boolean }): Promise<{ id?: number }>;
    captureVisibleTab(windowId?: number, options?: { format?: "png" | "jpeg"; quality?: number }): Promise<string>;
    onRemoved: { addListener(fn: (tabId: number) => void): void };
  };
  scripting: {
    executeScript(details: { target: { tabId: number; allFrames?: boolean }; func?: () => unknown; files?: string[] }): Promise<Array<{ result?: unknown }>>;
    insertCSS(details: { target: { tabId: number; allFrames?: boolean }; files: string[] }): Promise<void>;
    registerContentScripts(scripts: Array<{
      id: string; matches: string[]; js?: string[]; css?: string[]; allFrames?: boolean;
      persistAcrossSessions?: boolean; runAt?: "document_start" | "document_end" | "document_idle";
    }>): Promise<void>;
    unregisterContentScripts(filter?: { ids?: string[] }): Promise<void>;
  };
  permissions: {
    contains(permissions: { origins?: string[]; permissions?: string[] }): Promise<boolean>;
    request(permissions: { origins?: string[]; permissions?: string[] }): Promise<boolean>;
  };
  contextMenus?: {
    create(props: Record<string, unknown>): void;
    onClicked: { addListener(fn: (info: { menuItemId: string | number }, tab?: { id?: number }) => void): void };
    removeAll(): Promise<void>;
  };
  identity: {
    // The extension's own redirect URL (Chrome: <id>.chromiumapp.org, Firefox:
    // <uuid>.extensions.allizom.org). Resolves the final redirect after login.
    getRedirectURL(path?: string): string;
    launchWebAuthFlow(details: { url: string; interactive?: boolean }): Promise<string>;
  };
};

declare const browser: WebExt | undefined;
declare const chrome: WebExt | undefined;

// Firefox's `browser.runtime.onMessage` natively supports Promise responses and
// recommends them. Chrome versions before 148 require `sendResponse` + a
// literal `true`, so the background listener selects the contract explicitly.
export const usesPromiseMessageResponses = typeof browser !== "undefined";

export const ext: WebExt =
  (typeof browser !== "undefined" && browser) ||
  (typeof chrome !== "undefined" && chrome) ||
  (() => {
    throw new Error("No WebExtension API available");
  })();
