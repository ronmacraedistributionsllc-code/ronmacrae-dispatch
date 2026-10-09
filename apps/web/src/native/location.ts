import type { BackgroundGeolocationPlugin } from "@capacitor-community/background-geolocation";
import { isNative } from "./platform.js";

/**
 * Thin typed adapter over `@capacitor-community/background-geolocation`
 * (a foreground service with a persistent notification on Android).
 *
 * The plugin ships no JS of its own — it is reached via `registerPlugin`
 * from `@capacitor/core`, loaded here with a dynamic `import()` only after
 * `isNative()` is true, so the normal web bundle has no new eager imports.
 * Every function degrades gracefully outside the shell and never throws
 * into the caller.
 *
 * Reporting (POST /api/rider-locations/:id/report, 8 s throttle,
 * incrementing clientSeq, `paused` on stop) is wired by the caller through
 * `onPoint`/`onStop` — Phase 5 adds the disclosure screen, the honest
 * background states, and the device test. This adapter only owns the
 * watcher lifecycle.
 */

export type NativeShareState = "unsupported" | "off" | "starting" | "sharing" | "permission-denied" | "error";

export interface NativePoint {
  lat: number;
  lng: number;
  /** ms since epoch, from the OS fix (null when the plugin has none). */
  time: number | null;
}

let watcherId: string | null = null;

async function plugin(): Promise<BackgroundGeolocationPlugin> {
  const { registerPlugin } = await import("@capacitor/core");
  return registerPlugin<BackgroundGeolocationPlugin>("BackgroundGeolocation");
}

export function isNativeSharing(): boolean {
  return watcherId !== null;
}

/**
 * Start the native watcher. The OS permission prompt appears on first run
 * (requestPermissions: true) — the caller MUST show the prominent disclosure
 * screen first (Phase 5; a one-line disclosure ships in the component now).
 */
export async function startNativeSharing(opts: {
  onPoint: (point: NativePoint) => void;
  onError: (message: string) => void;
  foregroundTitle: string;
  foregroundMessage: string;
}): Promise<NativeShareState> {
  if (!isNative()) return "unsupported";
  if (watcherId !== null) return "sharing";
  try {
    const geo = await plugin();
    const id = await geo.addWatcher(
      {
        backgroundMessage: opts.foregroundMessage,
        backgroundTitle: opts.foregroundTitle,
        requestPermissions: true,
        stale: false,
      },
      (location, error) => {
        if (error || !location) {
          opts.onError(error?.message || "Could not get your location");
          return;
        }
        opts.onPoint({ lat: location.latitude, lng: location.longitude, time: location.time });
      },
    );
    watcherId = id;
    return "sharing";
  } catch (err) {
    const code = (err as { code?: unknown } | null)?.code;
    const message = err instanceof Error ? err.message : String(err);
    if (code === "NOT_AUTHORIZED" || /permission|denied|authorized/i.test(message)) return "permission-denied";
    return "error";
  }
}

/** Stop the watcher. The caller reports `trackingState: "paused"` separately (same as the web hook). */
export async function stopNativeSharing(): Promise<void> {
  if (watcherId === null) return;
  const id = watcherId;
  watcherId = null;
  if (!isNative()) return;
  try {
    const geo = await plugin();
    await geo.removeWatcher({ id });
  } catch {
    // already stopped is fine — never throw into the caller
  }
}

/** Open the OS app-settings screen (used for the battery-optimization hint). */
export async function openNativeLocationSettings(): Promise<void> {
  if (!isNative()) return;
  try {
    const geo = await plugin();
    await geo.openSettings();
  } catch {
    // best-effort
  }
}

const SHARING_FLAG_KEY = "native-sharing-was-on";
const BATTERY_HINT_KEY = "native-battery-hint-dismissed";

async function prefs() {
  const { Preferences } = await import("@capacitor/preferences");
  return Preferences;
}

/**
 * True when a previous session was sharing but this one isn't (the OS
 * killed the service while the app was closed). Never auto-resumes — the
 * caller shows an honest "tap to resume" note instead.
 */
export async function wasSharingWhenClosed(): Promise<boolean> {
  if (!isNative()) return false;
  try {
    const { value } = await (await prefs()).get({ key: SHARING_FLAG_KEY });
    return value === "1" && watcherId === null;
  } catch {
    return false;
  }
}

export async function markSharingFlag(on: boolean): Promise<void> {
  if (!isNative()) return;
  try {
    const p = await prefs();
    if (on) await p.set({ key: SHARING_FLAG_KEY, value: "1" });
    else await p.remove({ key: SHARING_FLAG_KEY });
  } catch {
    // best-effort
  }
}

export async function batteryHintDismissed(): Promise<boolean> {
  if (!isNative()) return true;
  try {
    const { value } = await (await prefs()).get({ key: BATTERY_HINT_KEY });
    return value === "1";
  } catch {
    return true;
  }
}

export async function dismissBatteryHint(): Promise<void> {
  if (!isNative()) return;
  try {
    await (await prefs()).set({ key: BATTERY_HINT_KEY, value: "1" });
  } catch {
    // best-effort
  }
}

/** Test-only reset of the module-level watcher id. */
export function __resetNativeSharingForTests(): void {
  watcherId = null;
}
