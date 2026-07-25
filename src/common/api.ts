import type { Config } from "./config.js";
import { posLabel, tagLabel } from "./jmdict-tags.js";
import { glossLanguagesFrom, uiLanguagesFrom, type GlossLanguage } from "./languages.js";
import type { Definition, Example, Sense, WordState } from "./types.js";
import type { Deck, GradeResult, IntervalPreviews, SaveResult, SentenceCapture, StudyDetails } from "./messages.js";

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    // The server's problem+json `code` (PRO_REQUIRED, INSUFFICIENT_SCOPE, …).
    // Kept because some codes are *states*, not faults: PRO_REQUIRED is the
    // answer to "can this account save?", and the UI offers plans rather than
    // reporting a failure. Matching on a code beats matching on prose.
    readonly code?: string,
  ) {
    super(message);
  }
}

// ── Raw server shapes (subset of what /v1 returns) ───────────────────────────

// Dictionary lookup is public and local, so connecting must never ask for it.
// OAuth exists only for the personal online layer: identify the account, read
// its study state, and save/grade through the SRS.
const OAUTH_SCOPES = ["READ_ACCOUNT", "WRITE_ACCOUNT", "READ_SRS", "WRITE_SRS"];

// /v1/search: the server already returns a full word card — headword, reading,
// pitch (with audio), common/JLPT/frequency, and nested entries → senses →
// definitions/tags. The popup mirrors what shirabe.org shows, so we model the
// rich shape here rather than throwing it away.
type RawDefinition = { lang: string; text: string; kind?: string };
type RawTag = { category: string; code: string; label: string };
type RawEntry = {
  dictionary: string; // slug: jmdict / jmnedict / wikipedia / a user upload
  senses: Array<{ position: number; definitions: RawDefinition[]; tags: RawTag[] }>;
};
type RawPitch = { downstep: number; pattern: string; audioUrl: string | null };
type RawSentenceToken = { surface: string; lemma: string; content: boolean; matched: boolean };
type RawSentence = { japanese: string; translations: Array<{ lang: string; text: string }>; tokens?: RawSentenceToken[] };
type RawResult = {
  headword: string;
  reading: string | null;
  common: boolean;
  jlpt: string | null;
  frequency: number | null;
  pitch?: RawPitch[];
  entries: RawEntry[];
  sentences?: RawSentence[]; // only with include=sentences
};
type RawSearch = { results: RawResult[] };

// One word, as every word-level endpoint reports it (/v1 `WordStateEntry`): the
// batch lookup, setting a state, and saving all answer in this shape, so the
// reader reads a word the same way whatever changed it.
type WordStateEntry = {
  lemma: string;
  state: WordState;
  decks: Array<{ id: number; name: string }>;
  cardId?: number;
  cardCount?: number;
  savedSensePositions?: number[];
  savedWholeWord?: boolean;
  intervals?: IntervalPreviews;
};

const studyDetails = (word: WordStateEntry): StudyDetails => ({
  state: word.state,
  decks: word.decks,
  ...(word.cardId != null ? { cardId: word.cardId } : {}),
  ...(word.cardCount != null ? { cardCount: word.cardCount } : {}),
  ...(word.savedSensePositions ? { savedSensePositions: word.savedSensePositions } : {}),
  ...(word.savedWholeWord ? { savedWholeWord: word.savedWholeWord } : {}),
  ...(word.intervals ? { intervals: word.intervals } : {}),
});

// Gloss language + dictionary display names for a sense's source label, echoing
// the web ("Español · JMdict"). Unknown codes/slugs fall back to a title-cased
// form so user-uploaded dictionaries still read sensibly.
const LANG_NAMES: Record<string, string> = {
  ja: "日本語", en: "English", es: "Español", fr: "Français", de: "Deutsch",
  nl: "Nederlands", ru: "Русский", sv: "Svenska", hu: "Magyar", sl: "Slovenščina",
};
const DICT_NAMES: Record<string, string> = { jmdict: "JMdict", jmnedict: "Names", wikipedia: "Wikipedia" };
const POS_CATEGORIES = new Set(["partOfSpeech", "nameType"]);
const TAG_CATEGORIES = new Set(["misc", "field", "dialect"]);

function sourceLabel(lang: string | undefined, dict: string): string {
  const dictName = DICT_NAMES[dict] ?? dict.charAt(0).toUpperCase() + dict.slice(1);
  const langName = lang ? (LANG_NAMES[lang] ?? lang.toUpperCase()) : "";
  return langName ? `${langName} · ${dictName}` : dictName;
}


export class ShirabeApi {
  constructor(private config: Config) {}

  update(config: Config): void {
    this.config = config;
  }

  // Hover-popup definition — a faithful slice of the shirabe.org word card. We
  // don't send a locale: the server applies the key owner's saved language +
  // dictionary preferences, so the extension never second-guesses them. Asks for
  // example sentences too, and maps the first result into our display shape.
  async lookup(query: string): Promise<Definition | null> {
    const data = await this.post<RawSearch>("/v1/search", { query, take: 1, include: ["sentences"] });
    const result = data.results[0];
    return result ? this.toDefinition(result) : null;
  }

  private toDefinition(result: RawResult): Definition {
    const wordBase = `${this.config.apiBase.replace(/\/$/, "")}/word/`;
    const senses: Sense[] = [];
    for (const entry of result.entries) {
      for (const sense of entry.senses) {
        const glosses = sense.definitions.filter((d) => d.kind !== "abstract").map((d) => d.text).filter(Boolean);
        if (!glosses.length) continue; // Wikipedia abstracts etc. live on the full page
        senses.push({
          position: sense.position,
          source: sourceLabel(sense.definitions[0]?.lang, entry.dictionary),
          // Prefer the stable code through posLabel so chips match the site
          // ("Godan verb") rather than the verbose JMdict entity string.
          partsOfSpeech: sense.tags
            .filter((t) => POS_CATEGORIES.has(t.category))
            .map((t) => posLabel(t.code, t.label)),
          tags: sense.tags
            .filter((t) => TAG_CATEGORIES.has(t.category))
            .map((t) => tagLabel(t.code, t.label)),
          glosses,
        });
      }
    }

    const examples: Example[] = (result.sentences ?? []).slice(0, 3).map((s) => ({
      japanese: s.japanese,
      translation: s.translations[0]?.text ?? null,
      tokens: (s.tokens ?? []).map((t) => ({
        surface: t.surface,
        url: t.content ? wordBase + encodeURIComponent(t.lemma) : null,
        matched: t.matched,
      })),
    }));

    return {
      headword: result.headword,
      reading: result.reading,
      url: `${wordBase}${encodeURIComponent(result.headword)}`,
      common: result.common,
      jlpt: result.jlpt,
      frequency: result.frequency,
      pitch: (result.pitch ?? []).map((p) => ({ downstep: p.downstep, audioUrl: p.audioUrl })),
      senses,
      examples,
    };
  }

  // ── Redirect login (OAuth 2.0 authorization code + PKCE) ────────────────────
  // The consent URL the extension opens with `identity.launchWebAuthFlow`. The
  // user approves the scopes there and the browser redirects a one-time code
  // back to `redirectUri`.
  authorizeUrl(opts: { redirectUri: string; state: string; challenge: string; client: string }): string {
    const query = new URLSearchParams({
      response_type: "code",
      client: opts.client,
      redirect_uri: opts.redirectUri,
      scope: OAUTH_SCOPES.join(" "),
      state: opts.state,
      code_challenge: opts.challenge,
      code_challenge_method: "S256",
    });
    return `${this.config.apiBase.replace(/\/$/, "")}/oauth/authorize?${query}`;
  }

  // Exchange the one-time code (+ PKCE verifier) for a scoped key. No key yet —
  // the code and verifier are the proof.
  async exchangeCode(opts: { code: string; verifier: string; redirectUri: string }): Promise<{ apiKey: string; scopes: string[] }> {
    return this.post(
      "/v1/oauth/token",
      { grant_type: "authorization_code", code: opts.code, code_verifier: opts.verifier, redirect_uri: opts.redirectUri },
      { auth: false },
    );
  }

  // ── SRS write-back (/v1/srs/*, requires a WRITE_SRS key) ────────────────────
  // Save (or mine) a word as a review card. `sensePositions` scopes the card to a
  // subset of the word's senses (empty/omitted = the whole word). Grading is a
  // separate call — see `grade`.
  async save(options: { lemma: string; surface?: string; reading?: string; deckId?: number; sentence?: SentenceCapture; sensePositions?: number[]; imageDataUrl?: string; audioDataUrl?: string }): Promise<SaveResult> {
    const response = await this.post<{ card: { id: number }; created: boolean; word: WordStateEntry }>("/v1/srs/saves", options);
    // The card that was written identifies itself; everything else about the word
    // — its state, decks, how many cards it now holds — comes from `word`, the
    // same block a lookup returns.
    return {
      ...studyDetails(response.word),
      created: response.created,
      ...(response.card?.id != null ? { cardId: response.card.id } : {}),
    };
  }

  // Grade a due card by lemma (+reading). POST /v1/srs/reviews rejects a word
  // that isn't currently due, so this can't create early or duplicate reviews.
  async grade(options: { lemma: string; reading?: string; rating: 1 | 2 | 3 | 4 }): Promise<GradeResult> {
    const response = await this.post<{ card: { id: number; state: WordState }; intervals: IntervalPreviews }>("/v1/srs/reviews", options);
    const cardId = response.card?.id;
    return {
      state: response.card.state,
      intervals: response.intervals,
      ...(cardId != null ? { cardId } : {}),
    };
  }

  async decks(): Promise<Deck[]> {
    const { decks } = await this.get<{ decks: Deck[] }>("/v1/srs/decks");
    return decks;
  }

  async states(lemmas: string[]): Promise<{ states: Record<string, WordState>; details: Record<string, StudyDetails> }> {
    const { states } = await this.post<{ states: WordStateEntry[] }>("/v1/srs/states/lookup", { words: lemmas });
    return {
      states: Object.fromEntries(states.map((item) => [item.lemma, item.state])),
      details: Object.fromEntries(states.map((item) => [item.lemma, studyDetails(item)])),
    };
  }

  // Set a word's state directly: "known" parks it as learned, "reviewing" brings
  // it into rotation. A state is word-level — it lands on every card the word
  // holds — so the answer is the whole word, not one card.
  async setState(lemma: string, state: "known" | "reviewing"): Promise<StudyDetails> {
    const { word } = await this.post<{ word: WordStateEntry }>("/v1/srs/states", { lemma, state });
    return studyDetails(word);
  }

  // Connected account's display name + SRS entitlement, for the settings UI.
  // Needs READ_ACCOUNT (the device key has it). `entitled` mirrors the server's
  // srs_entitled? — the popup gates the whole reader on it.
  //
  // `languages` is the account's ordered gloss languages, in UI codes like
  // ["es","en"]. Server-side it's *derived* from the reader's dictionary stack
  // (Prefs#sources) — the distinct languages of it, in order. We read the
  // derived list rather than the stack because this pack is a single
  // dictionary: dictionary order is a distinction it can't represent.
  // Carrying it keeps the extension's meaning order identical to the website's
  // for the same reader; it is empty for an account that has never customized.
  async me(): Promise<{ name: string; entitled: boolean; languages: GlossLanguage[] }> {
    const data = await this.get<{
      user: { displayName?: string; name?: string };
      entitlement?: { srs?: boolean };
      preferences?: { languages?: string[] };
    }>("/v1/me");
    return {
      name: data.user.displayName || data.user.name || "",
      entitled: data.entitlement?.srs === true,
      languages: glossLanguagesFrom(data.preferences?.languages ?? []),
    };
  }

  // Sending `languages` (rather than the full `dictionaries` stack) asks the
  // server for a projection: it keeps the reader's dictionary order exactly as
  // it is and re-languages each one. So changing languages from here can never
  // scramble an ordering this client can't see.
  async updateLanguages(languages: readonly GlossLanguage[]): Promise<GlossLanguage[]> {
    const data = await this.patch<{ preferences: { languages: string[] } }>(
      "/v1/preferences",
      { languages: uiLanguagesFrom(languages) },
    );
    return glossLanguagesFrom(data.preferences.languages);
  }

  // ── HTTP plumbing ───────────────────────────────────────────────────────
  private async get<T>(path: string): Promise<T> {
    return this.request<T>(path, { method: "GET" });
  }

  private async post<T>(path: string, body: unknown, opts: { auth?: boolean; signal?: AbortSignal } = {}): Promise<T> {
    return this.request<T>(path, { method: "POST", body: JSON.stringify(body), signal: opts.signal }, opts);
  }

  private async patch<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>(path, { method: "PATCH", body: JSON.stringify(body) });
  }

  private async request<T>(path: string, init: RequestInit, opts: { auth?: boolean } = {}): Promise<T> {
    const auth = opts.auth !== false; // device endpoints opt out — they mint the key
    if (auth && !this.config.apiKey) throw new ApiError("Not connected. Open the extension and connect to Shirabe.", 401);

    const res = await fetch(this.config.apiBase.replace(/\/$/, "") + path, {
      ...init,
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        ...(auth ? { Authorization: `Bearer ${this.config.apiKey}` } : {}),
      },
    });

    if (!res.ok) {
      const detail = await res.json().catch(() => null);
      const message = detail?.detail || detail?.title || `Request failed (${res.status})`;
      throw new ApiError(message, res.status, typeof detail?.code === "string" ? detail.code : undefined);
    }
    return (await res.json()) as T;
  }
}

// Katakana → hiragana, returning null when no furigana is warranted (kana-only
// surface, or the reading just echoes the surface).
