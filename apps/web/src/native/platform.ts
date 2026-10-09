/**
 * Native-platform detection for the Capacitor rider shell.
 *
 * The Android shell injects a `window.Capacitor` runtime into the remote
 * page at document start (see the installed `@capacitor/android` Bridge /
 * JSInjector — `WebViewCompat.addDocumentStartJavaScript`), so detection
 * works WITHOUT bundling `@capacitor/core` into the website. This module
 * deliberately has zero Capacitor imports: importing core eagerly would put
 * it in the main bundle for every desktop/mobile-web visitor. All plugin
 * JS is loaded with dynamic `import()` inside the adapters, only after
 * `isNative()` is true.
 */

interface InjectedCapacitor {
  isNativePlatform?: () => boolean;
  getPlatform?: () => string;
}

function injected(): InjectedCapacitor | null {
  if (typeof window === "undefined") return null;
  try {
    return (window as unknown as { Capacitor?: InjectedCapacitor }).Capacitor ?? null;
  } catch {
    return false as unknown as null;
  }
}

/** True only inside the native shell (Android now; iOS later). Always false on web. */
export function isNative(): boolean {
  try {
    return injected()?.isNativePlatform?.() === true;
  } catch {
    return false;
  }
}

export type NativePlatform = "android" | "ios" | "web";

/** Which platform the shell reports, or "web" outside the shell. */
export function nativePlatform(): NativePlatform {
  try {
    const p = injected()?.getPlatform?.();
    return p === "android" || p === "ios" ? p : "web";
  } catch {
    return "web";
  }
}

/**
 * Decision D4: native-only behaviour is gated on BOTH the shell AND the
 * signed-in user being a rider. Desktop/mobile web and non-rider roles are
 * never shown native UI and never load plugin code.
 */
export function isNativeRider(role: string | undefined | null): boolean {
  return isNative() && role === "rider";
}
