// Test files reach for `globalThis.chrome` to decide whether a previous suite
// already installed a stub (`globalThis.chrome ?? { … }`). The extension itself
// declares `chrome` file-locally (src/common/browser.ts), so at global scope it
// has no type at all and every read is an implicit-any error.
//
// `unknown` rather than a WebExt shape on purpose: the tests only ever pass this
// value straight to Object.assign, and a fuller type here would be a second,
// quieter definition of the browser API that could drift from the real one.
declare global {
  // eslint-disable-next-line no-var
  var chrome: unknown;
}

export {};
