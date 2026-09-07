import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { BrowserType } from "playwright";
import type { GlossLanguage } from "shirabe-sdk/word-card/languages.js";
import type * as Offline from "../../src/common/offline-dictionary.js";
import type { Definition, ParsedToken } from "../../src/common/types.js";

declare global {
  var parity: Pick<typeof Offline, "dictionaryStatus" | "installDictionary" | "lookupOffline" | "lookupEntryOffline" | "parseOffline"> & {
    render(tokens: ParsedToken[]): { text: string | null; words: Array<{ surface?: string; lemma?: string; entry: string | null; candidates: string[] }> };
    showDefinition(definition: Definition): void;
    showCandidateLookup(query: string): Promise<void>;
    reopenDefinition(): void;
  };
}

export async function browserDictionary(payload: Buffer, revision: string, terms: number, bundle: string, dictionaries: string[]) {
  const { chromium } = createRequire(resolve("../package.json"))("playwright") as { chromium: BrowserType };
  const profile = process.env.PARITY_BROWSER_PROFILE;
  if (profile) mkdirSync(profile, { recursive: true });
  const portFile = profile && join(profile, "parity-port");
  const port = portFile && existsSync(portFile) ? Number(readFileSync(portFile, "utf8")) : 0;
  let origin = "";
  const manifest = {
    schemaVersion: 6, buildRecipeVersion: 13, minimumExtensionVersion: "0.2.4", contentRevision: revision,
    builtAt: new Date().toISOString(), artifact: "dictionary.ndjson.gz", compression: "gzip", mediaType: "application/x-ndjson",
    bytes: payload.byteLength, sha256: createHash("sha256").update(payload).digest("hex"),
    counts: { terms, kanji: 0, sentences: 0 }, languages: ["eng", "spa"],
    dictionaries: dictionaries.map((slug) => ({ slug, version: revision })), modifications: [], sources: [],
    audio: { baseUrl: "https://cdn.shirabe.org/audio", path: "words", extension: "m4a", separator: "\x1f",
      engineVersion: 1, salt: "test-salt", defaultVoice: "male", voices: { male: 1628969216, female: 345585728 } },
  };
  const server = createServer((request, response) => {
    if (request.url?.endsWith("/current")) {
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ ...manifest, downloadUrl: `${origin}/dictionary.gz` }));
    } else if (request.url === "/dictionary.gz") {
      response.setHeader("Content-Type", "application/gzip");
      response.end(payload);
    } else {
      response.setHeader("Content-Type", "text/html");
      response.end("<!doctype html><title>Search parity</title>");
    }
  });
  await new Promise<void>((done, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", done);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No local server address");
  origin = `http://127.0.0.1:${address.port}`;
  if (portFile) writeFileSync(portFile, String(address.port));
  let browser;
  try {
    browser = profile
      ? await chromium.launchPersistentContext(profile, { headless: true })
      : await chromium.launch({ headless: true });
    const page = await browser.newPage();
    page.on("console", (message) => { if (message.type() === "error") console.error(message.text()); });
    await page.goto(origin);
    await page.addScriptTag({ path: bundle });
    const started = performance.now();
    const progress = setInterval(() => {
      void page.evaluate(() => globalThis.parity.dictionaryStatus()).then((status) => {
        console.log(`Native install progress: ${Math.round(status.progress * 100)}%`);
      }).catch((error) => console.error(String(error)));
    }, 10_000);
    try {
      await page.evaluate((base) => globalThis.parity.installDictionary(base), origin);
    } finally {
      clearInterval(progress);
    }
    console.log(`Native Chromium install: ${Math.round(performance.now() - started)} ms, ${payload.byteLength} compressed bytes`);
    await page.evaluate(() => globalThis.parity.showCandidateLookup("きみ"));
    const choices = page.locator(".sb-host").locator("button.sb-candidate[data-entry]");
    await choices.nth(1).waitFor();
    const original = await page.locator("#parity-popup-target .sb-word").getAttribute("data-entry");
    const entries = await choices.evaluateAll((buttons) => buttons.map((button) => (button as HTMLElement).dataset.entry));
    const alternative = entries.findIndex((entry) => entry && entry !== original);
    if (alternative < 0) throw new Error("No alternative to the selected dictionary entry");
    const selected = entries[alternative];
    await choices.nth(alternative).click();
    await page.waitForFunction((entry) => document.querySelector<HTMLElement>("#parity-popup-target .sb-word")?.dataset.entry === entry, selected);
    const picked = await page.locator("#parity-popup-target .sb-word").getAttribute("data-lemma");
    await page.evaluate(() => globalThis.parity.reopenDefinition());
    await page.waitForFunction(({ entry, lemma, entries }) => {
      const target = document.querySelector<HTMLElement>("#parity-popup-target .sb-word");
      const shadow = document.querySelector(".sb-host")?.shadowRoot;
      const buttons = Array.from(shadow?.querySelectorAll<HTMLElement>("button.sb-candidate[data-entry]") ?? []);
      return target !== null && target.dataset.entry === entry && target.dataset.lemma === lemma
        && JSON.stringify(buttons.map((button) => button.dataset.entry)) === JSON.stringify(entries)
        && buttons.some((button) => button.dataset.entry === entry && button.getAttribute("aria-checked") === "true");
    }, { entry: selected, lemma: picked, entries }, { timeout: 5000 });
    console.log(`Native candidate pick/reopen: ${original} -> ${selected}, ${entries.length} choices retained without candidatesFor`);
    let renderedParses = 0;
    let renderedExplanations = 0;
    return {
      parse: async (text: string) => {
        const result = await page.evaluate(async ({ text, base }) => {
          const tokens = await globalThis.parity.parseOffline(text, ["eng"], base);
          const rendered = globalThis.parity.render(tokens);
          if (rendered.text !== text) throw new Error(`Rendered source changed: ${text}`);
          const expected = tokens.filter((token) => token.content).map((token) => ({
            surface: token.surface, lemma: token.lemma, entry: token.entry ?? null,
            candidates: token.candidates?.map((candidate) => candidate.entry) ?? [],
          }));
          if (JSON.stringify(rendered.words) !== JSON.stringify(expected)) {
            throw new Error(`Rendered lookup identity or candidates changed: ${text}`);
          }
          return tokens;
        }, { text, base: origin });
        renderedParses++;
        return result;
      },
      lookup: async (query: string, languages: GlossLanguage[]) => {
        const result = await page.evaluate(async ({ query, languages, base }) => {
          try {
            return { definition: await globalThis.parity.lookupOffline(query, languages, base) };
          } catch (error) {
            return { error: String(error), reason: error && typeof error === "object" && "reason" in error ? String(error.reason) : null };
          }
        }, { query, languages, base: origin });
        if ("error" in result) throw Object.assign(new Error(result.error), { reason: result.reason });
        return result.definition;
      },
      entry: async (entry: string, surface: string) => {
        const definition = await page.evaluate(({ entry, surface, base }) =>
          globalThis.parity.lookupEntryOffline(entry, surface, ["eng"], base), { entry, surface, base: origin });
        if (definition) {
          await page.evaluate((definition) => globalThis.parity.showDefinition(definition), definition);
          const expected = definition.inflection?.length
            ? `${definition.sourceForm ?? surface} → ${definition.inflectionBase ?? definition.headword} · ${definition.inflection.join(" · ")}` : null;
          await page.waitForFunction(({ expected, entry, headword, studyBase }) => {
            const shadow = document.querySelector(".sb-host")?.shadowRoot;
            const heading = shadow?.querySelector(".sb-headword")?.cloneNode(true) as HTMLElement | undefined;
            heading?.querySelectorAll("rt, rp").forEach((element) => element.remove());
            return (shadow?.querySelector(".sb-inflection")?.textContent ?? null) === expected
              && heading?.textContent === headword
              && document.querySelector<HTMLElement>("#parity-popup-target .sb-word")?.dataset.entry === entry
              && document.querySelector<HTMLElement>("#parity-popup-target .sb-word")?.dataset.lemma === studyBase;
          }, { expected, entry, headword: definition.headword, studyBase: definition.baseForm ?? definition.inflectionBase ?? definition.headword }, { timeout: 5000 });
          renderedExplanations++;
        }
        return definition;
      },
      close: async () => {
        console.log(`Native rendered token checks: ${renderedParses}`);
        console.log(`Native rendered popup checks: ${renderedExplanations}`);
        await browser!.close();
        server.close();
      },
    };
  } catch (error) {
    await browser?.close();
    server.close();
    throw error;
  }
}
