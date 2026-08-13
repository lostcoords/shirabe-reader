import "fake-indexeddb/auto";
import { parseOffline } from "../src/common/offline-dictionary.js";
import { installTestPack, packPayload, realPackPath, subsetPack } from "./support/pack.js";

// One sentence through the extension: its cut, its lemmas, the entry each token
// lands on, and the other words each span could be.
//
//   node test/one-sentence-probe.mjs "本を読みませんでした。"
//
// The sweep answers this for a corpus and takes ~800ms per sentence to do it;
// this answers it for ONE line in about ten seconds, which is what you want when
// a divergence report names a sentence and you need the other engine's side of
// it. Pair with `bin/rails runner` on the web side for the same text, and with
// `POST /api/v1/words/identify` for the candidate order: the two lists are meant
// to come out the same (docs/specs/extension-parsing.md §3).
const text = process.argv[2] ?? "本を読みませんでした。";
(async () => {
  const pack = realPackPath();
  if (!pack) throw new Error("no dictionary pack");
  const kept = subsetPack(pack, [ text ]);
  await installTestPack(packPayload(kept), { contentRevision: "probe", terms: kept.length - 1 });
  const tokens = await parseOffline(text, [ "eng" ], "https://shirabe.test");
  for (const token of tokens) {
    process.stdout.write(`@@ ${token.surface}  lemma=${token.lemma}  entry=${token.entry ?? "nil"}\n`);
    // Best first, the chosen word at the head. Absent means the span names one
    // word, so there was nothing to ask.
    for (const candidate of token.candidates ?? []) {
      process.stdout.write(`     - ${candidate.headword} (${candidate.reading ?? "?"})`
        + `  ${candidate.entry}${candidate.common ? "  common" : ""}\n`);
    }
  }
})();
