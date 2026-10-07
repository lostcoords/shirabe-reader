import assert from "node:assert/strict";

export async function verifyPageControls(context, extensionId, article, tabId, optionsPage) {
  const popup = await context.newPage();
  try {
    await optionsPage.evaluate((tabId) => chrome.tabs.update(tabId, { active: true }), tabId);
    await popup.goto(`chrome-extension://${extensionId}/action/popup.html`);
    const pause = popup.locator("#pagePause");
    const toggle = popup.locator("#readerToggle");
    await pause.waitFor();
    assert.equal(await toggle.getAttribute("aria-pressed"), "true");
    await pause.click();
    await popup.waitForFunction(() => document.querySelector("#pagePause").textContent === "Resume this page");
    await article.waitForFunction(() => document.documentElement.classList.contains("sb-reader-off"));
    assert.equal(await toggle.getAttribute("aria-pressed"), "true", "pausing the page does not turn off the site reader");
    await pause.click();
    await popup.waitForFunction(() => document.querySelector("#pagePause").textContent === "Pause on this page");
    await article.waitForFunction(() => !document.documentElement.classList.contains("sb-reader-off"));
    await toggle.click();
    await popup.waitForFunction(() => document.querySelector("#readerToggle").getAttribute("aria-pressed") === "false");
    await article.waitForFunction(() => document.documentElement.classList.contains("sb-reader-off"));
    assert.equal(await pause.textContent(), "Pause on this page", "turning off the site reader does not pause the page");
    await toggle.click();
    await popup.waitForFunction(() => document.querySelector("#readerToggle").getAttribute("aria-pressed") === "true");
    await article.waitForFunction(() => !document.documentElement.classList.contains("sb-reader-off"));
    console.log("Adjacent page pause and reader toggle work independently");
  } finally {
    await popup.close();
  }
}
