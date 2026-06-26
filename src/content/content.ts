import { ext } from "../common/browser.js";
import { loadConfig } from "../common/config.js";
import { parse } from "./parser.js";
import { scheduleHide, scheduleShow } from "./popup.js";

let showFurigana = true;

// Hover-to-define via event delegation — works for words added at any time.
document.addEventListener("mouseover", (e) => {
  const word = (e.target as Element | null)?.closest?.(".sb-word");
  if (word instanceof HTMLElement) scheduleShow(word);
});
document.addEventListener("mouseout", (e) => {
  if ((e.target as Element | null)?.closest?.(".sb-word")) scheduleHide();
});

// On-demand parsing triggered from the context menu / action popup.
ext.runtime.onMessage.addListener((message: { command?: string }) => {
  if (message.command === "parsePage") {
    parse(document.body, showFurigana);
  } else if (message.command === "parseSelection") {
    const range = window.getSelection()?.getRangeAt(0);
    const root =
      range?.commonAncestorContainer.nodeType === Node.ELEMENT_NODE
        ? (range.commonAncestorContainer as Element)
        : range?.commonAncestorContainer.parentElement;
    if (root) parse(root, showFurigana);
  }
});

loadConfig().then((config) => {
  showFurigana = config.showFurigana;
  if (config.autoParse) parse(document.body, showFurigana);
});
