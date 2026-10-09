import { isNative } from "./platform.js";

/**
 * External-URL handling (security decision D5).
 *
 * The WebView may only navigate the production origin
 * (`server.allowNavigation` in `native/capacitor.config.ts`). Every other
 * http(s) URL must open in the system browser via `@capacitor/browser`
 * (native) — never inside the WebView where it could call native plugins.
 */

/** True for http(s) URLs whose host differs from the page's own host. */
export function isExternalUrl(href: string): boolean {
  try {
    const page = new URL(window.location.href);
    const target = new URL(href, page);
    if (target.protocol !== "http:" && target.protocol !== "https:") return false;
    return target.host !== page.host;
  } catch {
    return false;
  }
}

/** Open a URL outside the WebView. Falls back to `window.open` on web. */
export function openExternal(url: string): void {
  if (!isNative()) {
    window.open(url, "_blank", "noopener");
    return;
  }
  void import("@capacitor/browser")
    .then(({ Browser }) => Browser.open({ url }))
    .catch(() => window.open(url, "_blank", "noopener"));
}

/**
 * Install a document-level click interceptor that reroutes cross-origin
 * links to the system browser. Call once at startup when native; returns a
 * remover. No-op on web.
 */
export function installExternalLinkInterceptor(): () => void {
  if (!isNative()) return () => {};
  const onClick = (event: MouseEvent): void => {
    const el = event.target as HTMLElement | null;
    const anchor = el?.closest?.("a[href]") as HTMLAnchorElement | null;
    if (!anchor) return;
    const href = anchor.getAttribute("href");
    if (!href || href.startsWith("#")) return;
    if (isExternalUrl(href)) {
      event.preventDefault();
      openExternal(anchor.href);
    }
  };
  document.addEventListener("click", onClick);
  return () => document.removeEventListener("click", onClick);
}
