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
type RawToken = {
  surface: string;
  lemma: string;
  reading?: string; // katakana
  pos?: string; // short label
  primary?: boolean;
};

type RawSearch = {
  results: Array<{
    headword: string;
    reading: string | null;
    sources: Array<{
      dictionary: string;
      senses?: Array<{ glosses: Record<string, string[]>; parts_of_speech: string[] }>;
    }>;
  }>;
};

// POS short labels that carry no standalone meaning — not worth wrapping/saving.
const FUNCTION_POS = new Set(["prt", "aux", ""]);
const KANJI = /[一-龯㐀-䶿]/;
const JAPANESE = /[぀-ヿ一-龯㐀-䶿ｦ-ﾟ]/;

export class ShirabeApi {
  constructor(private config: Config) {}

  update(config: Config): void {
    this.config = config;
  }

  // Tokenize text and lift each token to a ParsedToken with UTF-16 offsets into
  // `text`. The server returns tokens in reading order but no positions, so we
  // walk the source string sequentially — correct even when a surface repeats.
  async parse(text: string): Promise<ParsedToken[]> {
    const { tokens } = await this.post<{ tokens: RawToken[] }>("/v1/tokenize", { text });

    let cursor = 0;
    return tokens.map((t) => {
      const found = text.indexOf(t.surface, cursor);
      const start = found >= 0 ? found : cursor;
      cursor = start + t.surface.length;

      const reading = furiganaFor(t.surface, t.reading);
      const content = !FUNCTION_POS.has(t.pos ?? "") && JAPANESE.test(t.surface);

      return {
        start,
        length: t.surface.length,
        surface: t.surface,
        reading,
        lemma: t.lemma || t.surface,
        pos: t.pos ?? "",
        content,
        // No per-user state endpoint yet — see docs/extension.md. Everything is
        // "unknown" until /v1/word_states lands; the seam below is ready for it.
        state: "unknown" as WordState,
      };
    });
  }

  // Hover-popup definition. Reuses the public search endpoint and flattens the
  // first JMdict result for the requested gloss locale.
  async lookup(query: string): Promise<Definition | null> {
    const params = new URLSearchParams({ q: query, locale: this.config.locale, limit: "1" });
    const data = await this.get<RawSearch>(`/v1/search?${params}`);
    const result = data.results[0];
    if (!result) return null;

    const senses = result.sources
      .flatMap((s) => s.senses ?? [])
      .map((sense) => ({
        glosses: sense.glosses[this.config.locale] ?? Object.values(sense.glosses)[0] ?? [],
        partsOfSpeech: sense.parts_of_speech,
      }))
      .filter((s) => s.glosses.length > 0);

    return { headword: result.headword, reading: result.reading, senses };
  }

  // ── SRS write-back (server endpoints pending; see docs/extension.md) ────────
  // These are wired end-to-end on the client. They will start working the
  // moment Shirabe exposes them under /v1; until then they surface a clear
  // "not available yet" error rather than failing silently.
  async save(lemma: string): Promise<void> {
    await this.post("/v1/saves", { lemma });
  }

  async setState(lemma: string, state: WordState): Promise<void> {
    await this.post("/v1/word_states", { lemma, state });
  }

  // ── HTTP plumbing ───────────────────────────────────────────────────────
  private async get<T>(path: string): Promise<T> {
    return this.request<T>(path, { method: "GET" });
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>(path, { method: "POST", body: JSON.stringify(body) });
  }

  private async request<T>(path: string, init: RequestInit): Promise<T> {
    if (!this.config.apiKey) throw new ApiError("No API key set. Open the extension settings.", 401);

    const res = await fetch(this.config.apiBase.replace(/\/$/, "") + path, {
      ...init,
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.config.apiKey}`,
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
