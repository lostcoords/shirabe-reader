import { Window } from "happy-dom";

/** The slice of the WebExtension API a page script reaches for at import. */
export function pageChrome(storage: Record<string, unknown> = {}) {
  return {
    runtime: { id: "test", sendMessage: async () => ({ ok: true }), onMessage: { addListener() {} }, getURL: (path: string) => path },
    storage: {
      local: {
        get: async () => storage,
        set: async (values: Record<string, unknown>) => { Object.assign(storage, values); },
        remove: async () => {},
      },
      onChanged: { addListener() {} },
    },
  };
}

/**
 * Install `pageChrome` unless a stub is already there. `browser.ts` binds `ext`
 * to whichever global it finds on first import, and the unit suites share one
 * process, so a test answers through `ext.runtime.sendMessage` rather than by
 * swapping the global.
 */
export function ensureChrome(): void {
  globalThis.chrome ??= pageChrome();
}

/**
 * A fresh happy-dom page, with its DOM classes installed as the globals the
 * reader's modules read. `frames` adds requestAnimationFrame as a plain task, for
 * a test that waits on render work; without it, deferred work such as the
 * word-state refresh never runs after the test that queued it has ended.
 */
export function installWindow({ url = "https://reader.test/page", html = "", frames = false }: { url?: string; html?: string; frames?: boolean } = {}) {
  const window = new Window({ url });
  window.document.body.innerHTML = html;
  Object.assign(globalThis, {
    window, document: window.document, Node: window.Node, NodeFilter: window.NodeFilter, HTMLElement: window.HTMLElement,
    Text: window.Text, DOMRect: window.DOMRect, MutationObserver: window.MutationObserver,
    Option: (window as unknown as { Option: unknown }).Option, getComputedStyle: window.getComputedStyle.bind(window),
    ...(frames ? {
      requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0) as unknown as number,
      cancelAnimationFrame: (handle: number) => clearTimeout(handle),
    } : {}),
  });
  ensureChrome();
  return window;
}
