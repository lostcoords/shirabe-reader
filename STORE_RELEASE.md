# Browser-store release checklist

Package only production `dist/<browser>` output. Never upload the repository,
source maps, a development API host, test fixtures, or a local dictionary pack.

## Before every upload

- Run `npm run check`, `npm test`, both production builds, and
  `npm run lint:firefox`.
- Run `npm run package:firefox` and `npm run package:chrome`; upload only the
  resulting browser-specific zip from `artifacts/`.
- Diff both generated manifests against the previous submitted manifests.
  Explain every permission, host-pattern, content-script, CSP, background, and
  web-accessible-resource change in reviewer notes.
- Verify the required hosts remain only Shirabe production/development API
  hosts. `<all_urls>` remains optional and is requested per site when the user
  enables automatic parsing; `activeTab` supports an explicit one-page action.
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
- Ttsu Reader in horizontal and vertical modes;
- Mokuro horizontal and vertical OCR text boxes.

At 200% and 400% zoom, repeat popup keyboard navigation and mining preview.
Repeat with reduced motion, forced colors/high contrast, and the color-vision
preset. Confirm offline/auth/network/update failures remain understandable and
never disable an already-installed local dictionary.

Start with unlisted/tester distribution. Public release follows only after this
matrix is recorded for the exact submitted zips.
