import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

export async function verifyPopupLayout(context, extensionId) {
  const popup = await context.newPage();
  const artifacts = resolve("tmp/popup-layout");
  await mkdir(artifacts, { recursive: true });
  try {
    await popup.setViewportSize({ width: 400, height: 560 });
    await popup.goto(`chrome-extension://${extensionId}/action/popup.html`);
    await popup.locator("#signInBanner").waitFor();
    for (const theme of ["dark", "light"]) {
      await popup.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
      for (const state of ["lookup", "missing", "installing", "ready"]) {
        await popup.evaluate((state) => {
          document.querySelector("#readerToggle").hidden = false;
          document.querySelector("#readerToggleHost").textContent = "ja.wikipedia.org";
          document.querySelector("#pagePause").hidden = false;
          document.querySelector("#needsDictionary").hidden = state !== "missing";
          document.querySelector("#dictionaryInstallingBanner").hidden = state !== "installing";
          document.querySelector("#signInBanner").hidden = state !== "ready";
        }, state);
        const layout = await popup.evaluate(() => {
          const main = document.querySelector("main");
          const controls = main.querySelector("header");
          const prompt = document.querySelector("#panel-lookup > :not([hidden])");
          const nav = document.querySelector("nav");
          const settings = document.querySelector('[aria-label="Page settings"]');
          return {
            width: document.body.getBoundingClientRect().width,
            height: document.body.getBoundingClientRect().height,
            overflow: document.documentElement.scrollWidth > 400,
            contentBottom: main.getBoundingClientRect().bottom,
            navTop: nav.getBoundingClientRect().top,
            settingsBottom: settings.getBoundingClientRect().bottom,
            topGap: controls.getBoundingClientRect().top - main.getBoundingClientRect().top,
            bottomGap: nav.getBoundingClientRect().top - settings.getBoundingClientRect().bottom,
            pageGap: prompt.getBoundingClientRect().top - controls.getBoundingClientRect().bottom,
            settingsGap: settings.getBoundingClientRect().top - prompt.getBoundingClientRect().bottom,
            background: getComputedStyle(document.body).backgroundColor,
            card: getComputedStyle(prompt).backgroundColor,
            controlHeights: [...settings.querySelectorAll("select")].map((select) => select.getBoundingClientRect().height),
            pauseRight: document.querySelector("#pagePause").getBoundingClientRect().right,
            toggleLeft: document.querySelector("#readerToggle").getBoundingClientRect().left,
            pauseCenter: document.querySelector("#pagePause").getBoundingClientRect().top + document.querySelector("#pagePause").getBoundingClientRect().height / 2,
            toggleCenter: document.querySelector("#readerToggle").getBoundingClientRect().top + document.querySelector("#readerToggle").getBoundingClientRect().height / 2,
          };
        });
        assert.equal(layout.width, 400);
        assert.ok(layout.height <= 580, "the popup stays within the browser height limit");
        assert.equal(layout.overflow, false);
        assert.ok(layout.contentBottom <= layout.navTop, "navigation does not overlap the scroll area");
        assert.ok(layout.settingsBottom <= layout.navTop - 16, "all page settings fit above navigation");
        console.log(JSON.stringify({ theme, state, topGap: layout.topGap, bottomGap: layout.bottomGap }));
        assert.equal(layout.topGap, 16, "the content has a 16px top inset");
        assert.equal(layout.bottomGap, layout.topGap, "top and bottom content insets match");
        assert.equal(layout.pageGap, 16, "page controls and the prompt have a shared spacing rule");
        if (state !== "lookup") assert.equal(layout.settingsGap, 16, "the prompt and settings have the same spacing");
        assert.deepEqual(layout.controlHeights, [36, 36, 36]);
        assert.ok(layout.pauseRight <= layout.toggleLeft - 8, "page pause sits beside the switch without overlap");
        assert.equal(layout.pauseCenter, layout.toggleCenter, "page pause and the switch share one row");
        if (theme === "dark") {
          assert.equal(layout.background, "rgb(29, 29, 29)");
          assert.equal(layout.card, "rgb(37, 37, 38)");
        }
        await popup.locator("body").screenshot({ path: resolve(artifacts, `${theme}-${state}.png`) });
      }
    }
    await popup.evaluate(() => {
      document.querySelector("#readerToggle").hidden = true;
      document.querySelector("#pagePause").hidden = true;
    });
    for (const panel of ["lookup", "dictionary", "account"]) {
      await popup.locator(`[data-panel="${panel}"]`).click();
      const insets = await popup.evaluate(() => {
        const main = document.querySelector("main");
        const panel = main.querySelector('[role="tabpanel"]:not([hidden])');
        return {
          top: panel.getBoundingClientRect().top - main.getBoundingClientRect().top,
          bottom: document.querySelector("nav").getBoundingClientRect().top - panel.getBoundingClientRect().bottom,
        };
      });
      assert.deepEqual(insets, { top: 16, bottom: 16 }, `${panel} has equal insets without page controls`);
    }
    await popup.getByRole("tab", { name: "Dictionary", exact: true }).click();
    await popup.locator("#panel-dictionary").waitFor();
    await popup.getByRole("tab", { name: "Dictionary", exact: true }).press("ArrowRight");
    assert.equal(await popup.getByRole("tab", { name: "Account", exact: true }).getAttribute("aria-selected"), "true");
    await popup.locator("#panel-account").waitFor();
    await popup.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
    await popup.setViewportSize({ width: 1040, height: 800 });
    await popup.goto(`chrome-extension://${extensionId}/options/options.html`);
    const settingsColors = await popup.evaluate(() => ({
      background: getComputedStyle(document.body).backgroundColor,
      card: getComputedStyle(document.querySelector("#reading")).backgroundColor,
    }));
    assert.deepEqual(settingsColors, { background: "rgb(29, 29, 29)", card: "rgb(37, 37, 38)" });
    await popup.screenshot({ path: resolve(artifacts, "dark-settings.png") });
    console.log(`Popup layout passed in both themes and all dictionary states; screenshots: ${artifacts}`);
  } finally {
    await popup.close();
  }
}
