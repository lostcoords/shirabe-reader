# Shirabe Reader

A browser extension that parses Japanese on any web page and looks it up with
Shirabe — hover any word for its reading and definition, colour it by what you
already know, and mine or review it into your SRS without leaving the page.
Inspired by [jpd-breader] and Yomitan, but backed by Shirabe's own tokenizer
(Sudachi/kabosu) and dictionary.

The extension is the universal front door: people read anywhere on the web and
tag what they already know, without needing a second integration.

[jpd-breader]: https://github.com/max-kamps/jpd-breader

## Status (v1)

What works today against the live `/v1` API:

- **One-click login** with the device-grant flow — click **Connect**, approve
  the code on shirabe.org, done. No copy-pasting keys (still possible under
  *Advanced* for scripts/CI). The minted key is scoped and revocable.
- **Tokenize + wrap** visible Japanese into per-word spans (Sudachi segmentation),
  including content the page loads later (a `MutationObserver` re-parses it).
- **Per-user word-state colouring** — new / learning / due / known, stamped by
  `POST /v1/parse` and recoloured across the whole page after every review.
- **Furigana** on kanji words (toggleable).
- **Hover popup** with headword, reading, and definitions in your chosen
  language (`POST /v1/search`), isolated in a shadow root so it renders the same
  on every site. Show it on plain hover, or only on **Alt/Option + hover**.
- **Mine & review inline** — grade a word **Again / Hard / Good / Easy** (which
  both mines a new card and reviews an existing one via `POST /v1/srs/saves`),
  **＋ Save** without grading, or **✓ Known** to park it. Keyboard shortcuts
  `1`–`4`, `s`, `k` act on whatever word you're hovering, popup or not.
- **On-demand parsing** via the toolbar button, the right-click menu
  ("Parse this page" / "Parse selection"), or automatic on page load.

## Build

Requires Node 18+.

```bash
cd extension
npm install
npm run build:firefox     # → dist/firefox
npm run build:chrome      # → dist/chrome
npm run watch             # rebuild Firefox build on change
```

A single source tree targets both browsers. The only per-browser difference is
the generated `manifest.json` (Firefox MV3 uses a background `scripts` array +
a `gecko` settings block; Chrome MV3 uses a `service_worker`). See `build.mjs`.

## Load it (Firefox)

1. `npm run build:firefox`
2. Go to `about:debugging#/runtime/this-firefox` → **Load Temporary Add-on…**
3. Select `dist/firefox/manifest.json`.

For Chrome: `chrome://extensions` → enable Developer mode → **Load unpacked** →
choose `dist/chrome`.

## Configure

1. Click the extension icon → **Connect to Shirabe**. A Shirabe tab opens
   showing a short code; sign in (if needed) and approve it. The popup flips to
   *Connected as …* on its own. That's it — the extension never sees your
   password, only a scoped, revocable API key it mints for itself.
2. Pick a **definition language** and whether the popup shows on hover or on
   **Alt/Option + hover**.
3. Open a Japanese page and hit **Parse this page** (or enable *Parse pages
   automatically*).

For local dev, open **Advanced** and set the **API server** to
`http://localhost:3000` before connecting; you can also paste a key made with
`bin/rails api_keys:create` instead of using the device flow. The key is stored
in extension-local storage and sent as `Authorization: Bearer …`. `/v1/*` allows
cross-origin requests (`config/initializers/cors.rb`), so no extra setup is
needed.

## Architecture

```
src/
  common/
    browser.ts    one promise-based `ext` for Firefox + Chrome
    api.ts        ShirabeApi — parse, search→Definition, save/grade, device login
    config.ts     settings persisted in storage.local
    messages.ts   typed content ↔ background protocol
    types.ts      ParsedToken, Definition, WordState
  background/
    background.ts owns the key + device-login handshake; rate-limits + caches
  content/
    parser.ts     TreeWalker over text nodes → /v1/parse → wrapped words
    word.ts       renders one token; lemma→spans index for live recolour
    popup.ts      shadow-DOM hover popup; lazy lookup + grade/mine controls
    actions.ts    save / grade / mark-known, shared by popup + keyboard
    content.ts    hover + modifier gating, keyboard shortcuts, MutationObserver
    toast.ts      fleeting feedback for keyboard-driven actions
  action/         toolbar popup = Connect + preferences + Advanced
```

Content scripts never touch the network or storage directly — everything flows
through the background worker, which holds the key, owns the device-login poll
loop (persisted to storage so a suspended MV3 worker resumes it), serializes
requests with a small gap to respect the server's per-minute budget, and caches
parses and lookups (pages re-request the same paragraphs and words constantly).

`POST /v1/parse` returns tokens with UTF-16 positions and a deduped vocab pool
carrying each word's per-user SRS state, so the content script maps offsets
straight onto the DOM and colours words without extra round-trips.

## Roadmap

- Per-block batched parsing (one request per paragraph, not per text node).
- Pitch-accent + frequency in the popup (via `POST /v1/parse` `include`).
- An advanced mining dialog (editable sentence + translation) and per-deck
  targeting.
- Streaming-subtitle integrations (Netflix/YouTube), reusing this lookup core.
