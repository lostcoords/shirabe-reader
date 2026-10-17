// Divergence discovery between the two tokenizers.
//
// The cross-engine corpus (test/tokenizer_eval/cross_engine.yml) only contains
// differences someone thought to look for. This sweeps a large slice of REAL
// sentences through the extension parser and diffs against the web's answer,
// surfacing the divergences nobody predicted: ranked by how often they occur, so
// the frequent ones get fixed first.
//
//   bin/rails tokenizer_eval:export[8000]     # from the repo root: writes tmp/tokenizer_web.json
//   node test/divergence-sweep.mjs            # from the Reader root: diffs and reports
//   node test/divergence-sweep.mjs 500        # a quicker slice
//   node test/divergence-sweep.mjs 8000 1     # single process, no fan-out
//
// Divergence is EXPECTED: the engines segment at different granularity by
// design. The signal to act on is a lemma disagreement (which forks the SRS
// card) or a content word one engine finds and the other shatters.
//
// Runs one process per core by default. The cost is `parseOffline` at ~800ms a
// sentence (~100x what the extension does warm in a browser: the harness runs on
// fake-indexeddb), and it is embarrassingly parallel, while the subset and
// install are seconds. Each shard takes every Nth row, so all of them see the
// same mix of easy and hard lines and a shard's numbers mean the same as the
// whole run's.
import { build } from "esbuild";
import { execFile } from "node:child_process";
import { availableParallelism } from "node:os";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mergeShard } from "./support/sweep-merge.mjs";

const WEB_EXPORT = process.env.SHIRABE_WEB_EXPORT ?? "tmp/tokenizer_web.json";
const LIMIT = Number(process.argv[2] ?? 0) || Infinity;
const SHARDS = Number(process.argv[3] ?? 0) || Math.max(1, Math.min(availableParallelism() - 2, 12));
const run = promisify(execFile);

if (!existsSync(WEB_EXPORT)) {
  console.error(`No web export at ${WEB_EXPORT}. Run: bin/rails tokenizer_eval:export[8000]`);
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
      __DEFAULT_API_BASE__: JSON.stringify("private"),
      __SHIRABE_OFF_HOSTS__: JSON.stringify([]),
    },
  });

  if (SHARDS === 1) {
    await run(process.execPath, [outfile, String(LIMIT)], { env: { ...process.env, SWEEP_RUN: "1" }, maxBuffer: 1 << 28 })
      .then(({ stdout }) => process.stdout.write(stdout));
  } else {
    process.stdout.write(`Sweeping across ${SHARDS} processes…\n`);
    const started = Date.now();
    const shards = await Promise.all(Array.from({ length: SHARDS }, async (_unused, index) => {
      const out = join(dir, `shard-${index}.json`);
      await run(process.execPath, [outfile, String(LIMIT), String(index), String(SHARDS)],
                { env: { ...process.env, SHARD_OUT: out, SWEEP_RUN: "1" }, maxBuffer: 1 << 28 });
      return JSON.parse(readFileSync(out, "utf8"));
    }));
    process.stdout.write(`Done in ${Math.round((Date.now() - started) / 1000)}s.\n\n`);

    // Print through the runner's own reporter so a sharded run and a single one
    // cannot drift into saying different things about the same numbers.
    const { printReport } = await import(`file://${outfile}`);
    const report = (title, entries, top) => {
      const sorted = [...entries].sort((a, b) => b[1].count - a[1].count);
      process.stdout.write(`\n${title}: ${entries.length} distinct, showing top ${Math.min(top, sorted.length)}\n`);
      for (const [key, { count, example }] of sorted.slice(0, top)) {
        process.stdout.write(`  ${String(count).padStart(4)}×  ${key}\n          e.g. ${example}\n`);
      }
    };
    printReport(shards.reduce(mergeShard, {}), report);
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
