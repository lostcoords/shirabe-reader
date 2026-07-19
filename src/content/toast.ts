// A fleeting bottom-centre toast for keyboard-driven actions, where there's no
// open popup to show inline feedback. Self-styled in a shadow root so the host
// page can't touch it.
let host: HTMLElement | null = null;
let box: HTMLElement | null = null;
let timer: number | undefined;

const CSS = `
.t {
  position: fixed;
  left: 50%;
  bottom: 28px;
  transform: translateX(-50%) translateY(8px);
  padding: 9px 16px;
  border-radius: 10px;
  background: #111827;
  color: #fff;
  font: 600 13px/1.4 system-ui, sans-serif;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.28);
  opacity: 0;
  transition: opacity 0.14s ease, transform 0.14s ease;
  pointer-events: none;
}
.t.show { opacity: 1; transform: translateX(-50%) translateY(0); }
.t.err { background: #b91c1c; }
`;

export function toast(message: string, ok = true): void {
  if (!box) {
    host = document.createElement("div");
    host.className = "sb-toast"; // so screenshot capture can hide chrome uniformly
    const root = host.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = CSS;
    box = document.createElement("div");
    box.className = "t";
    root.append(style, box);
    document.body.append(host);
  }
  box.classList.toggle("err", !ok);
  box.textContent = message;
  // reflow so the transition replays on rapid repeats
  void box.offsetWidth;
  box.classList.add("show");
  window.clearTimeout(timer);
  timer = window.setTimeout(() => box?.classList.remove("show"), 1600);
}
