import type { Definition, ParsedToken } from "../../src/common/types.js";
import type { Request } from "../../src/common/messages.js";

// ONE page for the whole SUITE, and that is a correctness requirement rather
// than tidiness.
//
// The popup is a single shell held in module state: it builds its host into
// whatever `document` is global on first render and caches it. Every test file
// is bundled into one process (test/all.test.ts), so the second file to build a
// window of its own would render into the first one's shadow root and find
// nothing in its own. Both popup suites therefore share this page, and register
// what the background should answer into `answers` instead of stubbing
// `sendMessage` again.

export type Page = {
  window: { document: Document };
  word: typeof import("../../src/content/word.js");
  popup: typeof import("@shirabe-org/card/word-card");
};

/** What the background worker answers, keyed `lookup:<query>` / `entry:<handle>`.
    ONE namespace for every suite, so a key two files both register is whichever
    file the bundle imported last: keep a suite's lemmas its own. */
export const answers: Record<string, Definition | null> = {};
export const spanAnswers: Record<string, Definition[]> = {};
/** Every message the popup sent, so a test can assert on what was ASKED. */
export const asked: Request[] = [];

const HOST = "https://reader.test/page";

/** The popup renders after an async round trip, so let the queue drain rather than assuming one tick. */
export const settle = async (): Promise<void> => {
  for (let index = 0; index < 5; index += 1) await new Promise((resolve) => setTimeout(resolve, 0));
};

// Built on first use, not at import: the suite bundles to CJS, where a
// top-level await will not compile.
let pending: Promise<Page> | null = null;
export const page = (): Promise<Page> => (pending ??= buildPage());

async function buildPage(): Promise<Page> {
  const { Window } = await import("happy-dom");
  const window = new Window({ url: HOST });
  Object.assign(globalThis, {
    window, document: window.document, HTMLElement: window.HTMLElement,
    Node: window.Node, DOMRect: window.DOMRect, getComputedStyle: window.getComputedStyle.bind(window),
    chrome: globalThis.chrome ?? { runtime: { id: "test", sendMessage: async () => ({ ok: true }) } },
  });

  const { ext } = await import("../../src/common/browser.js");
  ext.runtime.sendMessage = (async (message: Request) => {
    asked.push(message);
    if (message.type === "lookup") return { ok: true, type: "lookup", definition: answers[`lookup:${message.query}`] ?? null };
    if (message.type === "lookupEntry") return { ok: true, type: "lookupEntry", definition: answers[`entry:${message.entry}`] ?? null };
    if (message.type === "lookupSpan") {
      const alternatives = spanAnswers[message.text.slice(message.startOffset, message.endOffset)] ?? [];
      return { ok: true, type: "lookupSpan", definition: alternatives[0] ?? null, alternatives };
    }
    if (message.type === "states") return { ok: true, type: "states", states: {}, details: {} };
    return { ok: true };
  }) as typeof ext.runtime.sendMessage;

  // The card has no host until one is given, so the suite installs the real
  // extension one: it runs on the stubbed `sendMessage` above, which keeps these
  // tests exercising the same path the extension takes rather than a fake.
  const popup = await import("@shirabe-org/card/word-card");
  const { extensionHost } = await import("../../src/content/card-host.js");
  popup.setCardHost(extensionHost);

  return {
    window: window as unknown as { document: Document },
    word: await import("../../src/content/word.js"),
    popup,
  };
}

/** Render a token onto the page and open its card, as a hover would. */
export async function hover(token: Partial<ParsedToken>, context?: { sentence: string; start: number }): Promise<HTMLElement> {
  const { window, word: words, popup } = await page();
  const node = words.renderToken({
    start: 0, length: 2, surface: "きみ", reading: null, lemma: "きみ",
    pos: "noun", content: true, state: "none", ...token,
  } as ParsedToken, false, context);
  window.document.body.append(node as never);

  const word = node as unknown as HTMLElement;
  popup.showNow(word);
  await settle();
  return word;
}

/** The popup's shadow root: everything it draws lives in here. */
export async function shadow(): Promise<ShadowRoot> {
  const { window } = await page();
  const host = window.document.querySelector(".sb-host") as unknown as { shadowRoot: ShadowRoot };
  return host.shadowRoot;
}

/** Everything the popup drew matching a selector, as elements. */
export async function drawn(selector: string): Promise<HTMLElement[]> {
  return [ ...(await shadow()).querySelectorAll(selector) ] as HTMLElement[];
}
