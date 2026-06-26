# Shirabe Reader

A browser extension that parses Japanese on any web page and looks it up with
Shirabe — hover any word for its reading and definition, and (soon) save it to
your SRS or mark it known. Inspired by [jpd-breader] and Yomitan, but backed by
Shirabe's own tokenizer (Sudachi/kabosu) and dictionary.

The extension is the universal front door: people read anywhere on the web and
tag what they already know, without needing a second integration.

[jpd-breader]: https://github.com/max-kamps/jpd-breader

## Status (v0)

What works today against the live `/v1` API:

- **Tokenize + wrap** visible Japanese into per-word spans (Sudachi segmentation).
- **Furigana** on kanji words (toggleable).
- **Hover popup** with headword, reading, and definitions in your chosen
  language, served by `GET /v1/search`.
- **On-demand parsing** via the toolbar button, the right-click menu
  ("Parse this page" / "Parse selection"), or automatic on page load.

Wired on the client but **waiting on server endpoints** (see
[Server endpoints still needed](#server-endpoints-still-needed)):

- Per-user **word-state coloring** (new / learning / known / due).
- **Save to deck** and **mark known** buttons in the popup.

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

1. Create an API key: `bin/rails api_keys:create` in the Shirabe repo.
2. Click the extension icon, paste the key, set the **API server**
   (`http://localhost:3000` for local dev, `https://api.shirabe.org` in prod),
   pick a definition language, and **Save settings**.
3. Open a Japanese page and hit **Parse this page**.

The API key is the only secret; it's stored in extension-local storage and sent
as `Authorization: Bearer …`. `/v1/*` already allows cross-origin requests
(`config/initializers/cors.rb`), so no extra server setup is needed.

## Architecture

```
src/
  common/
    browser.ts    one promise-based `ext` for Firefox + Chrome
    api.ts        ShirabeApi — tokenize, search→Definition, save, setState
    config.ts     settings persisted in storage.local
    messages.ts   typed content ↔ background protocol
    types.ts      ParsedToken, Definition, WordState
  background/
    background.ts owns the API key; rate-limits + LRU-caches all calls
  content/
    parser.ts     TreeWalker over text nodes → /v1/tokenize → wrapped words
    word.ts       renders one token (interactive span / plain text)
    popup.ts      reused hover popup; lazy definition fetch + mining buttons
    content.ts    hover delegation, context-menu commands, auto-parse
  action/         toolbar popup = settings + "parse this page"
```

Content scripts never touch the network or storage directly — everything flows
through the background worker, which holds the key, serializes requests with a
small gap to respect the server's per-minute budget, and caches parses and
lookups (pages re-request the same paragraphs and words constantly).

`/v1/tokenize` returns tokens in order but without character offsets, so the
client recovers `[start, length]` by walking the source string sequentially
(correct even when a surface repeats).

## Server endpoints still needed

To light up state coloring and mining, Shirabe needs these under `/v1`
(API-key auth, same as the others). The client already calls them and degrades
gracefully (shows the error) until they exist:

- `POST /v1/word_states` — `{ lemma, state }` → upsert the caller's state for a
  word. A `WordState` record per `(user, entry)` — state as a resource, not a
  boolean (jpdb-style "known" is distinct from "has an SRS card").
- `POST /v1/saves` — `{ lemma }` → create an SRS card (a `/v1` twin of the
  existing session-auth `saves` controller).
- **Batch state for coloring** — extend `POST /v1/tokenize` (or add
  `POST /v1/word_states/lookup`) to return each token's state for the
  authenticated user in one round-trip, so `parser.ts` can color words without
  N extra calls. This is the main thing standing between v0 and a jpdb-reader
  -level experience.

## Roadmap

- Batch tokenization (one request per block, not per text node).
- Shadow-DOM the popup to fully isolate it from host-page CSS.
- Streaming-subtitle integrations (Netflix/YouTube), reusing this lookup core.
- Pitch-accent display once exposed by the API.
