import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bundleTests } from "../test/support/bundle.mjs";

// Usage: npm run fixture-pack -- <full pack .ndjson.gz> [text…]
const dir = mkdtempSync(join(tmpdir(), "shirabe-fixture-pack-"));
try {
  const bundles = await bundleTests(["test/support/fixture-pack.ts"], dir);
  execFileSync(process.execPath, [bundles["test/support/fixture-pack.ts"], ...process.argv.slice(2)], { stdio: "inherit" });
} finally {
  rmSync(dir, { recursive: true, force: true });
}
