import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { FIXTURE_PACK, FIXTURE_PACK_RECORD, corpusTexts, packPayload, subsetPack, type FixturePackRecord } from "./pack.js";

// Cuts the committed fixture slice from a full pack. It keeps every entry that
// the corpora, the texts the slice was cut for before, and any extra texts
// given here could look up. Run through `npm run fixture-pack -- <pack> [text…]`.

(async () => {
  const [packPath, ...extra] = process.argv.slice(2);
  if (!packPath) throw new Error("usage: npm run fixture-pack -- <full pack .ndjson.gz> [text…]");

  const previous = existsSync(FIXTURE_PACK_RECORD) ? JSON.parse(readFileSync(FIXTURE_PACK_RECORD, "utf8")) as FixturePackRecord : null;
  const texts = [...new Set([...corpusTexts(), ...previous?.texts ?? [], ...extra])].sort();

  // Shirabe writes manifest.json beside the newest pack it built.
  const manifestPath = join(dirname(packPath), "manifest.json");
  const manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, "utf8")) : null;
  if (manifest?.artifact !== basename(packPath)) throw new Error(`${manifestPath} does not describe ${basename(packPath)}`);

  const lines = await subsetPack(packPath, texts);
  const payload = packPayload(lines);
  const record: FixturePackRecord = {
    cutFrom: {
      contentRevision: manifest.contentRevision, builtAt: manifest.builtAt, sources: manifest.sources,
      sha256: createHash("sha256").update(readFileSync(packPath)).digest("hex"),
    },
    texts,
  };
  writeFileSync(FIXTURE_PACK, payload);
  writeFileSync(FIXTURE_PACK_RECORD, `${JSON.stringify(record, null, 2)}\n`);
  console.log(`${FIXTURE_PACK}: ${lines.length - 1} entries for ${texts.length} texts, ${payload.byteLength} bytes`);
})();
