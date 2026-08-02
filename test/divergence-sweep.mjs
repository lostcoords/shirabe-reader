// Divergence discovery between the two tokenizers.
//
// The cross-engine corpus (test/tokenizer_eval/cross_engine.yml) only contains
// differences someone thought to look for. This sweeps a large slice of REAL
// sentences through the extension parser and diffs against the web's answer,
// surfacing the divergences nobody predicted: ranked by how often they occur, so
// the frequent ones get fixed first.
//
//   bin/rails tokenizer_eval:export[2000]     # from the repo root: writes tmp/tokenizer_web.json
//   node test/divergence-sweep.mjs            # from extension/: diffs and reports
//
// Divergence is EXPECTED: the engines segment at different granularity by
// design. The signal to act on is a lemma disagreement (which forks the SRS card)
// or a content word one engine finds and the other shatters.

import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const WEB_EXPORT = "../tmp/tokenizer_web.json";
const LIMIT = Number(process.argv[2] ?? 0) || Infinity;

if (!existsSync(WEB_EXPORT)) {
  console.error(`No web export at ${WEB_EXPORT}. Run: bin/rails tokenizer_eval:export[2000]`);
  process.exit(1);
}

const dir = mkdtempSync(join(tmpdir(), "shirabe-sweep-"));
// Same reason as test/run.mjs: track the real manifest, not a literal that rots.
const manifestVersion = JSON.parse(readFileSync(new URL("../manifest.base.json", import.meta.url), "utf8")).version;
const outfile = join(dir, "sweep.cjs");
try {
  await build({
    entryPoints: ["test/divergence-sweep-runner.ts"], bundle: true, platform: "node", format: "cjs", outfile, logLevel: "silent",
    define: {
      __EXTENSION_VERSION__: JSON.stringify(manifestVersion),
      __DEFAULT_API_BASE__: JSON.stringify("https://shirabe.org"),
      __SHIRABE_OFF_HOSTS__: JSON.stringify([]),
    },
  });
  execFileSync(process.execPath, [outfile, String(LIMIT)], { stdio: "inherit" });
} finally {
  rmSync(dir, { recursive: true, force: true });
}
