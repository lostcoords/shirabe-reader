# Shirabe Reader

**License: GPL-3.0.** The deinflection rules and transformer are ported from
Yomitan (via [daidai](https://github.com/davafons/daidai), the same rules the
website uses to name inflections), which is GPL-3.0: so this extension is too,
and its source is published. This covers the extension only: the Shirabe web app
and API are separate works, are not distributed with it, and are not GPL. See
[`LICENSE`](LICENSE) and [`NOTICE`](NOTICE).

A browser extension that parses Japanese on any web page and looks it up with
Shirabe: hover any word for its reading and definition, colour it by what you
already know, and mine or review it into your SRS without leaving the page.
Inspired by [jpd-breader] and Yomitan, but backed by Shirabe's own tokenizer
(Sudachi/kabosu) and dictionary.

The extension is the universal front door: people read anywhere on the web and
tag what they already know, without needing a second integration.

[jpd-breader]: https://github.com/max-kamps/jpd-breader

## Product boundary

Normal lookup and page parsing work offline after installing the maintained
Shirabe EN/ES dictionary pack. Stable page text can also use the public `/parse`
API to refine token boundaries. This is free and does not require an account.
Settings can keep all analysis local. Connecting an account is optional;
**Pro** adds exact-context sentence mining, FSRS grading, deck selection,
sync, and knowledge-state colouring. Full product spec:
[`docs/specs/browser-extension.md`](../docs/specs/browser-extension.md).

## Status (v1)

What works in the current build:

- **Atomic offline dictionary install/update**: compressed, checksummed pack;
  staged IndexedDB generations keep the previous dictionary on corruption or
  interruption. The **Dictionary** tab shows version, size, progress, removal, and
  credits.
- **Phone-shaped popup**: a bottom navigation bar over three panels: **Search**
  (typed lookup + history), **Page** (parse, reader entry points, per-site mode),
  and **Dictionary** (pack + optional account). **Settings** opens a full options
  page in its own tab (reading preferences, shortcuts, Advanced), the way Yomitan
  splits popup from settings.
- **Local lookup and parsing**: Shift-hover scanning without page rewrites,
  typed/selection lookup, EN/ES glosses in your account's language order, local
  prefix segmentation, and readable deinflection paths named exactly as the
  website names them. Words and kanji are separate corpora, as on the web: a word
  search never answers with a kanji; the popup's kanji strip is the explicit
  breakdown.

- **One-click login**: click **Connect**, a sign-in window opens, you approve
  access, and it closes on its own (OAuth 2.0 + PKCE via
  `identity.launchWebAuthFlow`; no code to copy, nothing to poll). If you are not
  signed in yet, that window signs you in first: Google finishes inside it, and a
  magic link is sent to your own browser with a Continue button waiting here. The
  key is scoped and revocable.
- **Offline cursor lookup**: read Japanese under the pointer with the local
  dictionary, including deinflection, candidate matching, and definitions,
  without wrapping or uploading page text.
- **Optional online analysis**: stable page text is parsed locally first. When
  allowed, the public API can refine its token boundaries if the installed pack
  and active dictionary sources still match. Live subtitles stay local.
- **Furigana** on kanji words (toggleable).
- **Part-of-speech colouring**: the site's own groups and hues (nouns blue, verbs
  green, adjectives orange, …) on the word or on its underline. One cue system
  covers every surface: a subtitle shows exactly what a paragraph shows.
- **Hover popup** with headword, reading, and definitions in your chosen
  language from IndexedDB, isolated in a shadow root so it renders the same
  on every site. Show it on plain hover, or only on **Alt/Option + hover**.
  Hovering reads only the word under the pointer; parsing a whole page is an
  explicit action. One browser permission enables reading across ordinary
  sites, with controls to pause a page or turn the reader off for a site.
- **Mine inline**: **＋ Save** creates a card, **✓ Known** parks it, and a word
  you already study offers **Manage**, the same control its dictionary result
  carries on the site. Grading is deliberately not here: reviewing wants the
  history and interval previews around it, so it stays where they are. The row is
  wired but not rendered: see `REVIEW_IN_READER` in `src/content/actions.ts`.
- **Page and selection parsing** without an account. The right-click menu can
  reparse a page or parse a selection explicitly. A page can be paused without
  changing its saved site rule.
- **Page awareness**: coverage and known/learning/unknown/due counts, i+1
  paragraph highlighting, occurrence/unique coverage, a toolbar badge,
  and Pause/Reparse/Revert controls.
- **asbplayer subtitles**: when [asbplayer](https://github.com/asbplayer/asbplayer)
  is injecting JP subs (streaming or `app.asbplayer.dev`), lines are tokenized
  for hover/save the same way as page text. No Anki required for lookups; clip
  mining still goes through asbplayer→Anki until a Shirabe media ingress lands.
- **Target surfaces**: ordinary pages and Wikipedia, native YouTube captions,
  native Netflix timed text, and Mokuro OCR text boxes
  each have an explicit dynamic parser and maintained DOM fixture. asbplayer can
  remain layered over Netflix or YouTube.

## Build

Requires Node 22.12+ (the version pinned by the repository).

```bash
cd extension
npm install
npm run build:firefox     # → dist/firefox
npm run build:chrome      # → dist/chrome
```

A single source tree targets both browsers. The only per-browser difference is
the generated `manifest.json` (Firefox MV3 uses a background `scripts` array +
a `gecko` settings block; Chrome MV3 uses a `service_worker`). See `build.mjs`.

## Develop in everyday Brave

Keep `bin/dev` running from the repository root, then start the only development
watcher:

```bash
cd extension
npm run watch:chrome
```

It builds into `dist/chrome` and rebuilds TypeScript, CSS, HTML, and icons on
save. The popup uses Tailwind utilities compiled into a local stylesheet;
there is no runtime CSS dependency. Popup and Settings share
`src/common/theme.css` for colors. Watch builds use `https://shirabe.localhost`;
production builds use `https://shirabe.org`.

One-time setup in your everyday Brave profile:

1. Open `brave://extensions` and enable **Developer mode**.
2. Click **Load unpacked** and choose `extension/dist/chrome` in this repository.
3. Disable any store-installed Shirabe Reader while testing, so two copies do
   not parse the same page.
4. Open the extension's **Dictionary** tab and install the dictionary.

If the local server has no dictionary pack yet, run
`bin/rails dictionary_packs:ensure` from the repository root once. The watcher
only rebuilds the extension, not dictionary data.

After each rebuild, click the extension's **Reload** arrow in
`brave://extensions`. Reopen the popup or settings to see changes there. Refresh
Japanese pages to re-inject changed content scripts.

The watcher does not launch, restart, or control Brave. This is automatic
rebuilding, not automatic browser reload. The unpacked extension, its dictionary,
and its account connection stay in your everyday profile across browser restarts.

For a one-shot build while the watcher is running, use
`npm run verify:build:chrome` or `npm run verify:build:firefox`. Regular production
builds write into `dist/<target>` and would overwrite the watched build, including
its localhost permission.

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
   opens; sign in (if needed) and approve access: it closes on its own and the
   panel flips to _Connected as …_. The extension never sees your password, only a
   scoped, revocable API key it exchanges for itself (OAuth 2.0 + PKCE).
3. Open **Settings** (bottom bar) to pick a **definition language** and scan
   modifier (Shift by default).
4. Open a Japanese page. Reader sites parse locally when enabled. Stable text
   may receive a matching online parse afterward; the local-only setting disables
   that request.

Connecting is the only way in: there is no paste-a-key pane, because a key
minted by hand carries the wrong scopes for the reader and cannot be revoked
from the browser that holds it. The key is stored
in extension-local storage and sent as `Authorization: Bearer …`. `/api/v1/*` allows
cross-origin requests (`config/initializers/cors.rb`), so no extra setup is
needed. (For local dev the API server already defaults to `https://shirabe.localhost`:
see _Develop with hot reload_.)

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
    parser.ts     paragraph/fragments → local spans → optional online refinement
    word.ts       renders one token; lemma→spans index for live recolour
    popup.ts      shadow-DOM hover popup; lazy lookup + grade/mine controls
    actions.ts    save / grade / mark-known, shared by popup + keyboard
    content.ts    hover + modifier gating, keyboard shortcuts, MutationObserver
    toast.ts      fleeting feedback for keyboard-driven actions
  action/         toolbar popup = Connect + preferences + Advanced
```

Content scripts never touch storage or remote APIs directly. The background
worker owns the offline dictionary, scoped key, state hydration, connected
writes, and caches. Lookup and live subtitle parsing stay local. Stable page
text can be sent to `/api/v1/parse` after local parsing unless local-only
analysis is selected. If no pack is installed, the extension installs or
repairs it and reports progress. URL and title are sent on an explicit save
action, along with the selected sentence.

## Parsing engine

The full architecture for the parsing pipeline: how text is collected into
paragraphs/fragments, batched, parsed, and mapped back onto the DOM: plus the
reference study of jiten/JitenReader and the phased build plan, lives in
[`docs/specs/extension-parsing.md`](../docs/specs/extension-parsing.md).

Release and browser-store operations live in
[`docs/specs/browser-extension.md`](../docs/specs/browser-extension.md#10-store-release-and-update-velocity).
