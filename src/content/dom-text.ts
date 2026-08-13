// Build the bounded logical text window used by cursor scanning without
// flattening the page. Adjacent inline links/emphasis are contiguous, while
// ruby annotations (rt/rp), form controls, and Shirabe UI are excluded.
// maxChars mirrors the background's MAX_SCAN_CHARS lookup bound (offline-dictionary):
// the window it reads forward from the caret is the longest term the dictionary
// can still match, so long compounds / expressions aren't truncated mid-word.
const BLOCK_SELECTOR = "p,li,td,th,dd,dt,h1,h2,h3,h4,h5,h6,blockquote,figcaption,article,section,main,div";

// Text nodes the scanner reads: page prose only: ruby readings (rt/rp), form
// controls, editables, and Shirabe's own UI are excluded. Shared by the window
// builder and the highlight range so both see the same text.
function acceptTextNode(candidate: Node): number {
  const parent = (candidate as Text).parentElement;
  if (parent?.closest("rt,rp")) return NodeFilter.FILTER_REJECT;
  return parent?.closest(".sb-host,input,textarea,select,[contenteditable='true']") ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
}

// What a SELECTION says, with the furigana taken out. `Selection#toString()`
// reads every text node it spans, `<rt>` among them, so highlighting 帰った on a
// page with furigana on hands the dictionary 帰かえった and it finds nothing. The
// caret scanner has always skipped ruby (`acceptTextNode` above); the selection
// paths did not, which is why the escape hatch for a bad cut was the one lookup
// that broke on exactly the pages that need it.
//
// `cloneContents` rather than a TreeWalker: the fragment already carries the
// clipped first and last nodes, so removing the annotations from a copy is the
// whole job and there are no boundary offsets to get wrong.
export function rangeText(range: Range): string {
  const fragment = range.cloneContents();
  for (const annotation of fragment.querySelectorAll("rt,rp")) annotation.remove();
  return (fragment.textContent ?? "").trim();
}

// The same for whatever is selected now, across the open shadow root as well:
// Firefox exposes a selection inside one on the root rather than on `window`.
export function selectionText(selection: Selection | null | undefined): string {
  if (!selection?.rangeCount) return "";
  return rangeText(selection.getRangeAt(0));
}

export function logicalTextAt(node: Text, offset: number, maxChars = 32): { text: string; context: string; contextOffset: number } {
  const block = node.parentElement?.closest(BLOCK_SELECTOR) ?? node.parentElement;
  if (!block) return { text: [...node.data.slice(offset)].slice(0, maxChars).join(""), context: node.data, contextOffset: offset };
  const nodes: Text[] = [];
  const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT, { acceptNode: acceptTextNode });
  for (let current = walker.nextNode(); current; current = walker.nextNode()) nodes.push(current as Text);
  const index = nodes.indexOf(node);
  if (index < 0) return { text: [...node.data.slice(offset)].slice(0, maxChars).join(""), context: node.data, contextOffset: offset };

  // Join the text nodes, but insert a newline wherever a block-level boundary
  // separates two of them: otherwise the last word of one paragraph/list item
  // glues onto the first of the next (「…です猫が…」), corrupting both the lookup
  // window and sentence detection. A newline is exactly what `sentenceAround`
  // treats as a boundary. Nodes inside a single block (inline links/emphasis/
  // ruby base) share a block ancestor and stay contiguous.
  let context = "";
  let contextOffset = offset;
  let previousBlock: Element | null = null;
  for (let i = 0; i < nodes.length; i += 1) {
    const item = nodes[i];
    const itemBlock = nearestBlock(item.parentElement, block);
    if (previousBlock && itemBlock !== previousBlock) context += "\n";
    if (i === index) contextOffset = context.length + offset;
    context += item.data;
    previousBlock = itemBlock;
  }
  return { text: [...context.slice(contextOffset)].slice(0, maxChars).join(""), context, contextOffset };
}

// Block-level elements between two text nodes are real word boundaries. Detected
// by tag (not computed style) so it is deterministic and cheap on the hot scan
// path; mirrors the tag set `logicalTextAt` already uses to pick the block root.
const BLOCK_TAGS = new Set([
  "P", "DIV", "LI", "UL", "OL", "DL", "DT", "DD", "TD", "TH", "TR", "TABLE", "THEAD", "TBODY", "TFOOT", "CAPTION",
  "H1", "H2", "H3", "H4", "H5", "H6", "BLOCKQUOTE", "FIGURE", "FIGCAPTION", "ARTICLE", "SECTION", "MAIN",
  "ASIDE", "HEADER", "FOOTER", "NAV", "ADDRESS", "PRE", "HR", "FORM", "FIELDSET", "DETAILS", "SUMMARY",
]);

// The nearest block-level ancestor of a text node, bounded by `root` (itself a
// block). Two text nodes with different nearest blocks are in different blocks.
function nearestBlock(start: Element | null, root: Element): Element {
  for (let el = start; el && el !== root; el = el.parentElement) {
    if (BLOCK_TAGS.has(el.tagName)) return el;
  }
  return root;
}

// A DOM Range spanning `length` UTF-16 code units forward from (node, offset),
// walking the same inline text nodes `logicalTextAt` reads, so a caret lookup can
// highlight exactly the term it matched. Bounded to the caret's block, and to the
// available text when the run is shorter than `length`.
export function rangeFromCaret(node: Text, offset: number, length: number): Range {
  const block = node.parentElement?.closest(BLOCK_SELECTOR) ?? node.parentElement ?? node;
  const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT, { acceptNode: acceptTextNode });
  walker.currentNode = node;
  const range = document.createRange();
  range.setStart(node, offset);
  let current: Text | null = node;
  let start = offset;
  let remaining = length;
  while (current) {
    const available = current.data.length - start;
    if (remaining <= available) {
      range.setEnd(current, start + remaining);
      return range;
    }
    remaining -= available;
    range.setEnd(current, current.data.length); // fall back to end-of-run if we run out
    current = walker.nextNode() as Text | null;
    start = 0;
  }
  return range;
}
