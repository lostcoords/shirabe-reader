import { ext } from "../common/browser.js";
import { canWriteSrs, loadConfig, onConfigChanged, type Config, type PopupTrigger } from "../common/config.js";
import { grade, markKnown, save, type Outcome } from "./actions.js";
import { parse } from "./parser.js";
import { scheduleHide, scheduleShow, setCanWrite, showNow } from "./popup.js";
import { toast } from "./toast.js";

let trigger: PopupTrigger = "hover";
let showFurigana = true;
let altDown = false;
let hovered: HTMLElement | null = null; // the .sb-word under the pointer, popup or not

function apply(config: Config): void {
  trigger = config.popupTrigger;
  showFurigana = config.showFurigana;
  setCanWrite(canWriteSrs(config));
}

loadConfig().then((config) => {
  apply(config);
  if (config.autoParse) parsePage();
});
onConfigChanged(apply);

// ── Hover → popup, gated by the trigger setting ──────────────────────────────
const wantPopup = () => trigger === "hover" || altDown;

document.addEventListener("mouseover", (e) => {
  const word = (e.target as Element | null)?.closest?.(".sb-word");
  if (word instanceof HTMLElement) {
    hovered = word;
    if (wantPopup()) scheduleShow(word);
  }
});
document.addEventListener("mouseout", (e) => {
  if ((e.target as Element | null)?.closest?.(".sb-word")) {
    hovered = null;
    scheduleHide();
  }
});

// In "modifier" mode the popup waits for Alt/Option; pressing it while already
// hovering a word reveals it at once.
window.addEventListener("keydown", (e) => {
  if (e.key === "Alt") {
    altDown = true;
    if (trigger === "modifier" && hovered) showNow(hovered);
  }
});
window.addEventListener("keyup", (e) => {
  if (e.key === "Alt") altDown = false;
});
window.addEventListener("blur", () => {
  altDown = false;
});

// ── Mining / review keyboard shortcuts — act on the hovered word ─────────────
const SHORTCUTS: Record<string, (w: HTMLElement) => Promise<Outcome>> = {
  "1": (w) => grade(w, 1),
  "2": (w) => grade(w, 2),
  "3": (w) => grade(w, 3),
  "4": (w) => grade(w, 4),
  s: save,
  k: markKnown,
};

window.addEventListener("keydown", (e) => {
  if (e.ctrlKey || e.metaKey || e.altKey) return; // leave browser shortcuts alone
  if (isTyping(e.target)) return;
  const action = SHORTCUTS[e.key.toLowerCase()];
  if (!action || !hovered) return;
  e.preventDefault();
  action(hovered).then(({ ok, message }) => toast(message, ok));
});

function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  return !!el && (el.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName));
}

// ── Parsing: on-demand from the menu/popup, plus dynamic content ─────────────
async function parsePage(): Promise<void> {
  await parse(document.body, showFurigana);
  observeMutations();
}

ext.runtime.onMessage.addListener((message: { command?: string }) => {
  if (message.command === "parsePage") {
    parsePage();
  } else if (message.command === "parseSelection") {
    const range = window.getSelection()?.getRangeAt(0);
    const node = range?.commonAncestorContainer;
    const root = node?.nodeType === Node.ELEMENT_NODE ? (node as Element) : node?.parentElement;
    if (root) parse(root, showFurigana);
  }
});

// Re-parse content the page adds later (SPA navigations, infinite scroll,
// lazy-loaded sections). Debounced; only fresh subtrees are queued, and the
// parser already skips anything we've wrapped, so our own writes don't loop.
let observer: MutationObserver | null = null;
const pending = new Set<Element>();
let flushTimer: number | undefined;

function observeMutations(): void {
  if (observer) return;
  observer = new MutationObserver((records) => {
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (node.nodeType !== Node.ELEMENT_NODE) continue;
        const el = node as Element;
        if (el.closest("[data-sb-parsed], .sb-word, .sb-host")) continue;
        pending.add(el);
      }
    }
    if (pending.size) scheduleFlush();
  });
  observer.observe(document.body, { childList: true, subtree: true });
}

function scheduleFlush(): void {
  window.clearTimeout(flushTimer);
  flushTimer = window.setTimeout(async () => {
    const batch = [...pending];
    pending.clear();
    for (const el of batch) {
      if (el.isConnected) await parse(el, showFurigana);
    }
  }, 350);
}
