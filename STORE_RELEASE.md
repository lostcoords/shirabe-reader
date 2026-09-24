# Browser-store release checklist

Package only production `dist/<browser>` output. Never upload the repository,
source maps, a development API host, test fixtures, or a local dictionary pack.

## Before every upload

- **Rebuild and repackage. Never upload what is already in `artifacts/`.** Those
  zips are whatever was built last, and "last" can predate a server change that
  invalidates them. This has already happened once: the zips packaged 2026-08-05
  and the `dist/` built 2026-08-17 both predate the OAuth work (shipped in
  v0.10.0 on 2026-08-19), whose migration revoked every non-manual API key in
  production. Uploading either would have shipped a build holding a credential
  the server no longer honours, broken on first use, with nothing in the build
  itself to show it. Check the version in `package.json` against the credential
  model the server is running, not against this file.
- Run `npm run check`, `npm test`, both production builds, and
  `npm run lint:firefox`.
- Run `npm run package:firefox` and `npm run package:chrome`; upload only the
  resulting browser-specific zip from `artifacts/`.
- Diff both generated manifests against the previous submitted manifests.
  Explain every permission, host-pattern, content-script, CSP, background, and
  web-accessible-resource change in reviewer notes.
- Verify `<all_urls>` is the one required browser grant for page reading.
  Hover lookup must not parse the page. Parse page and Parse selection stay
  explicit commands, while the toolbar can pause a tab or disable a site.
- Confirm no remote executable JavaScript exists. Dictionary packs and
  `/api/v1/reader/host-rules` are schema-validated data only.
- Confirm the popup links to offline data notices and the privacy disclosure.

## Acceptance smoke matrix

Use a fresh Firefox profile and a fresh Chromium/Edge profile. Install the
small test pack, turn the network off before loading the test page, and verify
lookup, popup placement, selection, keyboard/touch behavior, context capture,
and revert on:

- an ordinary Japanese page and Japanese Wikipedia;
- asbplayer over a local video and over a streaming page;
- native Japanese Netflix captions, then Netflix with asbplayer layered on top;
- native Japanese YouTube captions, then YouTube with asbplayer layered on top;
- Mokuro horizontal and vertical OCR text boxes.

At 200% and 400% zoom, repeat popup keyboard navigation and mining preview.
Repeat with reduced motion, forced colors/high contrast, and the color-vision
preset. Confirm offline/auth/network/update failures remain understandable and
never disable an already-installed local dictionary.

Start with unlisted/tester distribution. Public release follows only after this
matrix is recorded for the exact submitted zips.
