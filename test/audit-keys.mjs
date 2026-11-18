import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bundleTests } from "./support/bundle.mjs";

const directory = mkdtempSync(join(tmpdir(), "shirabe-audit-keys-"));
try {
  const { "test/audit-keys.ts": bundle } = await bundleTests(["test/audit-keys.ts"], directory);
  execFileSync(process.execPath, [bundle, ...process.argv.slice(2)], { stdio: "inherit" });
} finally {
  rmSync(directory, { recursive: true, force: true });
}
