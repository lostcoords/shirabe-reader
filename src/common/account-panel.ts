import { pricingUrl, type Config } from "./config.js";
import { send } from "./messages.js";

// The account card — connect, disconnect, entitlement, and the deck a save goes
// to. Mounted by BOTH the toolbar popup and the options page, which shipped the
// same code twice; the only real difference is which funnel source the upgrade
// link is tagged with, so that is the parameter.
//
// Element ids and `[data-state]` panes are the contract, the same way the
// dictionary panel works.

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const ACCOUNT_STATES = ["connected", "connecting", "unentitled", "disconnected"] as const;
type AccountState = (typeof ACCOUNT_STATES)[number];

export type AccountPanel = { refresh: () => Promise<void> };

export type AccountPanelHooks = {
  /** The card element's id — `account` in the popup, `accountPanel` in options. */
  cardId: string;
  /** Funnel tag for the upgrade link: an untagged /pricing reads as organic traffic. */
  pricingSource: string;
  /** The surface's config, read fresh (the deck select mirrors `preferredDeckId`). */
  config: () => Config | undefined;
  /** Persist a config change the surface owns. */
  patch: (change: Partial<Config>) => Promise<void>;
  /** Surface's status line, for a failed connect. */
  status: (message: string) => void;
  /** Called when connecting/disconnecting settles, so the surface can re-render. */
  onChanged?: () => void | Promise<void>;
};

export function mountAccountPanel(hooks: AccountPanelHooks): AccountPanel {
  const card = $<HTMLElement>(hooks.cardId);
  const pane = (state: string) => card.querySelector<HTMLElement>(`[data-state="${state}"]`) as HTMLElement;

  function show(state: AccountState): void {
    card.hidden = false;
    for (const name of ACCOUNT_STATES) pane(name).hidden = name !== state;
  }

  async function refresh(): Promise<void> {
    const res = await send({ type: "status" });
    if (!res.ok) return;
    const { connected, account, entitled, connecting, apiBase } = res.status;
    const named = account ? ` as ${account}` : "";
    if (connected && entitled) {
      show("connected");
      $<HTMLElement>("accountName").textContent = named;
      void refreshDecks();
    } else if (connected) {
      show("unentitled");
      $<HTMLElement>("unentitledName").textContent = named;
      $<HTMLAnchorElement>("upgradeLink").href = pricingUrl(apiBase, hooks.pricingSource);
    } else if (connecting) {
      show("connecting");
    } else {
      show("disconnected");
    }
  }

  // The deck a save lands in. A preferred deck that no longer exists silently
  // falls back to Saved words rather than saving into nothing.
  async function refreshDecks(): Promise<void> {
    const select = $<HTMLSelectElement>("preferredDeck");
    const res = await send({ type: "decks" });
    if (!res.ok) {
      $<HTMLElement>("deckRow").hidden = true;
      return;
    }
    $<HTMLElement>("deckRow").hidden = false;
    select.replaceChildren(new Option("Saved words (default)", ""));
    for (const deck of res.decks) select.add(new Option(deck.name, String(deck.id)));
    const preferred = hooks.config()?.preferredDeckId;
    select.value = preferred == null ? "" : String(preferred);
    if (select.value === "" && preferred != null) await hooks.patch({ preferredDeckId: null });
  }

  $<HTMLSelectElement>("preferredDeck").addEventListener("change", (event) => {
    const value = (event.currentTarget as HTMLSelectElement).value;
    void hooks.patch({ preferredDeckId: value ? Number(value) : null });
  });

  $<HTMLButtonElement>("connect").addEventListener("click", async () => {
    show("connecting");
    const res = await send({ type: "connect" });
    if (!res.ok) {
      hooks.status(res.error);
      show("disconnected");
      return;
    }
    await refresh();
    await hooks.onChanged?.();
  });

  // Both the connected and unentitled panes carry a Disconnect button.
  for (const button of card.querySelectorAll<HTMLButtonElement>(".disconnect")) {
    button.addEventListener("click", async () => {
      await send({ type: "disconnect" });
      await refresh();
      await hooks.onChanged?.();
    });
  }

  return { refresh };
}
