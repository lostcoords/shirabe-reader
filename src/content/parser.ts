import { send } from "../common/messages.js";
import { renderToken } from "./word.js";

const JAPANESE = /[぀-ヿ一-龯㐀-䶿ｦ-ﾟ]/;
const SKIP_TAGS = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEXTAREA", "INPUT", "CODE", "PRE", "RUBY"]);
const PARSED_FLAG = "sbParsed"; // dataset key on the wrapper we insert

// Collect text nodes worth parsing under `root`: visible, Japanese-bearing, and
// not already processed or inside something we shouldn't touch (form fields,
// our own output, editable regions).
function collectTextNodes(root: Node): Text[] {
  const nodes: Text[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const text = node.nodeValue;
      if (!text || !JAPANESE.test(text)) return NodeFilter.FILTER_REJECT;

      const parent = node.parentElement;
      if (!parent) return NodeFilter.FILTER_REJECT;
      if (SKIP_TAGS.has(parent.tagName)) return NodeFilter.FILTER_REJECT;
      if (parent.isContentEditable) return NodeFilter.FILTER_REJECT;
      if (parent.closest("[data-sb-parsed], .sb-word, .sb-popup")) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });

  for (let n = walker.nextNode(); n; n = walker.nextNode()) nodes.push(n as Text);
  return nodes;
}

// Replace one text node with its tokenized, word-wrapped equivalent.
async function parseTextNode(node: Text, showFurigana: boolean): Promise<void> {
  const text = node.nodeValue ?? "";
  const res = await send({ type: "parse", text });
  if (!res.ok) throw new Error(res.error);
  if (!node.parentNode) return; // node was removed while we waited

  const wrapper = document.createElement("span");
  wrapper.dataset[PARSED_FLAG] = "1";

  let cursor = 0;
  for (const token of res.tokens) {
    if (token.start > cursor) wrapper.append(text.slice(cursor, token.start)); // whitespace/gaps
    wrapper.append(renderToken(token, showFurigana));
    cursor = token.start + token.length;
  }
  if (cursor < text.length) wrapper.append(text.slice(cursor));

  node.parentNode.replaceChild(wrapper, node);
}

// Parse everything under `root`. Returns how many text nodes were processed.
export async function parse(root: Node, showFurigana: boolean): Promise<number> {
  const nodes = collectTextNodes(root);
  // Sequential: the background worker already rate-limits, and serial requests
  // keep memory flat on long pages. Failures on one node don't sink the rest.
  for (const node of nodes) {
    try {
      await parseTextNode(node, showFurigana);
    } catch (err) {
      console.warn("[Shirabe] parse failed for a node:", err);
    }
  }
  return nodes.length;
}
