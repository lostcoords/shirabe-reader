import { ext } from "./browser.js";
import { send } from "./messages.js";
import { toException, type ClientContext } from "./telemetry.js";

// Installed in the page-adjacent contexts (content scripts, the popup, the
// options page). It captures unhandled errors and rejections and forwards them
// to the background worker, which owns the network send.
//
// Content scripts share the page's window, so a naive handler would also catch
// the *host page's* JavaScript errors — noise at best, a privacy leak at worst.
// We forward an error only when it originates in our own code, detected by our
// extension's runtime URL appearing in the stack or the error's source file.
export function installClientReporter(context: ClientContext): void {
  const extBase = ext.runtime.getURL(""); // chrome-extension://<id>/ or moz-extension://<id>/

  const isOurs = (stack: string | undefined, filename?: string): boolean =>
    (!!stack && stack.includes(extBase)) || (!!filename && filename.startsWith(extBase));

  const forward = (error: unknown): void => {
    void send({ type: "telemetry", report: { context, signals: [toException(error, context)] } });
  };

  window.addEventListener("error", (event) => {
    if (!isOurs((event.error as Error | undefined)?.stack, event.filename)) return;
    forward(event.error ?? event.message);
  });

  window.addEventListener("unhandledrejection", (event) => {
    const reason = event.reason as { stack?: string } | undefined;
    if (!isOurs(reason?.stack)) return;
    forward(event.reason);
  });
}
