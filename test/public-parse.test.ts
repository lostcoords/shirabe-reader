import assert from "node:assert/strict";
import test from "node:test";

test("anonymous parsing uses the public API without an authorization header", async () => {
  const original = globalThis.fetch;
  const originalChrome = globalThis.chrome;
  Object.assign(globalThis, { chrome: originalChrome ?? {
    runtime: { id: "reader-test" },
    storage: { local: { get: async () => ({}) }, onChanged: { addListener() {} } },
  } });
  let request: Request | undefined;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    request = new Request(input, init);
    return Response.json({
      stackFingerprint: "a".repeat(16),
      packRevision: "b".repeat(16),
      sources: ["jmdict:en"],
      results: [{ text: "食べました", tokens: [{
        startOffset: 0, endOffset: 5, surface: "食べました", lemma: "食べる",
        reading: "タベマシタ", partOfSpeech: "verb", kind: "inflected",
        inflection: { base: "食べる", forms: [{ code: "past-tense", label: "past" }] },
      }] }],
    });
  }) as typeof fetch;
  try {
    const { ShirabeApi } = await import("../src/common/api.js");
    const { DEFAULTS } = await import("../src/common/config.js");
    const api = new ShirabeApi({ ...DEFAULTS, apiBase: "https://shirabe.test" });

    const parsed = await api.parseWithProvenance(["食べました"]);
    const tokens = parsed.tokens;

    assert.equal(request?.url, "https://shirabe.test/api/v1/parse");
    assert.equal(request.headers.has("authorization"), false);
    assert.deepEqual(JSON.parse(await request.text()), { texts: ["食べました"] });
    assert.equal(tokens[0][0].lemma, "食べる");
    assert.equal(tokens[0][0].start, 0);
    assert.equal(tokens[0][0].length, 5);
    assert.deepEqual(tokens[0][0].inflection, ["past"]);
    assert.equal(parsed.packRevision, "b".repeat(16));
    assert.deepEqual(parsed.sources, ["jmdict:en"]);
  } finally {
    globalThis.fetch = original;
    Object.assign(globalThis, { chrome: originalChrome });
  }
});
