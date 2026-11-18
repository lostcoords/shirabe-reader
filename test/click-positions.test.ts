import "fake-indexeddb/auto";
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { installWindow } from "./support/dom.js";
import { lookupGroupOffline, lookupScanOffline, parseOffline, resolveParsedSpan, setActiveDictionaryStack } from "../src/common/offline-dictionary.js";
import { installTestPack, packPayload, corpusPackPath, subsetPack } from "./support/pack.js";

const cases = (parseYaml(readFileSync("test/fixtures/tokenizer_eval/click_positions.yml", "utf8")) as
  Array<{ sentence: string; surface: string; entry: string }>).map((row) => ({ ...row, text: row.sentence }));

test("pointer positions preserve whole-word identity across inline nodes and ruby", async (context) => {
  const records = await subsetPack(corpusPackPath(), cases.map((row) => row.text));
  await installTestPack(packPayload(records), { contentRevision: "click-positions", terms: records.length - 1 });
  const window = installWindow({ url: "https://reader.test" });
  const { scanTargetAt } = await import("@shirabe-org/card/word-card/scan");
  const { extensionHost } = await import("../src/content/card-host.js");
  const { ext } = await import("../src/common/browser.js");
  const { mappedWrapper } = await import("../src/content/parser.js");
  const { logicalTextAt } = await import("@shirabe-org/card/word-card/dom-text");
  const document = window.document;
  const rangePrototype = window.Range.prototype as unknown as { getBoundingClientRect: () => DOMRect };
  rangePrototype.getBoundingClientRect = () => new window.DOMRect(10, 10, 10, 20) as unknown as DOMRect;
  let clicks = 0;
  for (const languages of [["eng"], ["spa"], ["spa", "eng"]] as const) {
    await setActiveDictionaryStack(languages.map((language) => `jmdict:${language === "spa" ? "es" : "en"}`), {}, {}, "a".repeat(16));
    for (const row of cases) {
      for (const layout of ["plain", "inline", "ruby"] as const) {
        await context.test(`${languages.join(",")}/${layout}/${row.surface}`, async () => {
          const line = document.createElement("p");
          for (const [index, char] of [...row.text].entries()) {
            if (layout === "plain") line.append(char);
            else {
              const inline = document.createElement(layout === "ruby" && /\p{Script=Han}/u.test(char) ? "ruby" : index % 2 ? "a" : "em");
              inline.append(char);
              if (inline.tagName === "RUBY") {
                const reading = document.createElement("rt");
                reading.textContent = "よみ";
                inline.append(reading);
              }
              line.append(inline);
            }
          }
          document.body.replaceChildren(line);
          const walker = document.createTreeWalker(line, window.NodeFilter.SHOW_TEXT);
          const nodes: Array<{ node: Text; start: number }> = [];
          let start = 0;
          let node;
          while ((node = walker.nextNode())) {
            if (node.parentElement?.closest("rt,rp")) continue;
            const text = node as unknown as Text;
            nodes.push({ node: text, start });
            start += text.length;
          }
          assert.equal(nodes.map((source) => source.node.data).join(""), row.text);
          const targetStart = row.text.indexOf(row.surface);
          for (let offset = targetStart; offset < targetStart + row.surface.length; offset++) {
            const source = nodes.find((part) => part.start <= offset && offset < part.start + part.node.length)!;
            Object.assign(document, { caretPositionFromPoint: () => ({ offsetNode: source.node, offset: offset - source.start }) });
            const event = new window.MouseEvent("mousemove", { clientX: 10, clientY: 10 });
            Object.defineProperty(event, "target", { value: source.node.parentElement });
            const target = scanTargetAt(event as unknown as MouseEvent, "", line as unknown as HTMLElement);
            assert.ok(target, `${row.surface} at ${offset}`);
            assert.equal(target.sentence, row.text);
            assert.equal(target.targetStart, offset);
            const found = await lookupScanOffline(target.sentence, target.targetStart, languages, "https://shirabe.test");
            assert.equal(found?.groups[0]?.[0], row.entry, `${row.surface} at ${offset}`);
            assert.equal(found?.token.start, targetStart);
            assert.equal(found?.token.surface, row.surface);
            const anchor = target.at(targetStart);
            assert.ok(anchor);
            assert.equal(logicalTextAt(anchor.node, anchor.offset).contextOffset, targetStart);
            clicks++;
          }
          if (layout !== "ruby") {
            const tokens = await parseOffline(row.text, languages, "https://shirabe.test");
            for (const source of nodes) source.node.parentNode!.replaceChild(mappedWrapper(source.node.data, source.start, row.text, tokens, true), source.node);
            const spans = [...line.querySelectorAll(`[data-entry="${row.entry}"]`)];
            assert.ok(spans.length);
            for (const span of spans) {
              assert.equal(span.getAttribute("data-target-start"), String(targetStart));
              assert.equal(span.getAttribute("data-target-end"), String(targetStart + row.surface.length));
              assert.equal(span.getAttribute("data-sentence"), row.text);
              ext.runtime.sendMessage = async (request) => {
                assert.equal(request.type, "lookupSpan");
                if (request.type !== "lookupSpan") throw new Error("expected contextual span lookup");
                assert.equal(request.text, row.text);
                assert.equal(request.startOffset, targetStart);
                assert.equal(request.endOffset, targetStart + row.surface.length);
                const token = tokens.find((token) => token.start === request.startOffset)!;
                const resolution = await resolveParsedSpan(request.text, token);
                const definition = await lookupGroupOffline(resolution.groups[0]!, row.surface, languages, "https://shirabe.test");
                return { ok: true, type: "lookupSpan", definition, alternatives: [] };
              };
              const result = await extensionHost.lookupEntry!(row.entry, span.getAttribute("data-surface")!, span as unknown as HTMLElement);
              assert.equal(result.status, "found");
              if (result.status === "found") assert.equal(result.definition?.entry, row.entry);
            }
          }
        });
      }
    }
  }
  context.diagnostic(`${clicks} pointer positions checked through the SDK scanner and offline resolver`);
});
