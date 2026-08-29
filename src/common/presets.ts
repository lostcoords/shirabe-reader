import type { Config } from "./config.js";

// The colour settings are two channels, a state list and a part-of-speech mode,
// which is four decisions to reason about before a page looks the way you want.
// A preset is one decision that writes all four. Applying one is a plain write of
// those fields, so what a page paints always comes from the fields themselves and
// a preset can never claim something the page disagrees with.
export type ColorPreset = "state" | "jpdb" | "grammar" | "minimal" | "custom";

// Exactly the fields a preset owns. Anything outside this list (highlighting,
// furigana, i+1) survives applying one.
export type PresetFields = Pick<Config, "stateColoring" | "posColoring" | "markedStates">;

export const PRESETS: Record<Exclude<ColorPreset, "custom">, { label: string; hint: string; fields: PresetFields }> = {
  state: {
    label: "Study state",
    hint: "An underline coloured by how well you know each word.",
    fields: { stateColoring: "underline", posColoring: "off", markedStates: ["none", "new", "learning", "due"] },
  },
  jpdb: {
    label: "Coloured words",
    hint: "Colours the word itself and draws no underline, the way jpd-breader marks a page.",
    fields: { stateColoring: "text", posColoring: "off", markedStates: ["new", "learning", "due", "retired"] },
  },
  grammar: {
    label: "Grammar",
    hint: "Tints each word by part of speech and keeps the underline for study state.",
    fields: { stateColoring: "underline", posColoring: "text", markedStates: ["none", "new", "learning", "due"] },
  },
  minimal: {
    label: "Only what is due",
    hint: "Marks words waiting for review and leaves the rest of the page alone.",
    fields: { stateColoring: "underline", posColoring: "off", markedStates: ["due"] },
  },
};

export const PRESET_IDS = Object.keys(PRESETS) as Array<Exclude<ColorPreset, "custom">>;

const sameStates = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && [...a].sort().join() === [...b].sort().join();

// Which preset a config currently matches, so the settings page can show the
// name rather than trusting a stored label that hand edits have outgrown.
export function matchPreset(config: PresetFields): ColorPreset {
  for (const id of PRESET_IDS) {
    const { fields } = PRESETS[id];
    if (
      fields.stateColoring === config.stateColoring &&
      fields.posColoring === config.posColoring &&
      sameStates(fields.markedStates, config.markedStates)
    ) {
      return id;
    }
  }
  return "custom";
}
