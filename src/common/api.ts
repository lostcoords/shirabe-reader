import type { Config } from "./config.js";
import type { Definition, ParsedToken, WordState } from "./types.js";

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

// /v1/device/authorize → the handshake a client shows the user.
export type DeviceAuth = {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string;
  scopes: string[];
  expiresIn: number;
  interval: number; // seconds to wait between token polls
};
// /v1/device/token → a status envelope; the key arrives on "approved".
export type DeviceToken =
  | { status: "pending" | "denied" | "expired" }
  | { status: "approved"; apiKey: string; scopes: string[] };

// /v1/search: nested entries → senses → definitions/tags (camelCase).
type RawSearch = {
  results: Array<{
    headword: string;
    reading: string | null;
    entries: Array<{
      dictionary: string;
      senses: Array<{
        definitions: Array<{ lang: string; text: string }>;
        tags: Array<{ category: string; code: string; label: string }>;
      }>;
    }>;
  }>;
};

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

  // Hover-popup definition. Reuses the public search endpoint and flattens the
  // first result's senses for display.
  async lookup(query: string): Promise<Definition | null> {
    const data = await this.post<RawSearch>("/v1/search", {
      query,
      locale: this.config.locale,
      take: 1,
    });
    const result = data.results[0];
    if (!result) return null;

    const senses = result.entries
      .flatMap((e) => e.senses)
      .map((sense) => ({
        glosses: sense.definitions.map((d) => d.text),
        partsOfSpeech: sense.tags.filter((t) => t.category === "partOfSpeech").map((t) => t.label),
      }))
      .filter((s) => s.glosses.length > 0);

    return { headword: result.headword, reading: result.reading, senses };
  }

  // ── Device login (no key — this is how a client gets one) ───────────────────
  // Start the handshake. The minted key gets WRITE_SRS so the reader can mine
  // and grade, not just read.
  async authorizeDevice(client: string): Promise<DeviceAuth> {
    return this.post<DeviceAuth>(
      "/v1/device/authorize",
      { client, scopes: ["READ_DICTIONARY", "READ_PREFERENCES", "READ_ACCOUNT", "READ_SRS", "WRITE_SRS"] },
      { auth: false },
    );
  }

  // Poll once. The caller loops on `interval` until the status leaves "pending".
  async pollDevice(deviceCode: string): Promise<DeviceToken> {
    return this.post<DeviceToken>("/v1/device/token", { deviceCode }, { auth: false });
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

  // Connected account's display name + the scopes its key carries, for the
  // settings UI. Needs READ_ACCOUNT (the device key has it).
  async me(): Promise<{ name: string }> {
    const data = await this.get<{ user: { displayName?: string; name?: string } }>("/v1/me");
    return { name: data.user.displayName || data.user.name || "" };
  }

  // ── HTTP plumbing ───────────────────────────────────────────────────────
  private async get<T>(path: string): Promise<T> {
    return this.request<T>(path, { method: "GET" });
  }

  private async post<T>(path: string, body: unknown, opts: { auth?: boolean } = {}): Promise<T> {
    return this.request<T>(path, { method: "POST", body: JSON.stringify(body) }, opts);
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
