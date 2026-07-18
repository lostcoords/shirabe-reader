// Short learner-facing labels for JMdict annotation codes — the same ones
// shirabe.org shows on sense chips (SearchHelper#pos_label / legend terms).
// Offline packs store raw codes (v5r, vi, uk…); the API returns full entity
// strings. Both paths resolve through here so the popup matches the site.

// Fixed POS codes → short chip text. Verbs collapse by class via posLabel's
// prefixes; everything else falls back to the full JMdict label (stripped) or
// the raw code.
const POS_LABELS: Record<string, string> = {
  n: "Noun",
  pn: "Pronoun",
  num: "Numeric",
  ctr: "Counter",
  "n-pref": "Noun (prefix)",
  "n-suf": "Noun (suffix)",
  adv: "Adverb",
  "adv-to": "Adverb",
  prt: "Particle",
  conj: "Conjunction",
  int: "Interjection",
  exp: "Expression",
  pref: "Prefix",
  suf: "Suffix",
  aux: "Auxiliary",
  "aux-v": "Aux. verb",
  "aux-adj": "Aux. adjective",
  cop: "Copula",
  vt: "Transitive verb",
  vi: "Intransitive verb",
  vs: "Suru verb",
  "vs-i": "Suru verb",
  "vs-s": "Suru verb",
  "vs-c": "Suru verb",
  vk: "Kuru verb",
  "adj-i": "I-adjective",
  "adj-ix": "I-adjective",
  "adj-na": "Na-adjective",
  "adj-no": "No-adjective",
  "adj-pn": "Prenominal",
  "adj-t": "Taru-adjective",
  "adj-f": "Prenominal",
};

// JMnedict name-type codes (online API nameType tags; offline packs omit them).
const NAME_TYPE_LABELS: Record<string, string> = {
  surname: "Surname",
  given: "Given name",
  fem: "Female given name",
  masc: "Male given name",
  person: "Person name",
  place: "Place name",
  organization: "Organization name",
  company: "Company name",
  product: "Product name",
  work: "Work name",
  unclass: "Unclassified name",
  char: "Character name",
  creat: "Creature name",
  dei: "Deity name",
  myth: "Mythological name",
  leg: "Legend name",
  fict: "Fiction name",
  serv: "Service name",
  ev: "Event name",
  ship: "Ship name",
  group: "Group name",
  obj: "Object name",
  doc: "Document name",
  quote: "Quote",
  relig: "Religion name",
};

// Misc / usage flags — legend short labels where the web has them, else the
// usual JMdict English gloss. Field/dialect fall through to the raw code when
// unknown (they're usually readable already: "comp", "ksb"…).
const MISC_LABELS: Record<string, string> = {
  uk: "Usually kana",
  abbr: "Abbreviation",
  col: "Colloquial",
  sl: "Slang",
  vulg: "Vulgar",
  derog: "Derogatory",
  hon: "Honorific",
  hum: "Humble",
  pol: "Polite",
  fam: "Familiar",
  fem: "Feminine",
  male: "Masculine",
  arch: "Archaic",
  obs: "Obsolete",
  rare: "Rare",
  joc: "Jocular",
  euph: "Euphemistic",
  "on-mim": "Onomatopoeic",
  yoji: "Yojijukugo",
  proverb: "Proverb",
  id: "Idiomatic",
  chn: "Childish",
  poet: "Poetic",
  dated: "Dated",
  form: "Formal",
  hist: "Historical",
  "net-sl": "Internet slang",
  "m-sl": "Manga slang",
  sens: "Sensitive",
  X: "Rude/X-rated",
  ateji: "Ateji",
  ik: "Irregular kana",
  iK: "Irregular kanji",
  io: "Irregular okurigana",
  oK: "Out-dated kanji",
  ok: "Out-dated kana",
  rk: "Rarely-used kana",
  rK: "Rarely-used kanji",
  sK: "Search-only kanji",
  sk: "Search-only kana",
  gikun: "Special reading",
};

/**
 * Short POS (or name-type) label for a JMdict code.
 * `full` is the verbose entity string when available (online API); used only as
 * a fallback when the code is unknown.
 */
export function posLabel(code: string, full?: string): string {
  if (!code) return full?.trim() || "";
  if (POS_LABELS[code]) return POS_LABELS[code];
  if (NAME_TYPE_LABELS[code]) return NAME_TYPE_LABELS[code];

  if (/^v5/.test(code)) return "Godan verb";
  if (/^v1/.test(code)) return "Ichidan verb";
  if (/^v[24]/.test(code)) return "Classical verb";
  if (/^v/.test(code)) return "Verb";

  const stripped = (full ?? "")
    .replace(/\s*\([^)]*\)/g, "")
    .replace(/\s+-\s.*$/u, "")
    .trim();
  if (stripped) return stripped.charAt(0).toUpperCase() + stripped.slice(1);
  return code;
}

/** Short label for a misc/field/dialect (or writing) tag code. */
export function tagLabel(code: string, full?: string): string {
  if (!code) return full?.trim() || "";
  if (MISC_LABELS[code]) return MISC_LABELS[code];
  if (NAME_TYPE_LABELS[code]) return NAME_TYPE_LABELS[code];
  if (full?.trim()) return full.trim();
  return code;
}

/** Map a list of POS codes (offline pack) to display labels, de-duped in order. */
export function posLabels(codes: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const code of codes) {
    const label = posLabel(code);
    if (!label || seen.has(label)) continue;
    seen.add(label);
    out.push(label);
  }
  return out;
}

/** Map misc/field/dialect codes to display labels, de-duped in order. */
export function tagLabels(codes: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const code of codes) {
    const label = tagLabel(code);
    if (!label || seen.has(label)) continue;
    seen.add(label);
    out.push(label);
  }
  return out;
}
