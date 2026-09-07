import "fake-indexeddb/auto";
import assert from "node:assert/strict";
import test from "node:test";
import type { Request, Response as WorkerResponse } from "../src/common/messages.js";

test("background messages preserve offline parse offsets and picked entry identity", async () => {
  const firefox = process.env.PARITY_MESSAGE_API === "firefox";
  let listener: (request: Request, sender: object, respond: (response: WorkerResponse) => void) => unknown;
  const storage: Record<string, unknown> = {};
  const event = { addListener() {} };
  Object.assign(globalThis, {
    self: { addEventListener() {} },
    chrome: {
      runtime: {
        onMessage: { addListener(callback: typeof listener) { listener = callback; } },
        onConnect: event, onInstalled: event, getURL: (path: string) => path,
      },
      storage: {
        local: {
          get: async () => storage,
          set: async (values: Record<string, unknown>) => { Object.assign(storage, values); },
          remove: async () => {},
        },
        onChanged: event,
      },
      tabs: { onRemoved: event, query: async () => [] },
      scripting: { unregisterContentScripts: async () => {} },
      permissions: { contains: async () => false },
    },
  });
  if (firefox) Object.assign(globalThis, { browser: globalThis.chrome });
  const { installTestPack, packPayload } = await import("./support/pack.js");
  const term = (id: string, writing: string, reading: string, pos: string) => JSON.stringify({
    type: "term", id, dictionary: "jmdict", headword: writing,
    expressions: [{ text: writing, script: "kana", common: true, tags: [] }],
    readings: [{ text: reading, kind: "kana" }],
    senses: [{ glosses: { eng: [id] }, partsOfSpeech: [pos], fields: [], misc: [], dialects: [], restrictions: [] }],
  });
  await installTestPack(packPayload([
    JSON.stringify({ type: "header", schemaVersion: 6, languages: ["eng", "spa"], source: "Background parity" }),
    term("jmdict:banana", "バナナ", "バナナ", "n"),
    term("jmdict:copula", "だ", "だ", "cop"),
  ]), { contentRevision: "background-parity", terms: 2 });
  await import("../src/background/background.js");
  const send = (request: Request) => new Promise<WorkerResponse>((resolve) => {
    const result = listener(request, {}, resolve);
    if (firefox) {
      assert.ok(result instanceof Promise);
      void result.then(resolve);
    } else {
      assert.equal(result, true);
    }
  });
  const parsed = await send({ type: "parseBatch", texts: ["ﾊﾞﾅﾅ。", "バナナ。"] });
  assert.ok(parsed.ok && parsed.type === "parseBatch");
  assert.equal(parsed.tokens[0][0].entry, "jmdict:banana");
  assert.equal(parsed.tokens[0][0].surface, "ﾊﾞﾅﾅ");
  assert.equal(parsed.tokens[0][1].start, 4);
  assert.equal(parsed.tokens[1][1].start, 3);
  const romaji = await send({ type: "lookup", query: "banana" });
  assert.ok(romaji.ok && romaji.type === "lookup");
  assert.equal(romaji.definition?.entry, "jmdict:banana");
  const picked = await send({ type: "lookupEntry", entry: "jmdict:copula", surface: "だった" });
  assert.ok(picked.ok && picked.type === "lookupEntry");
  assert.equal(picked.definition?.entry, "jmdict:copula");
  assert.equal(picked.definition?.baseForm, "だ");
  assert.deepEqual(picked.definition?.inflection, ["past"]);
  const missing = await send({ type: "lookupEntry", entry: "jmdict:missing", surface: "バナナ" });
  assert.ok(!missing.ok);
  assert.equal(missing.code, "OFFLINE_LOOKUP_UNAVAILABLE");
});
