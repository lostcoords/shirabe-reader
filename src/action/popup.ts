import { ext } from "../common/browser.js";
import { loadConfig, saveConfig, type Config, type PopupTrigger } from "../common/config.js";
import { send } from "../common/messages.js";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

// ── Preferences (auto-saved on change) ───────────────────────────────────────
const prefs = {
  locale: $<HTMLSelectElement>("locale"),
  showFurigana: $<HTMLInputElement>("showFurigana"),
  autoParse: $<HTMLInputElement>("autoParse"),
};
const advanced = {
  apiBase: $<HTMLInputElement>("apiBase"),
  apiKey: $<HTMLInputElement>("apiKey"),
};

let config: Config;

loadConfig().then((c) => {
  config = c;
  prefs.locale.value = c.locale;
  prefs.showFurigana.checked = c.showFurigana;
  prefs.autoParse.checked = c.autoParse;
  trigger(c.popupTrigger).checked = true;
  advanced.apiBase.value = c.apiBase;
  advanced.apiKey.value = c.apiKey;
});

const trigger = (value: PopupTrigger) =>
  document.querySelector<HTMLInputElement>(`input[name="popupTrigger"][value="${value}"]`) as HTMLInputElement;

async function patch(change: Partial<Config>): Promise<void> {
  config = { ...config, ...change };
  await saveConfig(config);
}

$<HTMLFormElement>("prefs").addEventListener("change", () => {
  patch({
    locale: prefs.locale.value,
    showFurigana: prefs.showFurigana.checked,
    autoParse: prefs.autoParse.checked,
    popupTrigger: (document.querySelector<HTMLInputElement>('input[name="popupTrigger"]:checked')?.value ?? "hover") as PopupTrigger,
  });
});

// Advanced: manual key + server. A pasted key's scopes are unknown, so assume
// the full set (the server still enforces) — that keeps the mining buttons live.
$<HTMLFormElement>("advancedForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const apiKey = advanced.apiKey.value.trim();
  await patch({
    apiBase: advanced.apiBase.value.trim() || "https://api.shirabe.org",
    apiKey,
    scopes: apiKey ? ["READ_DICTIONARY", "READ_PREFERENCES", "READ_ACCOUNT", "READ_SRS", "WRITE_SRS"] : [],
    account: apiKey ? config.account : "",
  });
  status("Saved");
  refresh();
});

// ── Connection card ──────────────────────────────────────────────────────────
const card = $<HTMLElement>("account");
const pane = (state: string) => card.querySelector<HTMLElement>(`[data-state="${state}"]`) as HTMLElement;

function showPane(state: "connected" | "connecting" | "disconnected"): void {
  card.hidden = false;
  for (const s of ["connected", "connecting", "disconnected"] as const) pane(s).hidden = s !== state;
}

async function refresh(): Promise<void> {
  const res = await send({ type: "status" });
  if (!res.ok) return;
  const { connected, account, connecting } = res.status;
  if (connected) {
    showPane("connected");
    $<HTMLElement>("accountName").textContent = account ? ` as ${account}` : "";
  } else if (connecting) {
    showPane("connecting");
  } else {
    showPane("disconnected");
  }
}

$<HTMLButtonElement>("connect").addEventListener("click", async () => {
  const res = await send({ type: "connect" });
  if (!res.ok) return status(res.error);
  $<HTMLElement>("userCode").textContent = res.auth.userCode;
  $<HTMLAnchorElement>("verifyLink").href = res.auth.verificationUriComplete;
  showPane("connecting");
  poll();
});

$<HTMLButtonElement>("disconnect").addEventListener("click", async () => {
  await send({ type: "disconnect" });
  refresh();
});

// While a handshake is in flight, watch for approval so the card flips itself.
let timer: number | undefined;
function poll(): void {
  window.clearInterval(timer);
  timer = window.setInterval(async () => {
    const res = await send({ type: "status" });
    if (res.ok && (res.status.connected || !res.status.connecting)) {
      window.clearInterval(timer);
      refresh();
    }
  }, 2000);
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
