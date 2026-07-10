// A floating "Parse" button, JitenReader-style: fixed in the bottom-right
// corner, semi-transparent until hovered, so it stays out of the way while
// reading. It's the manual trigger for pages we don't auto-parse — the user can
// hide it entirely from settings. Lives in its own shadow host so the page's
// CSS can never reach it. One reused instance; show/hide are idempotent.
let host: HTMLElement | null = null;

export function showParseButton(onParse: () => void): void {
  if (host) return;
  host = document.createElement("div");
  host.className = "sb-parse-host";
  const root = host.attachShadow({ mode: "open" });

  const style = document.createElement("style");
  style.textContent = CSS;

  const label = document.createElement("span");
  label.textContent = "Parse";

  const btn = document.createElement("button");
  btn.className = "sb-parse-btn";
  btn.type = "button";
  btn.title = "Parse this page with Shirabe";
  btn.append(magnifier(), label);
  btn.addEventListener("click", () => onParse());

  root.append(style, btn);
  document.body.append(host);
}

export function hideParseButton(): void {
  host?.remove();
  host = null;
}

// Inline magnifier so we don't depend on a web-accessible image asset.
const SVG_NS = "http://www.w3.org/2000/svg";
function magnifier(): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", "15");
  svg.setAttribute("height", "15");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2.2");
  svg.setAttribute("stroke-linecap", "round");
  const circle = document.createElementNS(SVG_NS, "circle");
  circle.setAttribute("cx", "10.5");
  circle.setAttribute("cy", "10.5");
  circle.setAttribute("r", "6.5");
  const line = document.createElementNS(SVG_NS, "line");
  line.setAttribute("x1", "15.5");
  line.setAttribute("y1", "15.5");
  line.setAttribute("x2", "21");
  line.setAttribute("y2", "21");
  svg.append(circle, line);
  return svg;
}

const CSS = `
:host { all: initial; }
.sb-parse-btn {
  position: fixed;
  right: 16px;
  bottom: 16px;
  z-index: 2147483646;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 9px 14px;
  font: 600 13px/1 system-ui, -apple-system, sans-serif;
  color: #ffffff;
  background: #4f46e5;
  border: none;
  border-radius: 999px;
  box-shadow: 0 6px 20px rgba(15, 23, 42, 0.25);
  cursor: pointer;
  opacity: 0.35;
  transition: opacity 0.15s ease, transform 0.15s ease;
}
.sb-parse-btn:hover { opacity: 1; transform: translateY(-1px); }
.sb-parse-btn svg { display: block; }
`;
