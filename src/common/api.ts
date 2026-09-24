import { isConnected, type Config } from "./config.js";
import { createShirabeClient, ShirabePublicClient, ShirabePublicApiError, type PublicAuthorization, type PublicCredentials, type ShirabeScope, type WordStateEntry } from "@shirabe-org/api";
import { glossLanguagesFrom, type GlossLanguage } from "@shirabe-org/card/word-card/languages";
import { cardWordState } from "@shirabe-org/card/word-card/types";
import type { ParsedToken, WordState } from "./types.js";
import type { Deck, GradeResult, IntervalPreviews, SaveResult, SentenceCapture, StudyDetails } from "./messages.js";

export { ShirabePublicApiError as ApiError };
const ApiError = ShirabePublicApiError;

// Dictionary lookup is public and local, so connecting must never ask for it.
// OAuth exists only for the personal online layer: identify the account, read
// its study state, and save/grade through the SRS.
const OAUTH_SCOPES = ["user:profile:read", "user:dictionary:read", "user:preferences:read", "user:preferences:write", "user:study:read", "user:study:write"] as const satisfies readonly ShirabeScope[];
// Registered on the server (OauthClient), where the consent screen's name and
// the redirect hosts we may use are decided. A public client: no secret, PKCE
// binds our codes.
const OAUTH_CLIENT_ID = "shirabe-extension";
export type Tokens = PublicCredentials;

const studyDetails = (word: WordStateEntry): StudyDetails => ({
  state: word.state,
  decks: word.decks,
  ...(word.cardId != null ? { cardId: word.cardId } : {}),
  ...(word.reviewCard ? { reviewCard: word.reviewCard } : {}),
  ...(word.cardCount != null ? { cardCount: word.cardCount } : {}),
  ...(word.savedSenses ? { savedSenses: word.savedSenses } : {}),
  ...(word.savedWholeWord ? { savedWholeWord: word.savedWholeWord } : {}),
  ...(word.intervals ? { intervals: word.intervals as IntervalPreviews } : {}),
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

export class ShirabeApi {
  private oauth: ShirabePublicClient;
  private config: Config;

  constructor(
    config: Config,
    hooks: { onTokens?: (tokens: Tokens) => Promise<void>; onSignedOut?: () => Promise<void> } = {},
  ) {
    this.config = config;
    this.oauth = new ShirabePublicClient({
      baseUrl: config.apiBase,
      clientId: OAUTH_CLIENT_ID,
      scopes: OAUTH_SCOPES,
      credentials: config,
      onCredentials: hooks.onTokens,
      onSignedOut: hooks.onSignedOut,
    });
  }

  update(config: Config): void {
    this.config = config;
    this.oauth.update(config.apiBase, config);
  }

  begin(redirectUri: string): Promise<PublicAuthorization> {
    return this.oauth.begin(redirectUri);
  }

  complete(callbackUrl: string, flow: PublicAuthorization): Promise<Tokens> {
    return this.oauth.complete(callbackUrl, flow);
  }

  revoke(): Promise<void> {
    return this.oauth.revoke();
  }

  // ── SRS write-back (/api/v1/srs/*) ────────────────────
  // Save (or mine) a word as a review card. `senses` scopes the card to a
  // subset of the word's senses (empty/omitted = the whole word). Grading is a
  // separate call: see `grade`.
  async save(options: {
    lemma: string; surface?: string; reading?: string; entry?: string; deckId?: number; newDeckName?: string;
    hint?: string; notes?: string; sentence?: SentenceCapture; sentences?: SentenceCapture[];
    senses?: string[]; imageDataUrl?: string; audioDataUrl?: string;
  }): Promise<SaveResult> {
    const { entry, ...fields } = options;
    const response = await this.oauth.request((client) => client.saveCard({ ...fields, ...entryHandle(entry) }));
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
    const response = await this.oauth.request((client) => client.gradeCard(options));
    const cardId = response.card?.id;
    return {
      state: response.card.state,
      intervals: response.intervals as IntervalPreviews,
      ...(cardId != null ? { cardId } : {}),
    };
  }

  async decks(): Promise<Deck[]> {
    const { decks } = await this.oauth.request((client) => client.listDecks());
    return decks;
  }

  async states(lemmas: string[]): Promise<{ states: Record<string, WordState>; details: Record<string, StudyDetails> }> {
    const { states } = await this.oauth.request((client) => client.lookupWordStates({ words: lemmas }));
    return {
      states: Object.fromEntries(states.map((item) => [item.lemma, item.state])),
      details: Object.fromEntries(states.map((item) => [item.lemma, studyDetails(item)])),
    };
  }

  async parse(texts: string[]): Promise<ParsedToken[][]> {
    return (await this.parseWithProvenance(texts)).tokens;
  }

  async parseWithProvenance(texts: string[], sources: string[] = []): Promise<{ tokens: ParsedToken[][]; packRevision: string; stackFingerprint: string; sources: string[] }> {
    const connected = isConnected(this.config) && this.config.scopes.includes("user:dictionary:read");
    const body = { texts, ...(!connected && sources.length ? { sources } : {}) };
    const response = connected
      ? await this.oauth.request((client) => client.parse(body))
      : await this.publicParse(body);
    if (!("results" in response)) throw new ApiError("Shirabe queued this parse instead of returning it.", 202);
    const tokens = response.results.map(({ tokens }) => tokens.map((token) => ({
      start: token.startOffset,
      length: token.endOffset - token.startOffset,
      surface: token.surface,
      reading: token.reading ?? null,
      lemma: token.lemma ?? token.surface,
      inflection: token.inflection?.forms.map((form) => form.label),
      inflectionBase: token.inflection?.base,
      components: token.components?.map((part) => ({ surface: part.surface, start: part.startOffset,
        end: part.endOffset, lemma: part.lemma, reading: part.reading, pos: part.partOfSpeech })),
      pos: token.partOfSpeech ?? "",
      kind: token.kind,
      content: token.kind !== "symbol",
      state: cardWordState(token.study?.state),
    })));
    return { tokens, packRevision: response.packRevision, stackFingerprint: response.stackFingerprint, sources: response.sources };
  }

  private async publicParse(body: { texts: string[]; sources?: string[] }) {
    const client = createShirabeClient({ baseUrl: this.config.apiBase });
    const { data, error, response } = await client.parse(body);
    if (!data) throw new ApiError(error instanceof Error ? error.message : "The parser failed.", response?.status ?? 0);
    return data;
  }

  // Set a word's state directly: "retired" parks it as learned, "reviewing" brings
  // it into rotation. A state is word-level: it lands on every card the word
  // holds: so the answer is the whole word, not one card.
  async setState(lemma: string, state: "retired" | "reviewing"): Promise<StudyDetails> {
    const { word } = await this.oauth.request((client) => client.setWordState({ lemma, state }));
    return studyDetails(word);
  }

  // Connected account's display name + SRS entitlement, for the settings UI.
  // The account, dictionary stack, and catalog are separate API resources.
  async me(): Promise<{ name: string; entitled: boolean; languages: GlossLanguage[]; dictionaries: string[];
    stackFingerprint: string;
    dictionaryReveal: Record<string, "show" | "hover">; dictionaryNames: Record<string, string>;
    availableDictionaries: Array<{ slug: string; name: string; languages: string[] }> }> {
    const [data, stackResponse, catalogResponse] = await Promise.all([
      this.oauth.request((client) => client.getMe()),
      this.oauth.request((client) => client.getDictionaryStack()),
      this.oauth.request((client) => client.listDictionaries()),
    ]);
    const sources = stackResponse.dictionaryStack.sources;
    const availableDictionaries = catalogResponse.dictionaries.filter((dictionary) =>
      ["definition", "name", "encyclopedia"].includes(dictionary.kind));
    return {
      name: data.user.displayName || data.user.name || "",
      entitled: data.entitlement?.srs === true,
      languages: glossLanguagesFrom(sources.flatMap((source) => source.languages)),
      dictionaries: sources.flatMap((source) => source.languages.map((language) => `${source.dictionary}:${language}`)),
      stackFingerprint: stackResponse.dictionaryStack.fingerprint,
      dictionaryReveal: Object.fromEntries(sources.map((source) => [source.dictionary, source.reveal])),
      dictionaryNames: Object.fromEntries(availableDictionaries.map((dictionary) => [dictionary.slug, dictionary.name])),
      availableDictionaries,
    };
  }

  async authorization(): Promise<string> {
    return this.oauth.authorization();
  }

  async updateDictionaryStack(dictionaries: readonly string[], dictionaryReveal: Record<string, "show" | "hover">): Promise<string> {
    const current = await this.oauth.request((client) => client.getDictionaryStack());
    const sources: Array<{ dictionary: string; languages: string[]; reveal: "show" | "hover" }> = [];
    for (const reference of dictionaries) {
      const [dictionary, language] = reference.split(":");
      if (!dictionary || !language) continue;
      const source = sources.find((item) => item.dictionary === dictionary);
      if (source) source.languages.push(language);
      else sources.push({ dictionary, languages: [language], reveal: dictionaryReveal[dictionary] ?? "show" });
    }
    const result = await this.oauth.request((client) => client.replaceDictionaryStack({ fingerprint: current.dictionaryStack.fingerprint, sources }));
    return result.dictionaryStack.fingerprint;
  }
}
