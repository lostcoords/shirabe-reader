# Store listing copy — Shirabe Reader

Paste-ready text for the Firefox Add-ons (AMO) and Chrome Web Store dashboards.
Keep this file in sync with what's actually submitted; reviewers compare against
the previous submission on every update.

Packaging steps live in [`STORE_RELEASE.md`](STORE_RELEASE.md). Build the zips
with `npm run package:firefox` / `npm run package:chrome` and upload only the
artifact from `artifacts/<browser>/`.

---

## Name

Shirabe Reader

## Summary (AMO ≤250 chars · Chrome ≤132 chars)

**Short (Chrome, 118 chars):**

> Read Japanese anywhere. Hover any word for its reading and meaning, and save it straight into your reviews.

**Long (AMO, 233 chars):**

> Read Japanese on any web page. Hover a word to see its reading and meaning, coloured by what you already know, and save it into spaced-repetition reviews without leaving the page. Works offline after a one-time dictionary install.

## Category

- Firefox: _Language Support_ (secondary: _Other_)
- Chrome: _Education_

## Description

> **Read Japanese anywhere on the web.**
>
> Shirabe Reader parses Japanese text on any page and gives you the reading and
> meaning of any word you hover — including inflected forms, which it traces back
> to the dictionary entry they came from.
>
> **Works offline.** Install the dictionary pack once and lookup keeps working
> with no network and no account. Nothing about ordinary reading requires signing
> in.
>
> **See what you already know.** Connect a Shirabe account and words are coloured
> by your own knowledge state — new, learning, or known — so you can see at a
> glance whether a page is at your level.
>
> **Save words as you read.** One click turns a word into a flashcard with its
> reading, pitch accent, audio, and the exact sentence you found it in. Reviews
> use FSRS, a modern spaced-repetition algorithm.
>
> **Reads real sites.** Ordinary web pages and Japanese Wikipedia, Netflix and
> YouTube subtitles, asbplayer, ttsu Reader, and Mokuro manga OCR.
>
> Lookup and page parsing are free. A Shirabe Pro account adds sentence mining,
> grading, deck selection, and sync.
>
> Open source (GPL-3.0). Deinflection rules ported from Yomitan.

## Permission justifications

Reviewers reject vague answers here. Be specific and tie each one to a user-visible feature.

| Permission                                                       | Justification                                                                                                                                                                                                                           |
| ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `storage`, `unlimitedStorage`                                    | Stores the downloaded Japanese dictionary pack in IndexedDB, plus the user's own settings. The pack is large (hundreds of thousands of entries), which is why unlimited storage is needed. Nothing here leaves the device.              |
| `activeTab`                                                      | Lets the user parse the page they're looking at from the toolbar button or context menu, as a one-off, without granting any standing site access.                                                                                       |
| `scripting`                                                      | Injects the content script that finds Japanese text and renders the lookup popup, only on pages where the user has turned the reader on.                                                                                                |
| `contextMenus`                                                   | Adds a right-click "look up with Shirabe" entry for a selected phrase.                                                                                                                                                                  |
| `identity`                                                       | Used only for the optional sign-in flow (OAuth redirect back to the extension) when a user chooses to connect a Shirabe account. Not used for ordinary reading.                                                                         |
| Host access to `shirabe.org`, `cdn.shirabe.org`, `o.shirabe.org` | The API the extension talks to: dictionary pack downloads (cdn), saving cards and syncing knowledge state (shirabe.org), and error reporting (o). No other remote host is contacted.                                                    |
| **Optional** `<all_urls>`                                        | **Never requested at install.** Only requested when the user explicitly turns the reader on for a specific site, so scanning survives a page reload. Declining is fully supported — lookup still works in the open tab via `activeTab`. |

## Data / privacy disclosure

- **No data is collected for ordinary use.** Dictionary lookups are resolved from
  the locally installed pack; page text is never uploaded.
- **Signed-out:** no personal data is transmitted at all.
- **Signed-in (optional):** words the user chooses to save, and their review
  grades, are sent to their own Shirabe account. This is the feature the user
  asked for, not analytics.
- **Error reports** contain no page content or personal data.
- No advertising, no selling of data, no tracking across sites.
- Privacy policy: https://shirabe.org/en/privacy

## Remote code

None. The extension executes no remote JavaScript. Dictionary packs and the
`/v1/reader/host-rules` response are schema-validated **data** only.

## Screenshots to capture

Take at a fixed 1280×800 on a light background, same page across both stores:

1. Hover lookup on an ordinary Japanese article — popup showing reading + meaning.
2. A parsed page with knowledge-state colouring visible (new / learning / known).
3. The save-to-deck action with sentence context attached.
4. Netflix or YouTube subtitle lookup.
5. The Dictionary tab showing the offline pack installed, with its size and version.

## Support links

- Homepage: https://shirabe.org
- Support: https://shirabe.org/en/contact
- Source: the extension is GPL-3.0; publish the matching source tag with each release.

## Reviewer notes (paste into the "notes to reviewer" box)

> The extension works fully offline for its core feature. On first run the user
> installs a Japanese dictionary pack from cdn.shirabe.org, after which lookup
> needs no network and no account.
>
> `<all_urls>` is declared **optional** and is never requested at install time. It
> is requested only when the user clicks the per-site reader toggle in the popup
> for a specific site. If the user declines, the extension still works on the
> current tab through `activeTab`.
>
> No remote code is executed. Dictionary packs and host rules are validated data.
>
> To test: open the popup, click "Install dictionary", wait for it to finish, then
> visit any Japanese page (e.g. https://www3.nhk.or.jp/news/easy/) and hover a
> word. No account is required for this.
