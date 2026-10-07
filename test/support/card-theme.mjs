import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

export async function verifyCardTheme(article, optionsPage) {
  const artifacts = resolve("tmp/popup-layout");
  await mkdir(artifacts, { recursive: true });
  for (const [system, theme, dark] of [
    ["dark", "system", true], ["light", "system", false],
    ["dark", "light", false], ["light", "dark", true],
  ]) {
    await article.emulateMedia({ colorScheme: system, reducedMotion: "reduce" });
    await optionsPage.evaluate(async (theme) => {
      const { config } = await chrome.storage.local.get("config");
      await chrome.storage.local.set({ config: { ...config, theme } });
    }, theme);
    await article.waitForFunction((theme) => document.querySelector(".sb-host")?.dataset.sbTheme === theme, theme);
    const colors = await article.locator(".sb-host .sb-popup").evaluate((popup) => {
      const source = popup.querySelector(".sb-source");
      const swatch = document.createElement("canvas").getContext("2d");
      swatch.fillStyle = getComputedStyle(source).color;
      swatch.fillRect(0, 0, 1, 1);
      return {
        background: getComputedStyle(popup).backgroundColor,
        ink: getComputedStyle(popup).color,
        blue: [...swatch.getImageData(0, 0, 1, 1).data].slice(0, 3),
      };
    });
    assert.deepEqual(colors, dark
      ? { background: "rgb(37, 37, 38)", ink: "rgb(232, 232, 232)", blue: [19, 159, 247] }
      : { background: "rgb(255, 255, 255)", ink: "rgb(17, 24, 39)", blue: [3, 105, 161] },
    `lookup card uses Shirabe colors with ${theme} theme on a ${system} system`);
    await article.locator(".sb-host .sb-popup").screenshot({ path: resolve(artifacts, `card-${theme}-${system}.png`) });
  }
  await optionsPage.evaluate(async () => {
    const { config } = await chrome.storage.local.get("config");
    await chrome.storage.local.set({ config: { ...config, customPopupCss: ".sb-source { color: #0f766e; }" } });
  });
  await article.waitForFunction(() => {
    const source = document.querySelector(".sb-host")?.shadowRoot.querySelector(".sb-source");
    return source && getComputedStyle(source).color === "rgb(15, 118, 110)";
  });
  await optionsPage.evaluate(async () => {
    const { config } = await chrome.storage.local.get("config");
    await chrome.storage.local.set({ config: { ...config, theme: "system", customPopupCss: "" } });
  });
  console.log("Lookup card uses neutral surfaces and Shirabe blue in system and explicit themes");
}
