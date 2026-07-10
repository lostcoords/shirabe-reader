import type { Config } from "./config.js";
import type { Definition, Example, ParsedToken, Sense, WordState } from "./types.js";

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

// ── Raw server shapes (subset of what /v1 returns) ───────────────────────────
// /v1/parse: positioned tokens that point into a deduped vocab pool carrying
// the caller's per-word state. Positions are UTF-16 code units (DOM-native),
// so the content script never re-derives offsets.
type RawParseToken = {
  position: number;
  length: number;
  surface: string;
  lemma?: string;
  reading?: string; // katakana
  pos?: string; // short label
  primary?: boolean;
  vocabIndex?: number; // index into `vocabulary`; absent for particles/punctuation
};
type RawVocab = { lemma: string; reading?: string; pos?: string; state: WordState };
type RawParse = { tokens: RawParseToken[]; vocabulary: RawVocab[] };
// Batch parse: one token list per input `texts` entry, over a shared vocab pool.
type RawParseBatch = { tokens: RawParseToken[][]; vocabulary: RawVocab[] };

// The scopes the reader asks for: the full read set plus WRITE_SRS so it can
// mine and grade, not just look up. The user sees and approves these on consent.
const OAUTH_SCOPES = ["READ_DICTIONARY", "READ_PREFERENCES", "READ_ACCOUNT", "READ_SRS", "WRITE_SRS"];

// /v1/search: the server already returns a full word card — headword, reading,
// pitch (with audio), common/JLPT/frequency, and nested entries → senses →
// definitions/tags. The popup mirrors what shirabe.org shows, so we model the
// rich shape here rather than throwing it away.
type RawDefinition = { lang: string; text: string; kind?: string };
type RawTag = { category: string; code: string; label: string };
type RawEntry = {
  dictionary: string; // slug: jmdict / jmnedict / wikipedia / a user upload
  senses: Array<{ definitions: RawDefinition[]; tags: RawTag[] }>;
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

const KANJI = /[一-龯㐀-䶿]/;

export class ShirabeApi {
  constructor(private config: Config) {}

  update(config: Config): void {
    this.config = config;
  }

  // Parse text into ParsedTokens. The server returns UTF-16 positions and a
  // deduped vocab pool with the caller's per-word state, so each token's
  // offsets map straight onto the DOM and its colour is known up front.
  async parse(text: string): Promise<ParsedToken[]> {
    const { tokens, vocabulary } = await this.post<RawParse>("/v1/parse", { text });
    return this.mapTokens(tokens, vocabulary);
  }

  // Parse many texts (e.g. one per node/paragraph) in one request. Returns a
  // token list per input, index-aligned with `texts`, over one shared vocab
  // pool — so the server does the offset work and the client just wraps. An
  // optional signal lets lazy viewport parsing abort a request scrolled away.
  async parseBatch(texts: string[], signal?: AbortSignal): Promise<ParsedToken[][]> {
    const { tokens, vocabulary } = await this.post<RawParseBatch>("/v1/parse", { texts }, { signal });
    return tokens.map((list) => this.mapTokens(list, vocabulary));
  }

  private mapTokens(tokens: RawParseToken[], vocabulary: RawVocab[]): ParsedToken[] {
    return tokens.map((t) => {
      const vocab = t.vocabIndex != null ? vocabulary[t.vocabIndex] : undefined;
      return {
        start: t.position,
        length: t.length,
        surface: t.surface,
        reading: furiganaFor(t.surface, t.reading),
        lemma: t.lemma || t.surface,
        pos: t.pos ?? "",
        content: vocab != null, // only pooled (content) words are interactive
        state: vocab?.state ?? "none",
      };
    });
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
          source: sourceLabel(sense.definitions[0]?.lang, entry.dictionary),
          partsOfSpeech: sense.tags.filter((t) => POS_CATEGORIES.has(t.category)).map((t) => t.label),
          tags: sense.tags.filter((t) => TAG_CATEGORIES.has(t.category)).map((t) => t.label),
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
  // Save a word as a review card, optionally grading it on the spot (rating
  // 1=Again…4=Easy). The server find-or-creates the card by lemma, so this is
  // the one call that both mines a new word and reviews an existing one. Returns
  // the resulting state so the caller can recolour the word in place.
  async save(lemma: string, rating?: 1 | 2 | 3 | 4): Promise<WordState> {
    const { card } = await this.post<{ card: { state: WordState } }>("/v1/srs/saves", { lemma, rating });
    return card.state;
  }

  // Set a word's state directly: "known" parks it as learned, "reviewing"
  // brings it into rotation.
  async setState(lemma: string, state: "known" | "reviewing"): Promise<WordState> {
    const { card } = await this.post<{ card: { state: WordState } }>("/v1/srs/states", { lemma, state });
    return card.state;
  }

  // Connected account's display name + SRS entitlement, for the settings UI.
  // Needs READ_ACCOUNT (the device key has it). `entitled` mirrors the server's
  // srs_entitled? — the popup gates the whole reader on it.
  async me(): Promise<{ name: string; entitled: boolean }> {
    const data = await this.get<{
      user: { displayName?: string; name?: string };
      entitlement?: { srs?: boolean };
    }>("/v1/me");
    return {
      name: data.user.displayName || data.user.name || "",
      entitled: data.entitlement?.srs === true,
    };
  }

  // ── HTTP plumbing ───────────────────────────────────────────────────────
  private async get<T>(path: string): Promise<T> {
    return this.request<T>(path, { method: "GET" });
  }

  private async post<T>(path: string, body: unknown, opts: { auth?: boolean; signal?: AbortSignal } = {}): Promise<T> {
    return this.request<T>(path, { method: "POST", body: JSON.stringify(body), signal: opts.signal }, opts);
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
      throw new ApiError(message, res.status);
    }
    return (await res.json()) as T;
  }
}

// Katakana → hiragana, returning null when no furigana is warranted (kana-only
// surface, or the reading just echoes the surface).
function furiganaFor(surface: string, katakana?: string): string | null {
  if (!katakana || !KANJI.test(surface)) return null;
  const hira = katakana.replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));
  return hira && hira !== surface ? hira : null;
}
