import assert from "node:assert/strict";
import test from "node:test";

// The preset module reaches Config, which reaches browser.ts and its WebExtension
// global. Same stub, same reason as host-rules.test.ts.
if (!(globalThis as { chrome?: unknown }).chrome) {
  (globalThis as { chrome?: unknown }).chrome = {
    runtime: { sendMessage: async () => ({ ok: true }), onMessage: { addListener() {} }, getURL: (path: string) => path },
    storage: { local: { get: async () => ({}), set: async () => {}, remove: async () => {} }, onChanged: { addListener() {} } },
  };
}
const load = () => import("../src/common/presets.js");
const loadConfig = () => import("../src/common/config.js");

test("every preset round-trips: applying one is recognised as itself", async () => {
  const { PRESETS, PRESET_IDS, matchPreset } = await load();
  for (const id of PRESET_IDS) {
    assert.equal(matchPreset(PRESETS[id].fields), id, `${id} does not match itself`);
  }
});

test("the shipped defaults are a named preset, not an unnamed halfway state", async () => {
  const { matchPreset } = await load();
  const { DEFAULTS } = await loadConfig();
  // A default the settings page has to label "Custom" means the box we ship in
  // is one no preset offers, so nobody can get back to it after changing a field.
  assert.equal(matchPreset(DEFAULTS), "state");
  assert.equal(DEFAULTS.colorPreset, "state");
});

test("hand-edited colours report as custom rather than the preset they came from", async () => {
  const { PRESETS, matchPreset } = await load();
  const edited = { ...PRESETS.state.fields, posColoring: "text" as const };
  assert.equal(matchPreset(edited), "grammar", "this edit lands exactly on another preset");

  const nowhere = { ...PRESETS.state.fields, markedStates: ["new" as const] };
  assert.equal(matchPreset(nowhere), "custom");
});

test("marked states compare as a set, so order never invents a custom preset", async () => {
  const { PRESETS, matchPreset } = await load();
  const reordered = { ...PRESETS.state.fields, markedStates: [...PRESETS.state.fields.markedStates].reverse() };
  assert.equal(matchPreset(reordered), "state");
});

test("the jpdb preset is the one that paints known words and leaves untracked alone", async () => {
  const { PRESETS } = await load();
  const { fields } = PRESETS.jpdb;
  // Its whole point: word ink rather than an underline, a colour for words you
  // know, and nothing on the majority of a new reader's page.
  assert.equal(fields.stateColoring, "text");
  assert.ok(fields.markedStates.includes("retired"));
  assert.ok(!fields.markedStates.includes("none"));
});
