import { sendDictionary } from "./dictionary-port.js";

// The install/update/progress/diagnostics card, mounted by BOTH the toolbar
// popup and the options page. It used to be copy-pasted into each: ~180 lines
// twice, which is how the two drifted (only one of them read the failure
// `detail` the background sends). The markup stays in each page; this owns the
// behaviour, and the surfaces differ only through the hooks below.
//
// Element ids are the contract: both pages carry the same ones, and the panes
// are `[data-dictionary-state]` children of `#dictionary`.

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const DICTIONARY_STATES = ["missing", "installing", "installed", "error"] as const;
type DictionaryState = (typeof DICTIONARY_STATES)[number];

export type DictionaryPanel = { refresh: () => Promise<void> };

export type DictionaryPanelHooks = {
  /** Where the pack manifest lives: read fresh each time, so a changed API base is picked up. */
  apiBase: () => string;
  /** The surface's own status line. */
  status: (message: string) => void;
  /** Optional busy indicator (the toolbar popup shows a dot while installing). */
  onBusy?: (busy: boolean) => void;
  /** Optional post-install refresh: the popup re-renders its page panel. */
  onInstalled?: () => void | Promise<void>;
  onRemoved?: () => void | Promise<void>;
};

export function mountDictionaryPanel(hooks: DictionaryPanelHooks): DictionaryPanel {
  const card = $<HTMLElement>("dictionary");
  const pane = (state: string) => card.querySelector<HTMLElement>(`[data-dictionary-state="${state}"]`) as HTMLElement;
  let poll: number | undefined;

  function show(state: DictionaryState): void {
    for (const name of DICTIONARY_STATES) pane(name).hidden = name !== state;
    hooks.onBusy?.(state === "installing");
  }

  async function refresh(): Promise<void> {
    const res = await sendDictionary({ type: "dictionaryStatus" });
    if (!res.ok) {
      show("error");
      $<HTMLElement>("dictionaryError").textContent = res.error;
      await diagnose(res.detail ?? res.error);
      return;
    }
    const dict = res.dictionary;
    if (dict.installing) {
      show("installing");
      $<HTMLProgressElement>("dictionaryProgress").value = dict.progress;
      $<HTMLElement>("dictionaryProgressLabel").textContent = dict.stage
        ? `${dict.stage}${dict.progress > 0 ? ` · ${Math.round(dict.progress * 100)}%` : ""}`
        : `Installing… ${Math.round(dict.progress * 100)}%`;
      window.clearTimeout(poll);
      poll = window.setTimeout(() => void refresh(), 350);
    } else if (dict.error) {
      show("error");
      $<HTMLElement>("dictionaryError").textContent = dict.error;
      await diagnose(dict.error);
    } else if (dict.installed) {
      show("installed");
      const size = dict.bytes ? `${(dict.bytes / 1024 / 1024).toFixed(1)} MB download` : "installed";
      $<HTMLElement>("dictionaryVersion").textContent =
        `${dict.terms.toLocaleString()} terms · ${dict.kanji.toLocaleString()} kanji · ${size} · ${dict.revision ?? "unknown version"}`;
    } else {
      show("missing");
    }
  }

  async function install({ update = false } = {}): Promise<void> {
    const previousRevision = update ? await installedRevision() : null;
    show("installing");
    $<HTMLProgressElement>("dictionaryProgress").value = 0;
    $<HTMLElement>("dictionaryError").textContent = "";
    $<HTMLElement>("dictionaryDiagnostics").textContent = "";
    const preflight = await checkReachable();
    if (!preflight.ok) {
      show("error");
      $<HTMLElement>("dictionaryError").textContent = "Dictionary preflight failed";
      $<HTMLElement>("dictionaryDiagnostics").textContent = preflight.diagnostics;
      return;
    }

    const res = await sendDictionary({ type: "installDictionary" });
    // Poll from here on: the message resolves long before a full import does,
    // and this also covers reopening the surface mid-install.
    void refresh();
    if (!res.ok) {
      await refresh();
      if (!/abort|cancel/i.test(res.error)) {
        // Firefox can reject the message channel with a generic error after the
        // background installer already recorded the useful failure. Prefer that
        // durable status over overwriting it with the transport message.
        if (!$<HTMLElement>("dictionaryError").textContent) {
          show("error");
          $<HTMLElement>("dictionaryError").textContent = res.error;
        }
        await diagnose(res.detail ?? res.error);
      }
      return;
    }

    // Long installs acknowledge immediately; wait for status to leave "installing".
    await waitForInstall();
    const settled = await sendDictionary({ type: "dictionaryStatus" });
    if (settled.ok && settled.dictionary.error) {
      show("error");
      $<HTMLElement>("dictionaryError").textContent = settled.dictionary.error;
      await diagnose(settled.dictionary.error);
      return;
    }
    const revision = await installedRevision();
    hooks.status(!update ? "Offline dictionary installed"
      : revision === previousRevision ? "Dictionary is already up to date"
      : "Dictionary updated");
    await refresh();
    await hooks.onInstalled?.();
  }

  /** Poll until the background reports the install finished, failed, or cancelled. */
  async function waitForInstall(): Promise<void> {
    for (let attempt = 0; attempt < 1_200; attempt += 1) { // ~10 min at 500ms
      const res = await sendDictionary({ type: "dictionaryStatus" });
      if (!res.ok || !res.dictionary.installing) return;
      await refresh();
      await new Promise((resolve) => window.setTimeout(resolve, 500));
    }
  }

  async function installedRevision(): Promise<string | null> {
    const res = await sendDictionary({ type: "dictionaryStatus" });
    return res.ok ? res.dictionary.revision ?? null : null;
  }

  // Answer "could this browser install at all, and is the pack even there?"
  // before blaming the import: the failures we actually saw were a missing
  // manifest and a browser without DecompressionStream, not a bad download.
  async function checkReachable(): Promise<{ ok: boolean; diagnostics: string }> {
    const apiBase = hooks.apiBase().replace(/\/$/, "");
    const lines = [`api: ${apiBase}`];
    lines.push(`indexedDB: ${typeof indexedDB === "undefined" ? "missing" : "available"}`);
    lines.push(`gzip: ${typeof DecompressionStream === "undefined" ? "missing" : "available"}`);
    try {
      const response = await fetch(`${apiBase}/api/v1/dictionary-packs/current`, { cache: "no-store" });
      lines.push(`manifest: HTTP ${response.status}`);
      if (!response.ok) {
        lines.push(`response: ${(await response.text()).slice(0, 240)}`);
        return { ok: false, diagnostics: lines.join("\n") };
      }
      const manifest = await response.json() as { contentRevision?: unknown; downloadUrl?: unknown };
      lines.push(`revision: ${String(manifest.contentRevision ?? "missing")}`);
      lines.push(`download: ${typeof manifest.downloadUrl === "string" ? new URL(manifest.downloadUrl).host : "missing"}`);
      return { ok: true, diagnostics: lines.join("\n") };
    } catch (error) {
      lines.push(`manifest error: ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`);
      return { ok: false, diagnostics: lines.join("\n") };
    }
  }

  async function diagnose(transportError: string): Promise<void> {
    const preflight = await checkReachable();
    const background = await sendDictionary({ type: "dictionaryStatus" });
    $<HTMLElement>("dictionaryDiagnostics").textContent = [
      preflight.diagnostics,
      background.ok
        ? `background: reachable (${background.dictionary.stage ?? background.dictionary.error ?? "idle"})`
        : `background: ${background.error}`,
      `transport: ${transportError}`,
    ].join("\n");
  }

  $<HTMLButtonElement>("installDictionary").addEventListener("click", () => void install());
  $<HTMLButtonElement>("retryDictionary").addEventListener("click", () => void install());
  $<HTMLButtonElement>("updateDictionary").addEventListener("click", () => void install({ update: true }));
  $<HTMLButtonElement>("removeDictionary").addEventListener("click", async () => {
    const res = await sendDictionary({ type: "removeDictionary" });
    if (!res.ok) hooks.status(res.error);
    await refresh();
    if (res.ok) await hooks.onRemoved?.();
  });
  $<HTMLButtonElement>("cancelDictionaryInstall").addEventListener("click", async () => {
    await sendDictionary({ type: "cancelDictionaryInstall" });
    hooks.status("Installation cancelled; the previous dictionary is still active");
    await refresh();
  });

  return { refresh };
}
