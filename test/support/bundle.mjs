import { build } from "esbuild";
import { readFileSync } from "node:fs";
import { DEV_OFF_HOSTS } from "../../build.mjs";

// Read the real version rather than a literal: a pack declares the minimum
// client it needs, so a stale test version silently fails every install the
// moment MINIMUM_EXTENSION_VERSION is bumped.
const manifestVersion = JSON.parse(readFileSync(new URL("../../manifest.base.json", import.meta.url), "utf8")).version;

/** Bundle TypeScript test entries into CommonJS files Node runs directly, keyed by entry path. */
export async function bundleTests(entries, outdir) {
  await build({
    entryPoints: entries, bundle: true, platform: "node", format: "cjs", outdir, outbase: ".", outExtension: { ".js": ".cjs" }, logLevel: "silent",
    define: {
      __EXTENSION_VERSION__: JSON.stringify(manifestVersion),
      __DEFAULT_API_BASE__: JSON.stringify("https://shirabe.org"),
      // Straight from the builder, so the host matrix under test is the one that
      // ships. Unit tests use the dev list because it exercises the local-dev
      // host rule too; production packages omit only that last entry.
      __SHIRABE_OFF_HOSTS__: JSON.stringify(DEV_OFF_HOSTS),
      // The telemetry sender reads these at module scope; without them the
      // bundle carries bare identifiers and the suite dies on the first import.
      __POSTHOG_HOST__: JSON.stringify("https://posthog.test"),
      __POSTHOG_TOKEN__: JSON.stringify("phc_test"),
      __TELEMETRY_ENV__: JSON.stringify("test"),
      __BUILD_ID__: JSON.stringify("test"),
      __DEV_RELOAD__: "false",
      __DEV_RELOAD_URL__: JSON.stringify(""),
    },
  });
  return Object.fromEntries(entries.map((entry) => [entry, `${outdir}/${entry.replace(/\.ts$/, ".cjs")}`]));
}
