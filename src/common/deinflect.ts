// Rule-based Japanese deinflection: an inflected surface form back to the
// dictionary form(s) it could come from, naming each step along the way.
//
// The rule set (resources/japanese-transforms.json) and this algorithm are
// ported from Yomitan's Japanese language transforms and LanguageTransformer,
// by way of daidai's Ruby port — the same gem the website already uses to name
// inflections (see tokens_helper.rb), so a chain reads identically in the
// extension and on the page. Both upstreams are GPL-3.0; see ../../LICENSE and
// ../../NOTICE.
//
// Why rules rather than a suffix table: every rule declares the grammatical
// state it consumes and produces (`conditionsIn`/`conditionsOut` — Ichidan,
// Godan, Kuru, Suru, i-adjective…), so a rule only fires when the form actually
// permits it. A flat table happily "deinflects" 高くなかった as if 高い were a verb.
import transformData from "./resources/japanese-transforms.json" with { type: "json" };

export type Deinflection = {
  term: string;
  inflections: string[]; // surface → dictionary order, e.g. ["-た", "-ます"]
  dictionaryForm: boolean; // the chain landed on a real dictionary form
};

// Friendly names for the rules, kept identical to daidai's LABELS — daidai calls
// that map "the single source of truth for naming an inflection", and the
// website renders it (tokens_helper.rb), so the same word reads the same way in
// both places. Unlisted names fall through to the raw rule name.
const LABELS: Record<string, string> = {
  "-いる": "progressive", "-て": "te-form", "-た": "past",
  "-ます": "polite", negative: "negative", passive: "passive",
  potential: "potential", "potential or passive": "potential / passive",
  causative: "causative", "short causative": "short causative",
  volitional: "volitional", "volitional slang": "volitional (slang)",
  imperative: "imperative", continuative: "continuative",
  "-たい": "desiderative (-tai)", "-たら": "conditional (-tara)",
  "-たり": "representative (-tari)", "-ば": "provisional (-ba)",
  "-ゃ": "conditional contraction (-ya)", "-ちゃ": "contracted (-cha)",
  "-ちゃう": "completive (-chau)", "-ちまう": "completive (-chimau)",
  "-しまう": "completive (-shimau)", "-おく": "preparatory (-oku)",
  "-そう": "looks like (-sou)", "-すぎる": "excessive (-sugiru)",
  "-過ぎる": "excessive (-sugiru)", "-なさい": "polite imperative (-nasai)",
  "-さ": "nominalization (-sa)", "-げ": "appearance (-ge)",
  "-がる": "showing signs (-garu)", "-やがる": "contemptuous (-yagaru)",
  "-ず": "negative (-zu)", "-ぬ": "negative (-nu)", "-ん": "negative (-n)",
  "-ざる": "negative (-zaru)", "-ねば": "negative conditional (-neba)",
  "-まい": "negative volitional (-mai)", "-く": "adverbial (-ku)",
  "-き": "attributive (-ki)", "-む": "archaic volitional (-mu)",
  "-んばかり": "on the verge (-nbakari)", "-んとする": "intentive (-ntosuru)",
  "-え": "slang (-e)", "n-slang": "n-slang",
  "imperative negative slang": "imperative negative (slang)",
  "kansai-ben": "kansai dialect",
};

export const inflectionLabel = (name: string): string => LABELS[name] ?? name;

type RawRule = { type: string; inflected: string; deinflected: string; conditionsIn: string[]; conditionsOut: string[] };
type RawTransform = { name: string; rules: RawRule[] };
type RawCondition = { name: string; isDictionaryForm: boolean; subConditions?: string[] | null };

type Rule = {
  isInflected: RegExp;
  deinflect: (text: string) => string;
  conditionsIn: number;
  conditionsOut: number;
};
type Transform = { id: string; name: string; rules: Rule[]; heuristic: RegExp };
type TransformedText = { text: string; conditions: number; trace: Array<{ transform: string; ruleIndex: number; text: string }> };

const conditions = transformData.conditions as unknown as Record<string, RawCondition>;
const rawTransforms = transformData.transforms as unknown as Record<string, RawTransform>;

// Each leaf condition gets its own bit; a parent is the OR of its children.
// Resolved iteratively because a parent can be listed before its children.
function computeConditionFlags(): Record<string, number> {
  const flags: Record<string, number> = {};
  let nextIndex = 0;
  let targets = Object.keys(conditions);
  while (targets.length) {
    const remaining: string[] = [];
    for (const type of targets) {
      const sub = conditions[type]?.subConditions;
      if (!sub) {
        if (nextIndex >= 32) throw new Error("Too many deinflection conditions (max 32).");
        flags[type] = 1 << nextIndex;
        nextIndex += 1;
      } else {
        const resolved = strictFlags(flags, sub);
        if (resolved == null) remaining.push(type);
        else flags[type] = resolved;
      }
    }
    if (remaining.length === targets.length) throw new Error("Cycle in deinflection sub-conditions.");
    targets = remaining;
  }
  return flags;
}

// OR the named conditions' flags; null when one isn't assigned yet, so
// resolution can defer it to a later pass.
function strictFlags(flags: Record<string, number>, types: readonly string[]): number | null {
  let result = 0;
  for (const type of types) {
    const flag = flags[type];
    if (flag == null) return null;
    result |= flag;
  }
  return result;
}

const CONDITION_FLAGS = computeConditionFlags();

const DICTIONARY_MASK = Object.entries(conditions)
  .reduce((mask, [type, condition]) => (condition.isDictionaryForm ? mask | (CONDITION_FLAGS[type] ?? 0) : mask), 0);

// Inflected/deinflected fragments are literal kana/kanji — no regex
// metacharacters — so they are matched verbatim, as Yomitan's helpers do.
function buildRule(rule: RawRule): Rule {
  const { inflected, deinflected } = rule;
  let isInflected: RegExp;
  let deinflect: (text: string) => string;
  switch (rule.type) {
    case "suffix":
      isInflected = new RegExp(`${inflected}$`);
      deinflect = (text) => text.slice(0, text.length - inflected.length) + deinflected;
      break;
    case "wholeWord":
      isInflected = new RegExp(`^${inflected}$`);
      deinflect = () => deinflected;
      break;
    case "prefix":
      isInflected = new RegExp(`^${inflected}`);
      deinflect = (text) => deinflected + text.slice(inflected.length);
      break;
    default:
      throw new Error(`Unknown deinflection rule type: ${rule.type}`);
  }
  return {
    isInflected,
    deinflect,
    conditionsIn: strictFlags(CONDITION_FLAGS, rule.conditionsIn) ?? 0,
    conditionsOut: strictFlags(CONDITION_FLAGS, rule.conditionsOut) ?? 0,
  };
}

const TRANSFORMS: Transform[] = Object.entries(rawTransforms).map(([id, transform]) => {
  const rules = transform.rules.map(buildRule);
  return { id, name: transform.name, rules, heuristic: new RegExp(rules.map((rule) => rule.isInflected.source).join("|")) };
});
const TRANSFORMS_BY_ID = new Map(TRANSFORMS.map((transform) => [transform.id, transform]));

const conditionsMatch = (current: number, following: number): boolean => current === 0 || (current & following) !== 0;

// Breadth-first over every rule that can apply, exactly as Yomitan's
// LanguageTransformer#transform: `results` grows while it is walked, so a form
// reached by one rule is itself re-examined by all of them.
function transform(source: string): TransformedText[] {
  const results: TransformedText[] = [{ text: source, conditions: 0, trace: [] }];
  for (let index = 0; index < results.length; index += 1) {
    const current = results[index];
    for (const item of TRANSFORMS) {
      if (!item.heuristic.test(current.text)) continue;
      item.rules.forEach((rule, ruleIndex) => {
        if (!conditionsMatch(current.conditions, rule.conditionsIn)) return;
        if (!rule.isInflected.test(current.text)) return;
        // Cycle guard: the same rule already fired on this exact text.
        if (current.trace.some((frame) => frame.transform === item.id && frame.ruleIndex === ruleIndex && frame.text === current.text)) return;
        results.push({
          text: rule.deinflect(current.text),
          conditions: rule.conditionsOut,
          trace: [{ transform: item.id, ruleIndex, text: current.text }, ...current.trace],
        });
      });
    }
  }
  return results;
}

// Every candidate base form for `text`, each with its named inflection chain.
// Drops the zero-transform identity: callers probe the exact form separately.
export function deinflect(text: string): Deinflection[] {
  const seen = new Set<string>();
  const out: Deinflection[] = [];
  for (const result of transform(text)) {
    if (!result.trace.length) continue;
    // trace is innermost-first; reverse so names read surface → dictionary form.
    const inflections = result.trace.slice().reverse().map((frame) => TRANSFORMS_BY_ID.get(frame.transform)?.name ?? frame.transform);
    const key = `${result.text}\0${inflections.join(",")}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ term: result.text, inflections, dictionaryForm: (result.conditions & DICTIONARY_MASK) !== 0 });
  }
  return out;
}
