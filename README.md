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

- **One-click login** — click **Connect**, a sign-in window opens, you approve
  access, and it closes on its own (OAuth 2.0 + PKCE via
  `identity.launchWebAuthFlow`; no code to copy, nothing to poll). Pasting a key
  by hand still works under _Advanced_ for scripts/CI. The minted key is scoped
  and revocable.
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

## Develop with hot reload

```bash
npm run dev            # Firefox
npm run dev:chrome     # Chrome / Chromium
```

`dev` runs the esbuild watcher **and** launches a browser (via [`web-ext`]) with
the extension loaded, opened on a Japanese page. **Launch it once and leave it
open** — edits hot-reload in place, no relaunch:

- **TS** (background / content / popup logic) → esbuild rebuilds `dist/<target>`
  → `web-ext` reloads the extension.
- **CSS, popup HTML, icons, `manifest.base.json`** → `build.mjs` re-syncs them
  into `dist/<target>` on change, so those hot-reload too.

Content-script changes re-register on reload, so **refresh the tab (`Cmd/Ctrl+R`)**
to re-inject them into already-open pages; background-worker and popup changes
apply immediately.

The dev browser uses a **persistent profile** (`.web-ext-profile/`, gitignored),
so you sign in and approve the extension **once** — your login and connection
survive restarts. Dev/watch builds also default the **API server** to
`https://shirabe.localhost` (production builds → `https://shirabe.org`), so you
just click **Connect** (the API is on every host, no `api.` subdomain). Firefox
launches with `security.enterprise_roots.enabled=true` so its cert store trusts
the `rb-portless` dev CA from your OS keychain (Chrome uses the keychain already).
To point at a different server, override it under **Advanced** once signed in.

[`web-ext`]: https://github.com/mozilla/web-ext

## Load it (Firefox)

1. `npm run build:firefox`
2. Go to `about:debugging#/runtime/this-firefox` → **Load Temporary Add-on…**
3. Select `dist/firefox/manifest.json`.

For Chrome: `chrome://extensions` → enable Developer mode → **Load unpacked** →
choose `dist/chrome`.

## Configure

1. Click the extension icon → **Connect to Shirabe**. A sign-in window opens;
   sign in (if needed) and approve access — it closes on its own and the popup
   flips to _Connected as …_. The extension never sees your password, only a
   scoped, revocable API key it exchanges for itself (OAuth 2.0 + PKCE).
2. Pick a **definition language** and whether the popup shows on hover or on
   **Alt/Option + hover**.
3. Open a Japanese page and hit **Parse this page** (or enable _Parse pages
   automatically_).

Alternatively, open **Advanced** and paste a key made with
`bin/rails api_keys:create` instead of connecting. Either way the key is stored
in extension-local storage and sent as `Authorization: Bearer …`. `/v1/*` allows
cross-origin requests (`config/initializers/cors.rb`), so no extra setup is
needed. (For local dev the API server already defaults to `https://shirabe.localhost`
— see _Develop with hot reload_.)

## Architecture

```
src/
  common/
    browser.ts    one promise-based `ext` for Firefox + Chrome
    api.ts        ShirabeApi — parse, search→Definition, save/grade, OAuth login
    config.ts     settings persisted in storage.local
    messages.ts   typed content ↔ background protocol
    types.ts      ParsedToken, Definition, WordState
  background/
    background.ts owns the key + OAuth redirect login; rate-limits + caches
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

## Parsing engine

The full architecture for the parsing pipeline — how text is collected into
paragraphs/fragments, batched, parsed, and mapped back onto the DOM — plus the
reference study of jiten/JitenReader and the phased build plan, lives in
[`docs/specs/extension-parsing.md`](../docs/specs/extension-parsing.md).

## Roadmap

- **Done:** batched parsing — one `/v1/parse` request per ~8k-char batch instead
  of per text node.
- Paragraph/fragment rewrite + array `/v1/parse` (correct tokenization across
  inline elements, shared vocab) — see the parsing-engine doc.
- Custom parsers via observer primitives — **YouTube captions first**, then
  Netflix / manga, reusing this lookup core.
- Pitch-accent + frequency in the popup (via `POST /v1/parse` `include`).
- An advanced mining dialog (editable sentence + translation) and per-deck
  targeting.
