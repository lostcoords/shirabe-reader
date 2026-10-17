export const DEVELOPMENT_BUILD_PATTERN = /^\d{8}T(\d{2})(\d{2})(\d{2})(\d{3})-[0-9a-f]{2}$/;

export function developmentBuildLabel(version: string, id: string): string | null {
  const match = DEVELOPMENT_BUILD_PATTERN.exec(id);
  if (!match) return null;
  return `${version} · ${match[1]}:${match[2]}:${match[3]}.${match[4]}`;
}

export function shouldReloadDevelopmentBuild(loadedId: string, announcedId: unknown): boolean {
  return typeof announcedId === "string"
    && announcedId !== loadedId
    && DEVELOPMENT_BUILD_PATTERN.test(announcedId)
    && DEVELOPMENT_BUILD_PATTERN.test(loadedId);
}

export async function readPackagedBuildId(getURL: (path: string) => string): Promise<string> {
  try {
    const response = await fetch(getURL("build.json"), { cache: "no-store" });
    if (!response.ok) return "";
    const id = (await response.json() as { id?: unknown }).id;
    return typeof id === "string" ? id : "";
  } catch {
    return "";
  }
}

declare const __DEV_RELOAD__: boolean;
declare const __EXTENSION_VERSION__: string;

export function installDevelopmentBuildStamp(element: HTMLElement, getURL: (path: string) => string): void {
  if (!__DEV_RELOAD__) return;
  void readPackagedBuildId(getURL).then((id) => {
    const label = developmentBuildLabel(__EXTENSION_VERSION__, id);
    if (!label) return;
    element.hidden = false;
    element.textContent = `Dev build ${label}`;
  });
}
