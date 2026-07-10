import { ext } from "../common/browser.js";
import { DEFAULTS, loadConfig, saveConfig, type Config, type ScanModifier } from "../common/config.js";
import { loadHostRules, matchUrl, normalizePattern, parseHostList, resolveHostMode, siteScopeFor, type HostRule } from "../common/host-rules.js";
import { formatKeybind, KEYBIND_ACTIONS, KEYBIND_LABELS, keybindFromEvent, type Keybind, type KeybindAction } from "../common/keybind.js";
import { send } from "../common/messages.js";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

// ── Preferences (auto-saved on change) ───────────────────────────────────────
const prefs = {
  showFurigana: $<HTMLInputElement>("showFurigana"),
  showParseButton: $<HTMLInputElement>("showParseButton"),
  scanModifier: $<HTMLSelectElement>("scanModifier"),
};
const advanced = {
  apiBase: $<HTMLInputElement>("apiBase"),
  apiKey: $<HTMLInputElement>("apiKey"),
  autoParseHosts: $<HTMLTextAreaElement>("autoParseHosts"),
  disabledHosts: $<HTMLTextAreaElement>("disabledHosts"),
};

let config: Config;
let rules: HostRule[] = [];
let siteUrl = ""; // the active tab's URL, for per-site controls

Promise.all([loadConfig(), loadHostRules(), activeTabUrl()]).then(([c, r, url]) => {
  config = c;
  rules = r;
  siteUrl = url;
  prefs.showFurigana.checked = c.showFurigana;
  prefs.showParseButton.checked = c.showParseButton;
  prefs.scanModifier.value = c.scanModifier;
  advanced.apiBase.value = c.apiBase;
  advanced.apiKey.value = c.apiKey;
  $<HTMLAnchorElement>("settingsLink").href = c.apiBase.replace(/\/$/, "") + "/settings";
  renderHostControls();
  renderKeybinds();
});

async function activeTabUrl(): Promise<string> {
  const [tab] = await ext.tabs.query({ active: true, currentWindow: true });
  return tab?.url ?? "";
}

async function patch(change: Partial<Config>): Promise<void> {
  config = { ...config, ...change };
  await saveConfig(config);
}

$<HTMLFormElement>("prefs").addEventListener("change", () => {
  patch({
    showFurigana: prefs.showFurigana.checked,
    showParseButton: prefs.showParseButton.checked,
    scanModifier: prefs.scanModifier.value as ScanModifier,
  });
});

// ── Per-site parsing mode ────────────────────────────────────────────────────
// The select reflects the current page's effective mode; changing it edits the
// user's auto/off host lists for this domain. (A built-in auto site can't be
// forced back to Manual — only turned Off — which is fine for our reader sites.)
const siteRow = $<HTMLElement>("siteRow");
const siteMode = $<HTMLSelectElement>("siteMode");

function renderHostControls(): void {
  advanced.autoParseHosts.value = config.autoParseHosts.join("\n");
  advanced.disabledHosts.value = config.disabledHosts.join("\n");

  const scope = siteScopeFor(siteUrl);
  if (!scope || !/^https?:/.test(siteUrl)) {
    siteRow.hidden = true;
    return;
  }
  siteRow.hidden = false;
  $<HTMLElement>("siteHost").textContent = new URL(siteUrl).hostname;
  siteMode.value = resolveHostMode(siteUrl, {
    autoHosts: config.autoParseHosts,
    disabledHosts: config.disabledHosts,
    rules,
  }).mode;
}

siteMode.addEventListener("change", async () => {
  // Drop any user pattern that currently applies to this page, then add the
  // scope to the chosen list (Manual = in neither list).
  const scope = siteScopeFor(siteUrl);
  const autoHosts = config.autoParseHosts.filter((p) => !matchUrl(normalizePattern(p), siteUrl));
  const disabledHosts = config.disabledHosts.filter((p) => !matchUrl(normalizePattern(p), siteUrl));
  if (siteMode.value === "auto") autoHosts.push(scope);
  else if (siteMode.value === "off") disabledHosts.push(scope);
  await patch({ autoParseHosts: autoHosts, disabledHosts });
  renderHostControls();
});

// ── Keyboard shortcuts ───────────────────────────────────────────────────────
let capturing: KeybindAction | null = null;

function renderKeybinds(): void {
  const container = $<HTMLElement>("keybinds");
  container.replaceChildren();
  for (const action of KEYBIND_ACTIONS) {
    const row = document.createElement("div");
    row.className = "kb-row";
    const label = document.createElement("span");
    label.textContent = KEYBIND_LABELS[action];
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "kb-btn";
    if (capturing === action) btn.classList.add("capturing");
    btn.textContent = capturing === action ? "Press keys…" : formatKeybind(config.keybinds[action]);
    btn.addEventListener("click", () => {
      capturing = capturing === action ? null : action;
      renderKeybinds();
    });
    row.append(label, btn);
    container.append(row);
  }
}

window.addEventListener("keydown", (e) => {
  if (!capturing) return;
  e.preventDefault();
  e.stopPropagation();
  const action = capturing;
  if (e.key === "Escape") {
    capturing = null;
    renderKeybinds();
    return;
  }
  const bind: Keybind = e.key === "Backspace" || e.key === "Delete" ? null : keybindFromEvent(e);
  if (bind === null && e.key !== "Backspace" && e.key !== "Delete") return; // modifier-only, keep waiting
  capturing = null;
  patch({ keybinds: { ...config.keybinds, [action]: bind } }).then(renderKeybinds);
});

// ── Connection card ──────────────────────────────────────────────────────────
const card = $<HTMLElement>("account");
const reader = $<HTMLElement>("reader");
const advancedPanel = $<HTMLDetailsElement>("advanced");
const pane = (state: string) => card.querySelector<HTMLElement>(`[data-state="${state}"]`) as HTMLElement;

const STATES = ["connected", "connecting", "unentitled", "disconnected"] as const;
type Pane = (typeof STATES)[number];

function showPane(state: Pane): void {
  card.hidden = false;
  for (const s of STATES) pane(s).hidden = s !== state;
  // A logged-out popup is just the brand + the Connect button. The reader (parse
  // + prefs) needs sign-in AND a subscription; Advanced (server + manual key) is
  // a signed-in affordance, so both stay hidden until there's a session.
  const signedIn = state === "connected" || state === "unentitled";
  reader.hidden = state !== "connected";
  advancedPanel.hidden = !signedIn;
}

async function refresh(): Promise<void> {
  const res = await send({ type: "status" });
  if (!res.ok) return;
  const { connected, account, entitled, connecting, apiBase } = res.status;
  const named = account ? ` as ${account}` : "";
  if (connected && entitled) {
    showPane("connected");
    $<HTMLElement>("accountName").textContent = named;
  } else if (connected) {
    showPane("unentitled");
    $<HTMLElement>("unentitledName").textContent = named;
    $<HTMLAnchorElement>("upgradeLink").href = apiBase.replace(/\/$/, "") + "/pricing";
  } else if (connecting) {
    showPane("connecting");
  } else {
    showPane("disconnected");
  }
}

// Advanced: manual key + server + host lists. A pasted key's scopes are unknown,
// so assume the full set (the server still enforces) — that keeps mining live.
$<HTMLFormElement>("advancedForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const apiKey = advanced.apiKey.value.trim();
  await patch({
    apiBase: advanced.apiBase.value.trim() || DEFAULTS.apiBase,
    apiKey,
    scopes: apiKey ? ["READ_DICTIONARY", "READ_PREFERENCES", "READ_ACCOUNT", "READ_SRS", "WRITE_SRS"] : [],
    account: apiKey ? config.account : "",
    autoParseHosts: parseHostList(advanced.autoParseHosts.value),
    disabledHosts: parseHostList(advanced.disabledHosts.value),
  });
  renderHostControls();
  status("Saved");
  refresh();
});

$<HTMLButtonElement>("connect").addEventListener("click", async () => {
  showPane("connecting");
  const res = await send({ type: "connect" });
  if (!res.ok) {
    status(res.error);
    showPane("disconnected");
    return;
  }
  refresh();
});

// Both the connected and unentitled panes carry a Disconnect button.
for (const button of document.querySelectorAll<HTMLButtonElement>(".disconnect")) {
  button.addEventListener("click", async () => {
    await send({ type: "disconnect" });
    refresh();
  });
}

refresh();

// ── Parse this page ──────────────────────────────────────────────────────────
$<HTMLButtonElement>("parse").addEventListener("click", async () => {
  const [tab] = await ext.tabs.query({ active: true, currentWindow: true });
  if (tab?.id == null) return;
  await ext.tabs.sendMessage(tab.id, { command: "parsePage" });
  window.close();
});

function status(text: string): void {
  const el = $<HTMLParagraphElement>("status");
  el.textContent = text;
  window.setTimeout(() => (el.textContent = ""), 2500);
}
