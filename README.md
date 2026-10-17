# Shirabe Reader

Read Japanese across the web with offline dictionary lookup, furigana, and vocabulary mining for [Shirabe](https://shirabe.org).

Shirabe Reader supports Firefox and Chromium browsers from one source tree. Lookup and local page parsing work without an account after installing a dictionary pack. Connecting a Shirabe account adds personal dictionaries and study state; saving words requires Pro.

The Reader works with ordinary pages, YouTube and Netflix subtitles, asbplayer, and Mokuro OCR text.

## Build and install

Use Node 24 or newer.

```sh
npm ci
npm run build:firefox
npm run build:chrome
```

In Firefox, open `about:debugging#/runtime/this-firefox`, select **Load Temporary Add-on**, and choose `dist/firefox/manifest.json`.

In Chrome or Brave, open the extensions page, enable **Developer mode**, select **Load unpacked**, and choose `dist/chrome`.

Open the toolbar popup, select **Dictionary**, and install the dictionary. You can then hover Japanese words without a network connection. Connect your account there to enable personal features.

## Develop

```sh
npm run watch:chrome
```

The watcher builds into `dist/chrome` against `https://shirabe.localhost`. Start the Shirabe backend separately if you want to test against it. To use the deployed API instead:

```sh
npm run watch:chrome -- --api=https://shirabe.org
```

Load `dist/chrome` once as an unpacked extension. Later saves rebuild scripts and static assets, then publish a stamp on `http://127.0.0.1:4188/build.json` so the extension can reload itself. Refresh an open page to load its new content script. The watcher does not start or control your browser.

While a watcher is running, use `npm run verify:build:chrome` or `npm run verify:build:firefox` for separate one-shot builds. Regular builds overwrite `dist/<browser>`.

### Work on the SDK

The API client and word card come from the public [Shirabe SDK](https://github.com/lostcoords/shirabe-sdk). To test local SDK changes:

```sh
npm run sdk:link
```

The default checkout is `../shirabe-sdk`. Pass another checkout after `--` if needed. This builds and links both packages without changing the Reader manifest or lockfile. Run the SDK watcher in its own checkout, or use Shirabe's `bin/sdk watch`, to rebuild after edits. The Reader watcher picks up those rebuilt modules. Run `npm ci` to restore published packages.

## Verify

```sh
npm run check
npm test
npm run build:firefox
npm run build:chrome
npm run lint:firefox
```

The default suite runs local fixtures. To run the full tokenizer corpus against a generated dictionary pack, set `SHIRABE_PACK` to the absolute path of its `.ndjson.gz` file.

For the installed Chromium checks:

```sh
npx playwright install chromium
npm run verify:installed:chrome
```

Shirabe owns the canonical language tables and shared evaluation corpora. This repository vendors their exported snapshots so builds and fixture tests need no Rails checkout. In Shirabe, run `bin/reader check-contract` to check those inputs or `bin/reader sync-contract` to update them. Set `SHIRABE_READER_PATH` there when this repository is not its sibling.

The Rails parity scripts use `SHIRABE_PATH`, defaulting to `../shirabe`. Set `SHIRABE_WEB_AUDIT` to a backend contextual audit report or `SHIRABE_WEB_EXPORT` to a divergence-sweep export when running those cross-engine checks.

## Release

Follow [the browser-store checklist](STORE_RELEASE.md). Set `POSTHOG_PROJECT_TOKEN` before building production packages. CI reads this public write-only project token from the repository variable of that name.

```sh
npm run package:firefox
npm run package:chrome
```

Upload the corresponding zip from `artifacts/<browser>/`. [Store listing copy](STORE_LISTING.md) contains descriptions and permission explanations. Publish the matching source tag for each distributed version.

## License

[GPL-3.0](LICENSE). [NOTICE](NOTICE) lists Yomitan and daidai attribution. Downloaded dictionary packs carry their own licenses, separately from the extension.

The portable dictionary pack writer lives in [`tools/pack-builder`](tools/pack-builder). Rails supplies authorized dictionary records; this library owns Reader’s offline archive format.
