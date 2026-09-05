import { loadConfig, pricingUrl } from "../common/config.js";
import { sendDictionary } from "../common/dictionary-port.js";
import { send } from "../common/messages.js";
import type { StudyDetails } from "../common/types.js";
import type { Rating, WordCardHost } from "shirabe-sdk/word-card";
import type { LookupResult } from "shirabe-sdk/word-card/host.js";
import { applyStudyDetails, captureFor, grade, markKnown, REVIEW_IN_READER, save, setScanOrigin, studyUrlForWord } from "./actions.js";
import { renderCardForm } from "./card-form.js";
import { candidatesFor } from "./word.js";
import { refreshMetrics } from "./metrics-reporter.js";
import { toast } from "./toast.js";
import { reportEvent } from "../common/client-reporter.js";

// PostHog properties are scalars; the card sends numbers too, and a number that
// arrives as a string is a property nobody can average.
const stringify = (detail?: Record<string, string | number | boolean>): Record<string, string> =>
  Object.fromEntries(Object.entries(detail ?? {}).map(([key, value]) => [key, String(value)]));

async function unavailable(query: string, message: string, entry?: string): Promise<LookupResult> {
  const config = await loadConfig();
  const url = new URL(`/en/${entry ? "word" : "search"}/${encodeURIComponent(query)}`, config.apiBase);
  if (entry) url.searchParams.set("entry", entry);
  return { status: "unavailable", message, action: { label: `Search online: ${query}`, url: url.href } };
}

// ── The extension's implementation ───────────────────────────────────────────
// Everything below is what makes this extension a host: a local pack behind a
// worker, an account, and a page underneath with its own metrics and toasts. A
// web host implements the same type with `fetch` and none of this.

export const extensionHost: WordCardHost = {
  async lookup(query, kind) {
    // A raw-text scan IS this engine's word lookup: it is handed the text from
    // the cursor and takes the longest match from it, which is the cutting a
    // host over the API has to ask the server to do first.
    const res = await send({ type: "lookup", query, kind: kind === "kanji" ? "kanji" : "word" });
    if (!res.ok && res.code === "OFFLINE_LOOKUP_UNAVAILABLE") return unavailable(query, res.error);
    if (!res.ok) return { status: "failed", message: res.error };
    // The pack is still arriving. The card is told to wait and told what to say;
    // it is never told that a pack is the reason.
    if (res.type === "lookup" && res.dictionaryInstalling) {
      return { status: "pending", message: "Preparing the offline dictionary…" };
    }
    return { status: "found", definition: res.definition };
  },

  async lookupEntry(entry, surface) {
    const res = await send({ type: "lookupEntry", entry, surface });
    if (!res.ok && res.code === "OFFLINE_LOOKUP_UNAVAILABLE") return unavailable(surface, res.error, entry);
    return res.ok ? { status: "found", definition: res.definition } : { status: "failed", message: res.error };
  },

  study: {
    // The worker keeps two caches: a state per lemma, and details only for the
    // words that have a card. The card wants one answer per word, so a lemma we
    // know a state for but hold no card details on becomes a detail that says
    // exactly that.
    async states(lemmas) {
      const res = await send({ type: "states", lemmas });
      if (!res.ok) return null;
      const merged: Record<string, StudyDetails> = { ...res.details };
      for (const [lemma, state] of Object.entries(res.states)) {
        merged[lemma] ??= { state, decks: [] };
      }
      return merged;
    },
    urlForWord: (word) => studyUrlForWord(word),
    apply: (word, details) => applyStudyDetails(word, details),
    save: (word, senseRefs) => save(word, senseRefs),
    markKnown: (word) => markKnown(word),
    grade: (word, rating: Rating) => grade(word, rating),
    // Reviewing lives on the site for this extension, so the card draws no
    // grade row however capable the port looks (see REVIEW_IN_READER).
    gradingInCard: REVIEW_IN_READER,

    // The screenshot, the decks and the account are all extension business, so
    // the whole form is built here and handed the card's own container.
    async renderSaveForm(container, word, definition, done) {
      // The card only opens this from a rendered definition, and the form has
      // nothing to fill in without one.
      if (!definition) return done.onCancel();
      const capture = await captureFor(word);
      const config = await loadConfig();
      await renderCardForm(container, {
        word, definition, capture,
        preferredDeckId: config.preferredDeckId ?? undefined,
        onCancel: done.onCancel,
        onSaved: done.onSaved,
      });
    },
  },

  audio: {
    async clip(url) {
      const res = await send({ type: "audioClip", url });
      if (res.ok) return { dataUrl: res.dataUrl };
      // A 404 means this word has no processed clip yet (or the installed pack
      // is stale); anything else is a real fetch failure.
      const missing = res.status === 404 || res.status === 403;
      return { error: missing ? "No pronunciation audio for this word yet." : "Couldn't load pronunciation audio." };
    },
  },

  // One install for the whole page, however many cards ask: the promise is
  // shared, the progress is reported to whichever card is asking now.
  async resolvePending(onProgress) {
    await installOnce();
    while (true) {
      await new Promise((resolve) => window.setTimeout(resolve, 1_000));
      const response = await sendDictionary({ type: "dictionaryStatus" });
      if (!response.ok) return;
      if (response.dictionary.error) throw new Error(response.dictionary.error);
      if (response.dictionary.installed) return;
      const progress = response.dictionary.progress > 0 ? ` · ${Math.round(response.dictionary.progress * 100)}%` : "";
      onProgress(`${response.dictionary.stage ?? "Preparing the offline dictionary"}${progress}`);
    }
  },

  candidatesFor: (word) => candidatesFor(word),
  rememberOrigin: (word, origin) => setScanOrigin(word, origin),
  // The card's own events, into the same stream as everything else this
  // extension reports. The card never posts anywhere itself: it is a library,
  // and the host decides where its events go.
  report: (event, detail) => reportEvent(event, stringify(detail)),
  notify: (message, ok) => toast(message, ok),
  onStudyChanged: () => void refreshMetrics(),
  async pricingUrl(source) {
    const config = await loadConfig();
    return pricingUrl(config.apiBase, source);
  },
};

let installPromise: Promise<void> | null = null;
function installOnce(): Promise<void> {
  if (installPromise) return installPromise;
  installPromise = sendDictionary({ type: "installDictionary" })
    .then((response) => {
      if (!response.ok) throw new Error(response.error);
    })
    .finally(() => {
      installPromise = null;
    });
  return installPromise;
}
