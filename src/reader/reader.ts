import { getDocument, GlobalWorkerOptions } from "pdfjs-dist";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { ext } from "../common/browser.js";
import { loadConfig } from "../common/config.js";
import { parse } from "../content/parser.js";
import { scheduleHide, scheduleShow, setCanWrite } from "../content/popup.js";

GlobalWorkerOptions.workerSrc = ext.runtime.getURL("reader/pdf.worker.min.mjs");
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const documentView = $<HTMLElement>("document");
const frame = $<HTMLIFrameElement>("pdfFrame");
let pdfUrl = "";
let pdfDocument: PDFDocumentProxy | null = null;
let pdfObserver: IntersectionObserver | null = null;
let sourceUrl = "";

void initialize();

async function initialize(): Promise<void> {
  const config = await loadConfig();
  setCanWrite(config.apiKey.length > 0 && config.scopes.includes("WRITE_SRS"));
  const stored = await ext.storage.local.get("readerDraft");
  await ext.storage.local.remove("readerDraft");
  const draft = stored.readerDraft as { title?: string; text?: string; sourceUrl?: string } | undefined;
  if (draft?.title) document.title = `${draft.title} — Shirabe Reader`;
  sourceUrl = draft?.sourceUrl ?? "";
  if (draft?.text) await render(draft.text);
  else showPaste();
}

async function render(text: string): Promise<void> {
  frame.hidden = true;
  $<HTMLElement>("editor").hidden = true;
  documentView.hidden = false;
  documentView.dataset.sourceUrl = sourceUrl;
  documentView.dataset.integration = sourceUrl ? "article_reader" : "paste_reader";
  documentView.textContent = text;
  $<HTMLElement>("progress").textContent = "Parsing locally…";
  await parse(documentView, true);
  $<HTMLElement>("progress").textContent = "";
}

function showPaste(): void {
  documentView.hidden = true;
  frame.hidden = true;
  $<HTMLElement>("editor").hidden = false;
}

$<HTMLButtonElement>("pasteMode").addEventListener("click", showPaste);
$<HTMLButtonElement>("renderPaste").addEventListener("click", () => {
  sourceUrl = "";
  void render($<HTMLTextAreaElement>("pasteText").value);
});

$<HTMLInputElement>("pdfFile").addEventListener("change", async (event) => {
  const file = (event.currentTarget as HTMLInputElement).files?.[0];
  if (!file) return;
  if (pdfUrl) URL.revokeObjectURL(pdfUrl);
  pdfUrl = URL.createObjectURL(file);
  frame.src = pdfUrl;
  frame.hidden = false;
  documentView.hidden = true;
  $<HTMLElement>("editor").hidden = true;
  $<HTMLButtonElement>("reflowPdf").hidden = false;
  $<HTMLButtonElement>("faithfulPdf").hidden = false;
  $<HTMLElement>("progress").textContent = "Opening PDF locally…";
  const pdfOptions = { data: await file.arrayBuffer(), isEvalSupported: false } as unknown as Parameters<typeof getDocument>[0];
  pdfDocument = await getDocument(pdfOptions).promise;
  $<HTMLElement>("progress").textContent = `PDF ready · ${pdfDocument.numPages} pages`;
});

$<HTMLButtonElement>("reflowPdf").addEventListener("click", () => void showPdfReflow());
$<HTMLButtonElement>("faithfulPdf").addEventListener("click", () => { documentView.hidden = true; frame.hidden = false; });

async function showPdfReflow(): Promise<void> {
  if (!pdfDocument) return;
  frame.hidden = true;
  $<HTMLElement>("editor").hidden = true;
  documentView.hidden = false;
  documentView.dataset.integration = "pdf_reflow";
  documentView.replaceChildren();
  pdfObserver?.disconnect();
  pdfObserver = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      pdfObserver?.unobserve(entry.target);
      void extractPdfPage(entry.target as HTMLElement);
    }
  }, { rootMargin: "1200px 0px" });
  for (let number = 1; number <= pdfDocument.numPages; number += 1) {
    const page = document.createElement("section");
    page.className = "pdf-page";
    page.dataset.page = String(number);
    page.dataset.integration = "pdf_reflow";
    page.setAttribute("aria-label", `PDF page ${number}`);
    page.textContent = `Page ${number}`;
    documentView.append(page);
    pdfObserver.observe(page);
  }
  $<HTMLElement>("progress").textContent = "Reflow pages load as you read";
}

async function extractPdfPage(element: HTMLElement): Promise<void> {
  if (!pdfDocument || element.dataset.loaded === "true") return;
  const number = Number(element.dataset.page);
  element.dataset.loaded = "loading";
  try {
    const content = await (await pdfDocument.getPage(number)).getTextContent();
    const text = content.items.map((item) => ("str" in item ? item.str : "")).join(" ");
    element.textContent = text || `Page ${number} has no extractable text.`;
    element.dataset.loaded = "true";
    if (text) await parse(element, true);
  } catch {
    element.textContent = `Page ${number} could not be extracted.`;
    element.dataset.loaded = "error";
  }
}

$<HTMLInputElement>("fontSize").addEventListener("input", (event) => { documentView.style.fontSize = `${(event.currentTarget as HTMLInputElement).value}px`; });
$<HTMLInputElement>("lineHeight").addEventListener("input", (event) => { documentView.style.lineHeight = String(Number((event.currentTarget as HTMLInputElement).value) / 10); });
$<HTMLSelectElement>("direction").addEventListener("change", (event) => documentView.classList.toggle("vertical", (event.currentTarget as HTMLSelectElement).value === "vertical"));
$<HTMLSelectElement>("theme").addEventListener("change", (event) => { document.documentElement.dataset.theme = (event.currentTarget as HTMLSelectElement).value; });
$<HTMLSelectElement>("fontFamily").addEventListener("change", (event) => { documentView.dataset.font = (event.currentTarget as HTMLSelectElement).value; });
$<HTMLSelectElement>("fontWeight").addEventListener("change", (event) => { documentView.style.fontWeight = (event.currentTarget as HTMLSelectElement).value; });
$<HTMLInputElement>("readingWidth").addEventListener("input", (event) => { documentView.style.maxWidth = `${(event.currentTarget as HTMLInputElement).value}ch`; });

window.addEventListener("beforeunload", () => {
  pdfObserver?.disconnect();
  if (pdfUrl) URL.revokeObjectURL(pdfUrl);
});

document.addEventListener("mouseover", (event) => {
  const word = (event.target as Element | null)?.closest?.(".sb-word");
  if (word instanceof HTMLElement) scheduleShow(word);
});
document.addEventListener("mouseout", (event) => {
  if ((event.target as Element | null)?.closest?.(".sb-word")) scheduleHide();
});
