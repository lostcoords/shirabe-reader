import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { Window } from "happy-dom";
import type { DictionaryStatus } from "../src/common/offline-dictionary.js";

test("both dictionary panels distinguish pending sync, stored disabled packs and usable dictionaries after errors", async (context) => {
  let receive!: (message: unknown) => void;
  let status: DictionaryStatus;
  Object.assign(globalThis, { chrome: { runtime: { connect: () => ({
    onMessage: { addListener(fn: typeof receive) { receive = fn; } }, onDisconnect: { addListener() {} },
    postMessage(message: { id: number }) { queueMicrotask(() => receive({ id: message.id, response: { ok: true, type: "dictionaryStatus", dictionary: status } })); },
  }) } } });
  const { mountDictionaryPanel } = await import("../src/common/dictionary-panel.js");
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => Response.json({ contentRevision: "base", downloadUrl: "https://packs.test/base.gz" })) as typeof fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  for (const path of ["src/action/popup.html", "src/options/options.html"]) {
    const browser = new Window();
    Object.assign(globalThis, { window: browser, document: browser.document });
    browser.document.body.innerHTML = readFileSync(path, "utf8");
    status = { installed: true, revision: "base.private", publicRevision: "base", activeSources: ["jmdict:en"], stackFingerprint: "",
      builtAt: null, bytes: 100, terms: 1000, kanji: 0, installing: false, progress: 1, stage: null, error: null, storageBytes: null,
      sources: [], availableDictionaries: [{ slug: "personal", name: "Personal glossary", languages: ["eng"] }],
      lastCheckedAt: null, lastSyncedAt: null, retryAt: new Date(Date.now() + 60_000).toISOString(), pendingPacks: ["personal"],
      packs: [{ slug: "jmdict", enabled: true, revision: "base", state: "ready", terms: 1000 },
        { slug: "personal", enabled: false, revision: "old", state: "building", terms: 10 }],
    };
    const panel = mountDictionaryPanel({ apiBase: () => "https://api.test", status() {} });
    await panel.refresh();
    assert.match(browser.document.getElementById("dictionarySyncSummary")!.textContent, /export.*automatically/i, path);
    assert.match(browser.document.getElementById("dictionaryPackStatus")!.textContent, /Personal glossary.*building.*previous version/i);
    assert.equal(browser.document.querySelector('[data-dictionary-state="installed"]')!.hasAttribute("hidden"), false);
    status = { ...status, pendingPacks: [], retryAt: null, lastSyncedAt: new Date().toISOString(),
      packs: status.packs.map((pack) => ({ ...pack, state: "ready" })) };
    await panel.refresh();
    assert.match(browser.document.getElementById("dictionaryPackStatus")!.textContent, /Personal glossary.*stored.*disabled/i);
    status = { ...status, preferencesPending: true };
    await panel.refresh();
    assert.match(browser.document.getElementById("dictionarySyncSummary")!.textContent, /choices.*saved here.*waiting to sync/i);
    status = { ...status, error: "Dictionary download failed (503)", retryAt: new Date(Date.now() + 60_000).toISOString(),
      packs: status.packs.map((pack) => pack.slug === "personal" ? { ...pack, state: "error" } : pack) };
    await panel.refresh();
    assert.match(browser.document.getElementById("dictionarySyncSummary")!.textContent, /offline lookup.*available.*automatically/i);
    assert.match(browser.document.getElementById("dictionaryPackStatus")!.textContent, /Personal glossary.*failed.*previous version/i);
    await browser.happyDOM.close();
  }
});
