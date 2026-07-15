// Build the bounded logical text window used by cursor scanning without
// flattening the page. Adjacent inline links/emphasis are contiguous, while
// ruby annotations (rt/rp), form controls, and Shirabe UI are excluded.
export function logicalTextAt(node: Text, offset: number, maxChars = 24): { text: string; context: string; contextOffset: number } {
  const block = node.parentElement?.closest("p,li,td,th,dd,dt,h1,h2,h3,h4,h5,h6,blockquote,figcaption,article,section,main,div") ?? node.parentElement;
  if (!block) return { text: [...node.data.slice(offset)].slice(0, maxChars).join(""), context: node.data, contextOffset: offset };
  const nodes: Text[] = [];
  const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT, {
    acceptNode(candidate) {
      const parent = candidate.parentElement;
      if (parent?.closest("rt,rp")) return NodeFilter.FILTER_REJECT;
      return parent?.closest(".sb-host,input,textarea,select,[contenteditable='true']") ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
    },
  });
  for (let current = walker.nextNode(); current; current = walker.nextNode()) nodes.push(current as Text);
  const index = nodes.indexOf(node);
  if (index < 0) return { text: [...node.data.slice(offset)].slice(0, maxChars).join(""), context: node.data, contextOffset: offset };
  const before = nodes.slice(0, index).map((item) => item.data).join("");
  const context = nodes.map((item) => item.data).join("");
  const contextOffset = before.length + offset;
  return { text: [...context.slice(contextOffset)].slice(0, maxChars).join(""), context, contextOffset };
}
