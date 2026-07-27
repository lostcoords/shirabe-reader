# Shirabe Reader

**License: GPL-3.0.** The deinflection rules and transformer are ported from
Yomitan (via [daidai](https://github.com/davafons/daidai), the same rules the
website uses to name inflections), which is GPL-3.0 — so this extension is too,
and its source is published. This covers the extension only: the Shirabe web app
and API are separate works, are not distributed with it, and are not GPL. See
[`LICENSE`](LICENSE) and [`NOTICE`](NOTICE).

A browser extension that parses Japanese on any web page and looks it up with
Shirabe — hover any word for its reading and definition, colour it by what you
already know, and mine or review it into your SRS without leaving the page.
Inspired by [jpd-breader] and Yomitan, but backed by Shirabe's own tokenizer
(Sudachi/kabosu) and dictionary.

The extension is the universal front door: people read anywhere on the web and
tag what they already know, without needing a second integration.

[jpd-breader]: https://github.com/max-kamps/jpd-breader

## Product boundary

Normal lookup and page parsing are free, local, and offline after installing the
maintained Shirabe EN/ES dictionary pack. Connecting an account is optional;
**Pro + online** adds exact-context sentence mining, FSRS grading, deck selection,
sync, and knowledge-state colouring. Full product spec:
[`docs/specs/browser-extension.md`](../docs/specs/browser-extension.md).

## Status (v1)

What works in the current build:

- **Atomic offline dictionary install/update** — compressed, checksummed pack;
  staged IndexedDB generations keep the previous dictionary on corruption or
  interruption. The **Dictionary** tab shows version, size, progress, removal, and
  credits.
- **Phone-shaped popup** — a bottom navigation bar over three panels: **Search**
  (typed lookup + history), **Page** (parse, reader entry points, per-site mode),
  and **Dictionary** (pack + optional account). **Settings** opens a full options
  page in its own tab (reading preferences, shortcuts, Advanced), the way Yomitan
  splits popup from settings.
- **Local lookup and parsing** — Shift-hover scanning without page rewrites,
  typed/selection lookup, EN/ES glosses in your account's language order, local
  prefix segmentation, and readable deinflection paths named exactly as the
  website names them. Words and kanji are separate corpora, as on the web: a word
  search never answers with a kanji; the popup's kanji strip is the explicit
  breakdown.

- **One-click login** — click **Connect**, a sign-in window opens, you approve
  access, and it closes on its own (OAuth 2.0 + PKCE via
  `identity.launchWebAuthFlow`; no code to copy, nothing to poll). Pasting a key
  by hand still works under _Settings → Advanced_ for scripts/CI. The key is scoped
  and revocable.
- **Tokenize + wrap** visible Japanese into per-word spans locally,
  including content the page loads later (a `MutationObserver` re-parses it).
- **Per-user word-state colouring** — new / learning / due / known, stamped by
  `POST /v1/parse` and recoloured across the whole page after every review.
- **Furigana** on kanji words (toggleable).
- **Part-of-speech colouring** — the site's own groups and hues (nouns blue, verbs
  green, adjectives orange, …) on the word or on its underline. One cue system
  covers every surface: a subtitle shows exactly what a paragraph shows.
- **Hover popup** with headword, reading, and definitions in your chosen
  language from IndexedDB, isolated in a shadow root so it renders the same
  on every site. Show it on plain hover, or only on **Alt/Option + hover**.
- **Mine inline** — **＋ Save** creates a card, **✓ Known** parks it, and a word
  you already study offers **Manage**, the same control its dictionary result
  carries on the site. Grading is deliberately not here: reviewing wants the
  history and interval previews around it, so it stays where they are. The row is
  wired but not rendered — see `REVIEW_IN_READER` in `src/content/actions.ts`.
- **Automatic local parsing** whenever the reader is on. The right-click menu
  can reparse a page or parse a selection explicitly.
- **Page awareness** — coverage and known/learning/unknown/due counts, i+1
  paragraph highlighting, occurrence/unique coverage, a toolbar badge,
  and Pause/Reparse/Revert controls.
- **asbplayer subtitles** — when [asbplayer](https://github.com/asbplayer/asbplayer)
  is injecting JP subs (streaming or `app.asbplayer.dev`), lines are tokenized
  for hover/save the same way as page text. No Anki required for lookups; clip
  mining still goes through asbplayer→Anki until a Shirabe media ingress lands.
- **Target surfaces** — ordinary pages and Wikipedia, native YouTube captions,
  native Netflix timed text, Ttsu Reader novel pages, and Mokuro OCR text boxes
  each have an explicit dynamic parser and maintained DOM fixture. asbplayer can
  remain layered over Netflix or YouTube.

## Build

Requires Node 22.12+ (the version pinned by the repository).

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
the extension loaded, opened on a Japanese page. It first builds a small local
dictionary pack automatically, so **Install dictionary** works without a separate
pack-build command. Keep `bin/dev` running from the repository root; restart it
after changing middleware or boot configuration. **Launch the extension once and leave it
open** — edits hot-reload in place, no relaunch:

- **TS** (background / content / popup logic) → esbuild rebuilds `dist/<target>`
  → `web-ext` reloads the extension.
- **CSS, popup HTML, icons, `manifest.base.json`** → `build.mjs` re-syncs them
  into `dist/<target>` on change, so those hot-reload too.

When a dev watcher is running, use `npm run verify:build:firefox` or
`npm run verify:build:chrome` for a separate one-shot build. The regular
production build writes to the live `dist/<target>` directory and would replace
the watch manifest, including its localhost permission.

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
To point at a different server, override it under **Settings → Advanced**.

[`web-ext`]: https://github.com/mozilla/web-ext

## Develop in your own Firefox

`npm run dev` launches its own browser profile. To work in the Firefox you
already use — your tabs, logins, and other add-ons — attach a temporary add-on
to it instead and let it reload itself:

```bash
npm run dev:attach     # same watcher, no browser launch
```

One-time setup in that Firefox:

1. `about:config` → set `security.enterprise_roots.enabled` to `true`, so
   Firefox trusts the `rb-portless` dev CA and `https://shirabe.localhost` works.
2. `about:debugging#/runtime/this-firefox` → **Load Temporary Add-on…** →
   select `extension/dist/firefox/manifest.json`.

From then on every save rebuilds, and the add-on console logs `rebuilt` — hit
**Reload** on the add-on's card in `about:debugging` to pick it up. The watcher
runs a small event stream on `http://127.0.0.1:8473/reload` that watch builds
subscribe to (`src/background/dev-reload.ts`); it announces the rebuild but does
not reload the extension for you. `runtime.reload()` is the only lever a page
has, and it is not established that it reloads a _temporary_ add-on rather than
removing it — and nothing outside can do it either, since `web-ext` only attaches
to a Firefox it launched itself. As with `npm run dev`, refresh the tab to
re-inject content-script changes.

Two things to know: a temporary add-on is gone after you quit Firefox, so step 2
repeats each session, and the watch build carries the `reader-dev@shirabe.org`
add-on ID, so it lives alongside a store-installed Shirabe Reader instead of
replacing it. Chrome has no equivalent — its MV3 service worker can't hold the
event-stream connection, so `dev:chrome` stays on web-ext.

## Load it (Firefox)

1. `npm run build:firefox`
2. Go to `about:debugging#/runtime/this-firefox` → **Load Temporary Add-on…**
3. Select `dist/firefox/manifest.json`.

For Chrome: `chrome://extensions` → enable Developer mode → **Load unpacked** →
choose `dist/chrome`.

## Configure

1. Click the extension icon → **Dictionary** → **Install dictionary**. Lookup then
   works without an account or network connection.
2. Optionally, on the same tab, click **Connect Pro account**. A sign-in window
   opens; sign in (if needed) and approve access — it closes on its own and the
   panel flips to _Connected as …_. The extension never sees your password, only a
   scoped, revocable API key it exchanges for itself (OAuth 2.0 + PKCE).
3. Open **Settings** (bottom bar) to pick a **definition language** and scan
   modifier (Shift by default).
4. Open a Japanese page. Shirabe parses it locally while the reader toggle is on.

Alternatively, open **Settings → Advanced** and paste a key made with
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
    offline-dictionary.ts  IndexedDB pack install, lookup, deinflection, parsing
    api.ts        connected state, save/grade/decks, OAuth login
    config.ts     settings persisted in storage.local
    messages.ts   typed content ↔ background protocol
    types.ts      ParsedToken, Definition, WordState
  background/
    background.ts owns the key + OAuth redirect login; rate-limits + caches
  content/
    parser.ts     paragraph/fragments → local parse → token spans
    word.ts       renders one token; lemma→spans index for live recolour
    popup.ts      shadow-DOM hover popup; lazy lookup + grade/mine controls
    actions.ts    save / grade / mark-known, shared by popup + keyboard
    content.ts    hover + modifier gating, keyboard shortcuts, MutationObserver
    toast.ts      fleeting feedback for keyboard-driven actions
  action/         toolbar popup = Connect + preferences + Advanced
```

Content scripts never touch storage or remote APIs directly. The background
worker owns the offline dictionary, scoped key, state hydration, connected
writes, and caches. Installed-pack lookup and local page parsing send no page
text. If no pack is installed, the extension installs/repairs it and reports
progress; it never uploads the page as a parsing fallback. URL/title/sentence
context is sent only on an explicit save action.

## Parsing engine

The full architecture for the parsing pipeline — how text is collected into
paragraphs/fragments, batched, parsed, and mapped back onto the DOM — plus the
reference study of jiten/JitenReader and the phased build plan, lives in
[`docs/specs/extension-parsing.md`](../docs/specs/extension-parsing.md).

Release and browser-store operations live in
[`docs/specs/browser-extension.md`](../docs/specs/browser-extension.md#10-store-release-and-update-velocity).
