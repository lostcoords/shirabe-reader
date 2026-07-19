import { parse } from "../parser.js";

export type DynamicIntegration = "netflix" | "ttsu" | "mokuro";
type ParseTarget = (root: HTMLElement, showFurigana: boolean) => Promise<number>;

const SELECTORS: Record<DynamicIntegration, string> = {
  netflix: ".player-timedtext-text-container",
  ttsu: ".book-content-container",
  mokuro: ".textBox",
};

const LABELS: Record<DynamicIntegration, string> = {
  netflix: "netflix_captions",
  ttsu: "ttsu_reader",
  mokuro: "mokuro_ocr",
};

const started = new Set<DynamicIntegration>();

export function startDynamicReader(integration: DynamicIntegration, showFurigana: boolean): void {
  if (started.has(integration)) return;
  started.add(integration);
  let timer: number | undefined;
  const scan = () => void parseDynamicTargets(document, integration, showFurigana);
  const observer = new MutationObserver(() => {
    window.clearTimeout(timer);
    timer = window.setTimeout(scan, 60);
  });
  observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
  scan();
}

// Exported with an injectable parser so maintained site fixtures can prove the
// selector and context contract without loading a third-party application.
//
// Netflix keeps the structure-preserving page parser: timed-text containers
// often hold several absolutely positioned line spans, and an atomic
// replaceChildren (YouTube-style) would wipe that layout. YouTube/asbplayer
// use parseCaptionElement because each target is a single styled cue.
export async function parseDynamicTargets(
  root: Document | Element,
  integration: DynamicIntegration,
  showFurigana: boolean,
  parseTarget: ParseTarget = parse,
): Promise<number> {
  const targets = [...root.querySelectorAll<HTMLElement>(SELECTORS[integration])];
  let parsed = 0;
  for (const target of targets) {
    if (!target.textContent?.trim()) continue;
    target.dataset.integration = LABELS[integration];
    const video = document.querySelector("video");
    if (video && integration === "netflix") target.dataset.mediaTimestamp = String(Math.round(video.currentTime * 1000));
    parsed += await parseTarget(target, showFurigana);
  }
  return parsed;
}
