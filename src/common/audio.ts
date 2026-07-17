// Pronunciation clips only ever come from the public R2 bucket behind
// cdn.shirabe.org/audio/. The background worker fetches them (its host
// permission bypasses the page's CSP, which otherwise blocks cross-origin
// media on strict sites like Wikipedia) and hands the content script a
// data: URL to play. This guard is the security boundary for that fetch:
// a compromised content script must not be able to make the privileged
// background worker request an arbitrary URL, so both sides validate here.
export function isR2AudioUrl(url: string | null | undefined): url is string {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && parsed.hostname === "cdn.shirabe.org" && parsed.pathname.startsWith("/audio/");
  } catch {
    return false;
  }
}
