import type { Config } from "./config.js";
import { glossLanguagesFrom, uiLanguagesFrom, type GlossLanguage } from "@shirabe-org/card/word-card/languages";
import type { ParsedToken, WordState } from "./types.js";
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

// ── Raw server shapes (subset of what /api/v1 returns) ───────────────────────────

// Dictionary lookup is public and local, so connecting must never ask for it.
// OAuth exists only for the personal online layer: identify the account, read
// its study state, and save/grade through the SRS.
const OAUTH_SCOPES = ["READ_ACCOUNT", "READ_DICTIONARY", "WRITE_ACCOUNT", "READ_SRS", "WRITE_SRS"];
// Registered on the server (OauthClient), where the consent screen's name and
// the redirect hosts we may use are decided. A public client: no secret, PKCE
// binds our codes.
export const OAUTH_CLIENT_ID = "shirabe-extension";
// Renew this long before the access token expires, so a request never goes out
// on a token that dies in flight.
const RENEW_AHEAD_MS = 60_000;

// What a login or a renewal hands us: the pair, and when the first half runs
// out. Persisted by whoever owns Config (the background worker) through
// `onTokens`; the api client keeps its own copy current so the very next
// request goes out on the new token.
export type Tokens = { accessToken: string; accessTokenExpiresAt: string; refreshToken: string; scopes: string[] };

type TokenResponse = { access_token: string; token_type: string; expires_in: number; refresh_token: string; scope: string };

type ParseTokenResponse = {
  position: number;
  length: number;
  surface: string;
  lemma: string;
  reading?: string;
  pos?: string;
  kind?: string;
  entry?: { dictionary: string; sourceId: string };
  state?: WordState;
  frequency?: number | null;
};

// One word, as every word-level endpoint reports it (/api/v1 `WordStateEntry`): the
// batch lookup, setting a state, and saving all answer in this shape, so the
// reader reads a word the same way whatever changed it.
type WordStateEntry = {
  lemma: string;
  state: WordState;
  decks: Array<{ id: number; name: string }>;
  cardId?: number;
  reviewCard?: { id: number; revision: string };
  cardCount?: number;
  savedSenses?: string[];
  savedWholeWord?: boolean;
  intervals?: IntervalPreviews;
};

const studyDetails = (word: WordStateEntry): StudyDetails => ({
  state: word.state,
  decks: word.decks,
  ...(word.cardId != null ? { cardId: word.cardId } : {}),
  ...(word.reviewCard ? { reviewCard: word.reviewCard } : {}),
  ...(word.cardCount != null ? { cardCount: word.cardCount } : {}),
  ...(word.savedSenses ? { savedSenses: word.savedSenses } : {}),
  ...(word.savedWholeWord ? { savedWholeWord: word.savedWholeWord } : {}),
  ...(word.intervals ? { intervals: word.intervals } : {}),
});

// The pack cites an entry as one handle ("jmdict:2517580"); /api/v1 takes it as the
// (dictionarySlug, sourceId) pair it links a card by: never a row id, which
// changes on every dictionary rebuild. Split on the FIRST colon: a slug never
// contains one, a source id may (jmnedict ids are free text). A handle that
// isn't a pair links nothing rather than posting half of one.
function entryHandle(entry?: string): { dictionarySlug: string; sourceId: string } | Record<string, never> {
  const at = entry ? entry.indexOf(":") : -1;
  if (!entry || at < 1 || at === entry.length - 1) return {};
  return { dictionarySlug: entry.slice(0, at), sourceId: entry.slice(at + 1) };
}

// Gloss language + dictionary display names for a sense's source label, echoing
// the web ("Español · JMdict"). Unknown codes/slugs fall back to a title-cased
// form so user-uploaded dictionaries still read sensibly.
export class ShirabeApi {
  // One renewal at a time. Every request that finds the token stale (or gets a
  // 401) waits on the same promise, so a burst of lookups after an hour idle
  // costs one round trip to the token endpoint, and, more importantly, trades
  // the refresh token ONCE: it is single-use, and a second trade past the
  // server's short grace revokes the whole grant.
  private renewing: Promise<void> | null = null;

  constructor(
    private config: Config,
    // Persist a new pair (login or renewal), and forget everything when the
    // server says the grant is over. Both owned by whoever owns Config.
    private hooks: { onTokens?: (tokens: Tokens) => Promise<void>; onSignedOut?: () => Promise<void> } = {},
  ) {}

  update(config: Config): void {
    this.config = config;
  }

  // ── Redirect login (OAuth 2.0 authorization code + PKCE) ────────────────────
  // The consent URL the extension opens with `identity.launchWebAuthFlow`. The
  // user approves the scopes there and the browser redirects a one-time code
  // back to `redirectUri`.
  authorizeUrl(opts: { redirectUri: string; state: string; challenge: string }): string {
    const base = this.config.apiBase.replace(/\/$/, "");
    const query = new URLSearchParams({
      response_type: "code",
      client_id: OAUTH_CLIENT_ID,
      redirect_uri: opts.redirectUri,
      scope: OAUTH_SCOPES.join(" "),
      state: opts.state,
      code_challenge: opts.challenge,
      code_challenge_method: "S256",
      resource: `${base}/api/v1`,
    });
    return `${base}/oauth/authorize?${query}`;
  }

  // Exchange the one-time code (+ PKCE verifier) for the first token pair. No
  // token yet: the code and verifier are the proof.
  async exchangeCode(opts: { code: string; verifier: string; redirectUri: string }): Promise<Tokens> {
    const response = await this.post<TokenResponse>(
      "/api/v1/oauth/token",
      {
        grant_type: "authorization_code", client_id: OAUTH_CLIENT_ID,
        code: opts.code, code_verifier: opts.verifier, redirect_uri: opts.redirectUri,
        resource: `${this.config.apiBase.replace(/\/$/, "")}/api/v1`,
      },
      { auth: false },
    );
    return tokensFrom(response);
  }

  // Trade the refresh token for the next pair. Single-flight (see `renewing`).
  // A refusal means the grant is over: revoked on the account page, idle for
  // ninety days, or the refresh token replayed. Nothing here can mend that, so
  // the tokens are dropped and the reader is asked to connect again.
  renew(): Promise<void> {
    this.renewing ??= this.doRenew().finally(() => {
      this.renewing = null;
    });
    return this.renewing;
  }

  private async doRenew(): Promise<void> {
    const refreshToken = this.config.refreshToken;
    if (!refreshToken) throw new ApiError("Not connected. Open the extension and connect to Shirabe.", 401);

    let response: TokenResponse;
    try {
      response = await this.post<TokenResponse>(
        "/api/v1/oauth/token",
        { grant_type: "refresh_token", client_id: OAUTH_CLIENT_ID, refresh_token: refreshToken,
          resource: `${this.config.apiBase.replace(/\/$/, "")}/api/v1` },
        { auth: false },
      );
    } catch (error) {
      // `invalid_grant` is the server saying the link is over. Anything else
      // (offline, 5xx) is a bad moment, and the tokens we hold may still be
      // fine next time.
      if (error instanceof ApiError && error.code === "INVALID_GRANT") {
        await this.signOut();
        throw new ApiError("Your Shirabe connection has expired. Open the extension and connect again.", 401, "INVALID_GRANT");
      }
      throw error;
    }

    const tokens = tokensFrom(response);
    this.config = { ...this.config, ...tokens };
    await this.hooks.onTokens?.(tokens);
  }

  private async signOut(): Promise<void> {
    this.config = { ...this.config, accessToken: "", accessTokenExpiresAt: "", refreshToken: "", scopes: [] };
    await this.hooks.onSignedOut?.();
  }

  // Hand the grant back (RFC 7009): the "disconnect" button's server half.
  // Without it, forgetting our tokens leaves the approval on the reader's
  // access list until it idles out. Best effort: offline, the reader can still
  // revoke it themselves at /account/settings#access.
  async revoke(): Promise<void> {
    const token = this.config.refreshToken || this.config.accessToken;
    if (!token) return;
    try {
      await this.post("/api/v1/oauth/revoke", { token, client_id: OAUTH_CLIENT_ID }, { auth: false });
    } catch {
      // See above.
    }
  }

  // Renew if the access token is about to run out, so a request never goes out
  // on a token that dies in flight. Nothing to do while it has time left.
  private async ensureFreshToken(): Promise<void> {
    const expiresAt = Date.parse(this.config.accessTokenExpiresAt);
    if (this.config.accessToken && expiresAt > Date.now() + RENEW_AHEAD_MS) return;
    await this.renew();
  }

  // ── SRS write-back (/api/v1/srs/*, requires a WRITE_SRS key) ────────────────────
  // Save (or mine) a word as a review card. `senses` scopes the card to a
  // subset of the word's senses (empty/omitted = the whole word). Grading is a
  // separate call: see `grade`.
  async save(options: {
    lemma: string; surface?: string; reading?: string; entry?: string; deckId?: number; newDeckName?: string;
    hint?: string; notes?: string; sentence?: SentenceCapture; sentences?: SentenceCapture[];
    senses?: string[]; imageDataUrl?: string; audioDataUrl?: string;
  }): Promise<SaveResult> {
    const { entry, ...fields } = options;
    const response = await this.post<{ card: { id: number }; created: boolean; word: WordStateEntry }>(
      "/api/v1/srs/saves", { ...fields, ...entryHandle(entry) },
    );
    // The card that was written identifies itself; everything else about the word
    //: its state, decks, how many cards it now holds: comes from `word`, the
    // same block a lookup returns.
    return {
      ...studyDetails(response.word),
      created: response.created,
      ...(response.card?.id != null ? { cardId: response.card.id } : {}),
    };
  }

  async grade(options: { cardId: number; revision: string; rating: 1 | 2 | 3 | 4 }): Promise<GradeResult> {
    const response = await this.post<{ card: { id: number; state: WordState }; intervals: IntervalPreviews }>("/api/v1/srs/reviews", options);
    const cardId = response.card?.id;
    return {
      state: response.card.state,
      intervals: response.intervals,
      ...(cardId != null ? { cardId } : {}),
    };
  }

  async decks(): Promise<Deck[]> {
    const { decks } = await this.get<{ decks: Deck[] }>("/api/v1/srs/decks");
    return decks;
  }

  async states(lemmas: string[]): Promise<{ states: Record<string, WordState>; details: Record<string, StudyDetails> }> {
    const { states } = await this.post<{ states: WordStateEntry[] }>("/api/v1/srs/states/lookup", { words: lemmas });
    return {
      states: Object.fromEntries(states.map((item) => [item.lemma, item.state])),
      details: Object.fromEntries(states.map((item) => [item.lemma, studyDetails(item)])),
    };
  }

  async parse(texts: string[]): Promise<ParsedToken[][]> {
    const response = await this.post<{ tokens: ParseTokenResponse[][] }>("/api/v1/parse", {
      texts,
      include: ["frequency", "furigana", "pitch"],
    });
    return response.tokens.map((tokens) => tokens.map((token) => ({
      start: token.position,
      length: token.length,
      surface: token.surface,
      reading: token.reading ?? null,
      lemma: token.lemma,
      ...(token.entry ? { entry: `${token.entry.dictionary}:${token.entry.sourceId}` } : {}),
      pos: token.pos ?? "",
      content: token.kind !== "function" && token.kind !== "symbol" && !["prt", "aux"].includes(token.pos ?? ""),
      state: token.state ?? "none",
      ...(token.frequency != null ? { frequency: token.frequency } : {}),
    })));
  }

  // Set a word's state directly: "retired" parks it as learned, "reviewing" brings
  // it into rotation. A state is word-level: it lands on every card the word
  // holds: so the answer is the whole word, not one card.
  async setState(lemma: string, state: "retired" | "reviewing"): Promise<StudyDetails> {
    const { word } = await this.post<{ word: WordStateEntry }>("/api/v1/srs/states", { lemma, state });
    return studyDetails(word);
  }

  // Connected account's display name + SRS entitlement, for the settings UI.
  // Needs READ_ACCOUNT (the device key has it). `entitled` mirrors the server's
  // srs_entitled? : the popup gates the whole reader on it.
  //
  // The account response is the extension's control plane for the complete
  // dictionary stack. The fingerprint changes for ordering, reveal settings,
  // dictionary content, and access changes, so a connected reader can notice
  // all of them without inspecting the packs individually.
  async me(): Promise<{ name: string; entitled: boolean; languages: GlossLanguage[]; dictionaries: string[];
    stackFingerprint: string;
    dictionaryReveal: Record<string, "show" | "hover">; dictionaryNames: Record<string, string>;
    availableDictionaries: Array<{ slug: string; name: string; languages: string[] }> }> {
    const data = await this.get<{
      user: { displayName?: string; name?: string };
      entitlement?: { srs?: boolean };
      preferences?: { languages?: string[]; dictionaries?: string[]; stackFingerprint?: string;
        dictionaryReveal?: Record<string, "show" | "hover">; dictionaryNames?: Record<string, string>;
        availableDictionaries?: Array<{ slug: string; name: string; languages: string[] }> };
    }>("/api/v1/me");
    return {
      name: data.user.displayName || data.user.name || "",
      entitled: data.entitlement?.srs === true,
      languages: glossLanguagesFrom(data.preferences?.languages ?? []),
      dictionaries: data.preferences?.dictionaries ?? [],
      stackFingerprint: data.preferences?.stackFingerprint ?? "",
      dictionaryReveal: data.preferences?.dictionaryReveal ?? {},
      dictionaryNames: data.preferences?.dictionaryNames ?? {},
      availableDictionaries: data.preferences?.availableDictionaries ?? [],
    };
  }

  async authorization(): Promise<string> {
    if (!this.config.refreshToken) throw new ApiError("Not connected. Open the extension and connect to Shirabe.", 401);
    await this.ensureFreshToken();
    return `Bearer ${this.config.accessToken}`;
  }

  // Sending `languages` (rather than the full `dictionaries` stack) asks the
  // server for a projection: it keeps the reader's dictionary order exactly as
  // it is and re-languages each one. So changing languages from here can never
  // scramble an ordering this client can't see.
  async updateLanguages(languages: readonly GlossLanguage[]): Promise<GlossLanguage[]> {
    const data = await this.patch<{ preferences: { languages: string[] } }>(
      "/api/v1/preferences",
      { languages: uiLanguagesFrom(languages) },
    );
    return glossLanguagesFrom(data.preferences.languages);
  }

  async updateDictionaryStack(dictionaries: readonly string[], dictionaryReveal: Record<string, "show" | "hover">): Promise<void> {
    await this.patch("/api/v1/preferences", { dictionaries, dictionaryReveal });
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

  private async request<T>(path: string, init: RequestInit, opts: { auth?: boolean; retried?: boolean } = {}): Promise<T> {
    const auth = opts.auth !== false; // the OAuth endpoints opt out: they mint the tokens
    if (auth) {
      if (!this.config.refreshToken) throw new ApiError("Not connected. Open the extension and connect to Shirabe.", 401);
      await this.ensureFreshToken();
    }

    const res = await fetch(this.config.apiBase.replace(/\/$/, "") + path, {
      ...init,
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        ...(auth ? { Authorization: `Bearer ${this.config.accessToken}` } : {}),
      },
    });

    if (!res.ok) {
      // A 401 on a token we thought was good: revoked underneath us, or the
      // clock disagreed with the server about its hour. One renewal and one
      // retry; if the renewal itself is refused the link is over (see
      // `doRenew`), and if the retry still 401s the answer stands.
      if (auth && res.status === 401 && !opts.retried) {
        await this.renew();
        return this.request<T>(path, init, { ...opts, retried: true });
      }
      const detail = await res.json().catch(() => null);
      const message = detail?.detail || detail?.title || `Request failed (${res.status})`;
      throw new ApiError(message, res.status, typeof detail?.code === "string" ? detail.code : undefined);
    }
    return (await res.json()) as T;
  }
}

function tokensFrom(response: TokenResponse): Tokens {
  return {
    accessToken: response.access_token,
    accessTokenExpiresAt: new Date(Date.now() + response.expires_in * 1000).toISOString(),
    refreshToken: response.refresh_token,
    scopes: response.scope.split(" ").filter(Boolean),
  };
}

// Katakana → hiragana, returning null when no furigana is warranted (kana-only
// surface, or the reading just echoes the surface).
