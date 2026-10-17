# Shirabe Reader

Shirabe Reader is the GPL-3.0 browser extension for Shirabe. Source lives here. The Rails backend lives in `lostcoords/shirabe`; API and card packages live in `lostcoords/shirabe-sdk`.

Use Jujutsu when `.jj/` exists. Use dav-mode only when the user explicitly requests it. Preserve other agents' work.

## Commands

- `npm ci` installs pinned dependencies.
- `npm run check` checks browser source and test types.
- `npm test` runs the Node suites and watcher checks.
- `npm run build:firefox` and `npm run build:chrome` build production packages.
- `npm run watch:chrome` watches source without launching or controlling a browser.
- `npm run verify:installed:chrome` runs the installed-extension harness in headless Chromium.
- `npm run package:firefox` and `npm run package:chrome` verify and package production output. Set `POSTHOG_PROJECT_TOKEN` for production packaging.

## Boundaries

Consume released `@shirabe-org/api` and `@shirabe-org/card` packages. `npm run sdk:link` temporarily links a sibling SDK for local work; `npm ci` restores registry packages.

Language resources and tokenizer corpus snapshots are imported from Shirabe. Run `bin/reader sync-contract` in Shirabe to update them, and `bin/reader check-contract` there to verify equality. Commit both repositories when these inputs change.

A real dictionary pack is optional for the default fixture suite. Set `SHIRABE_PACK` to its absolute path for the complete corpus. Rails parity scripts accept `SHIRABE_PATH`; combined audits accept `SHIRABE_WEB_AUDIT` and divergence sweeps accept `SHIRABE_WEB_EXPORT`.

## Shared desktop

Prefer APIs, CLIs, and headless tests. Do not activate native apps or send system-wide input without explicit permission. Preserve the user's clipboard and do not play test audio. Use the configured browser skill for visible browser work and stay in its owned session.

`tools/pack-builder` owns the Ruby offline pack writer. Run its standalone tests with `BUNDLE_GEMFILE=tools/pack-builder/Gemfile bundle exec ruby -Itools/pack-builder/lib tools/pack-builder/test/builder_test.rb`. Rails owns source queries and permissions; this library must not import Rails or ActiveRecord.
