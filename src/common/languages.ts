// Gloss languages and their order: the extension's copy of the server's
// Locales module. Kept free of browser/storage imports so the dictionary engine
// (and its tests) can use it without a WebExtension environment.

// Gloss codes as the pack stores them (Locales::GLOSS_TO_DB values). The pack
// ships English and Spanish; the server supports more, and a reader whose stack
// names one we don't carry simply falls through to English.
export type GlossLanguage = "eng" | "spa";

export const GLOSS_LABELS: Record<GlossLanguage, string> = { eng: "English", spa: "Español" };

// Locales::GLOSS_TO_DB, narrowed to what a pack can contain.
const UI_TO_GLOSS: Record<string, GlossLanguage> = { en: "eng", es: "spa" };
const GLOSS_TO_UI: Record<GlossLanguage, string> = { eng: "en", spa: "es" };

// The account's ordered language stack (Prefs#languages, e.g. ["es","en"])
// mapped into pack codes, dropping languages this pack doesn't ship. Order is
// the whole point: it decides which meaning block renders first, exactly as
// Locales.source_stack_for does on the web.
export function glossLanguagesFrom(uiCodes: readonly string[]): GlossLanguage[] {
  const mapped = uiCodes.map((code) => UI_TO_GLOSS[code]).filter((code): code is GlossLanguage => !!code);
  return [...new Set(mapped)];
}

export function uiLanguagesFrom(glossCodes: readonly GlossLanguage[]): string[] {
  return [...new Set(glossCodes.map((code) => GLOSS_TO_UI[code]))];
}

// English is the last-resort gloss, mirroring Locales.with_english_fallback: a
// sense with no gloss in your languages still reads rather than rendering blank.
export function withEnglishFallback(languages: readonly GlossLanguage[]): GlossLanguage[] {
  return [...new Set([...languages, "eng" as const])];
}
