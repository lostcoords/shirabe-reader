// Set only by a `--watch` build without `--serve`; empty everywhere else, so
// release bundles keep nothing but the early return below.
declare const __DEV_RELOAD_URL__: string;

// Hot reload inside your own Firefox. `npm run dev` gets it from web-ext, which
// insists on its own browser profile; loading dist/firefox as a temporary
// add-on instead keeps your real profile, and this fills in the missing half.
// The watcher announces each rebuild and the extension reloads itself.
//
// A temporary add-on reads its files straight from `dist/firefox`, so a reload
// is all it takes to pick up the new build. Content scripts still need a tab
// refresh to re-inject into pages that are already open.
export function installDevReload(): void {
  if (!__DEV_RELOAD_URL__) return;

  // A convenience must never be able to take the extension down with it: this
  // runs at the top of the background script, so anything thrown here would
  // abort the module before it ever starts serving the popup.
  try {
    // EventSource reconnects on its own, so the watcher can start later than the
    // browser, and restarting it re-arms the reload without touching Firefox.
    const stream = new EventSource(__DEV_RELOAD_URL__);
    stream.addEventListener("rebuilt", () => {
      // `runtime.reload()` belongs here and is the only lever a page has. There
      // is no external reload for a temporary add-on (web-ext can only attach to
      // a Firefox it launched itself). It is left out until we can confirm it
      // reloads a temporary add-on rather than tearing it out of the browser:
      // getting that wrong costs the whole extension, which is a far worse trade
      // than clicking Reload.
      console.log("[Shirabe dev] rebuilt: click Reload on about:debugging to pick it up");
    });
  } catch (error) {
    console.warn("[Shirabe dev] self-reload unavailable", error);
  }
}
