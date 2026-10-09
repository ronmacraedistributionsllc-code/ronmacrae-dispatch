import React, { useEffect, useRef, useState } from "react";
import { API } from "@ronmacrae/contracts";
import { apiFetch } from "../lib/api.js";
import { useAuth } from "../lib/auth.js";
import { useForegroundLocationSharing } from "../lib/geolocation.js";
import { isNative, isNativeRider } from "../native/platform.js";
import {
  batteryHintDismissed,
  dismissBatteryHint,
  isNativeSharing,
  markSharingFlag,
  openNativeLocationSettings,
  startNativeSharing,
  stopNativeSharing,
  wasSharingWhenClosed,
  type NativePoint,
  type NativeShareState,
} from "../native/location.js";
import {
  BATTERY_HINT,
  LOCATION_DISCLOSURE,
  LOCATION_ONGOING_MESSAGE,
  LOCATION_ONGOING_TITLE,
  NO_ACTIVE_DELIVERY,
  SHARING_INTERRUPTED,
} from "../native/location-disclosure.js";

function timeAgo(d: Date | null): string {
  if (!d) return "never";
  const s = Math.round((Date.now() - d.getTime()) / 1000);
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  return `${Math.round(s / 60)}m ago`;
}

const MIN_REPORT_INTERVAL_MS = 8_000;

/**
 * Explicit opt-in foreground GPS sharing. See lib/geolocation.ts for the
 * foreground-only rationale — this component's job is to say that plainly in
 * the UI too, not just in a code comment.
 *
 * Decision D4: inside the native shell this renders the native sharing path
 * for riders only (the foreground service keeps reporting with the screen
 * off). Non-riders in the shell get nothing; everyone on web gets the exact
 * pre-existing foreground path below, untouched.
 */
export function LocationSharing({ riderId, hasActiveDelivery }: { riderId: string; hasActiveDelivery?: boolean }): React.JSX.Element {
  const { user } = useAuth();
  if (isNative()) {
    if (!isNativeRider(user?.role)) return <></>;
    return <NativeLocationSharing riderId={riderId} hasActiveDelivery={hasActiveDelivery ?? false} />;
  }
  return <WebLocationSharing riderId={riderId} />;
}

function WebLocationSharing({ riderId }: { riderId: string }): React.JSX.Element {
  const { state, error, lastSentAt, start, stop } = useForegroundLocationSharing(riderId);

  return (
    <div className="flex flex-wrap items-center gap-2">
      <button className="btn !px-3 !py-1 text-xs" onClick={() => (state === "sharing" ? stop() : start())}>
        {state === "sharing" ? "Stop sharing location" : state === "paused" ? "Resume sharing" : "Share my location"}
      </button>
      {state === "sharing" ? (
        <span className="text-xs text-emerald-400">Sharing · last sent {timeAgo(lastSentAt)}</span>
      ) : state === "paused" ? (
        <span className="text-xs text-amber-400">Paused — the app was in the background. Tap "Resume sharing" to continue.</span>
      ) : null}
      {error ? <span className="text-xs text-red-400">{error}</span> : null}
    </div>
  );
}

/**
 * Native sharing: same reporting path (POST /api/rider-locations/:id/report,
 * 8 s throttle, incrementing clientSeq, `paused` on stop) through the
 * foreground-service watcher, which keeps going with the screen off.
 * The label says "background" ONLY while the native watcher is running.
 *
 * Guardrails: the watcher starts only after the prominent disclosure AND
 * only while the rider has an active delivery; it stops (with a `paused`
 * report) the moment the delivery ends, on manual stop, and on logout.
 * If the OS killed the service while the app was closed, the UI says so
 * honestly and asks for a fresh tap — it never claims continuity it
 * doesn't have.
 */
function NativeLocationSharing({ riderId, hasActiveDelivery }: { riderId: string; hasActiveDelivery: boolean }): React.JSX.Element {
  const [state, setState] = useState<NativeShareState>(isNativeSharing() ? "sharing" : "off");
  const [error, setError] = useState<string | null>(null);
  const [lastSentAt, setLastSentAt] = useState<Date | null>(null);
  const [showDisclosure, setShowDisclosure] = useState(false);
  const [interrupted, setInterrupted] = useState(false);
  const [showBatteryHint, setShowBatteryHint] = useState(false);
  const lastSendRef = useRef(0);
  const seqRef = useRef(1);
  const lastPointRef = useRef<NativePoint | null>(null);
  const sharingRef = useRef(isNativeSharing());

  // Killed-service honesty + one-time battery hint, checked once on mount.
  useEffect(() => {
    let cancelled = false;
    void wasSharingWhenClosed().then((was) => {
      if (cancelled || !was) return;
      setInterrupted(true);
      void markSharingFlag(false);
    });
    void batteryHintDismissed().then((dismissed) => {
      if (!cancelled) setShowBatteryHint(!dismissed);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  function report(point: NativePoint, trackingState: "active" | "paused"): void {
    void apiFetch(API.riders.report(riderId), {
      method: "POST",
      body: JSON.stringify({ point: { lat: point.lat, lng: point.lng }, trackingState, clientSeq: seqRef.current++ }),
    })
      .then(() => setLastSentAt(new Date()))
      .catch(() => {
        // Best-effort telemetry, same as the web hook — never an error state.
      });
  }

  async function stopWithReport(): Promise<void> {
    const wasSharing = sharingRef.current;
    sharingRef.current = false;
    await stopNativeSharing();
    await markSharingFlag(false);
    setState("off");
    if (wasSharing && lastPointRef.current) {
      report(lastPointRef.current, "paused");
      lastPointRef.current = null;
    }
  }

  // Delivery ended (completed / cancelled / unassigned) while sharing:
  // stop immediately and report `paused`, exactly like a manual stop.
  useEffect(() => {
    if (!hasActiveDelivery && sharingRef.current) void stopWithReport();
  }, [hasActiveDelivery]);

  async function start(): Promise<void> {
    setError(null);
    setInterrupted(false);
    setState("starting");
    const next = await startNativeSharing({
      foregroundTitle: LOCATION_ONGOING_TITLE,
      foregroundMessage: LOCATION_ONGOING_MESSAGE,
      onPoint: (point) => {
        lastPointRef.current = point;
        const now = Date.now();
        if (now - lastSendRef.current < MIN_REPORT_INTERVAL_MS) return;
        lastSendRef.current = now;
        report(point, "active");
      },
      onError: (message) => setError(message),
    });
    if (next === "sharing") {
      sharingRef.current = true;
      await markSharingFlag(true);
    }
    setState(next);
  }

  async function stop(): Promise<void> {
    await stopWithReport();
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <button
          className="btn !px-3 !py-1 text-xs"
          disabled={state === "starting" || (!hasActiveDelivery && state !== "sharing")}
          onClick={() => void (state === "sharing" ? stop() : setShowDisclosure(true))}
        >
          {state === "sharing" ? "Stop sharing location" : state === "starting" ? "Starting…" : "Share my location"}
        </button>
        {state === "sharing" ? (
          <span className="text-xs text-emerald-400">Sharing in background · last sent {timeAgo(lastSentAt)}</span>
        ) : state === "permission-denied" ? (
          <span className="text-xs text-amber-400">Location permission was denied — allow it in Android settings to share.</span>
        ) : state === "error" ? (
          <span className="text-xs text-amber-400">Sharing couldn&apos;t start on this device. You can still deliver; dispatch just won&apos;t see live location.</span>
        ) : state === "unsupported" ? (
          <span className="text-xs text-amber-400">Native sharing isn&apos;t available here.</span>
        ) : !hasActiveDelivery ? (
          <span className="text-xs text-zinc-500">{NO_ACTIVE_DELIVERY}</span>
        ) : null}
        {error ? <span className="text-xs text-red-400">{error}</span> : null}
      </div>
      {interrupted && state !== "sharing" ? <p className="text-xs text-amber-400">{SHARING_INTERRUPTED}</p> : null}
      {showDisclosure && state !== "sharing" ? (
        <div className="card space-y-2 border border-zinc-700 p-3" role="dialog" aria-label={LOCATION_DISCLOSURE.title}>
          <p className="text-sm font-semibold text-zinc-100">{LOCATION_DISCLOSURE.title}</p>
          <ul className="list-disc space-y-1 pl-5 text-xs text-zinc-300">
            <li>{LOCATION_DISCLOSURE.what}</li>
            <li>{LOCATION_DISCLOSURE.when}</li>
            <li>{LOCATION_DISCLOSURE.why}</li>
            <li>{LOCATION_DISCLOSURE.who}</li>
            <li>{LOCATION_DISCLOSURE.howToStop}</li>
          </ul>
          <div className="flex gap-2">
            <button
              className="btn !px-3 !py-1 text-xs"
              onClick={() => {
                setShowDisclosure(false);
                void start();
              }}
            >
              {LOCATION_DISCLOSURE.confirm}
            </button>
            <button className="btn !px-3 !py-1 text-xs" onClick={() => setShowDisclosure(false)}>
              {LOCATION_DISCLOSURE.cancel}
            </button>
          </div>
        </div>
      ) : null}
      {showBatteryHint ? (
        <div className="card space-y-1 border border-zinc-800 p-3">
          <p className="text-xs font-semibold text-zinc-200">{BATTERY_HINT.title}</p>
          <p className="text-xs text-zinc-400">{BATTERY_HINT.body}</p>
          <div className="flex gap-2">
            <button className="btn !px-3 !py-1 text-xs" onClick={() => void openNativeLocationSettings()}>
              {BATTERY_HINT.openSettings}
            </button>
            <button
              className="btn !px-3 !py-1 text-xs"
              onClick={() => {
                void dismissBatteryHint().then(() => setShowBatteryHint(false));
              }}
            >
              {BATTERY_HINT.dismiss}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
