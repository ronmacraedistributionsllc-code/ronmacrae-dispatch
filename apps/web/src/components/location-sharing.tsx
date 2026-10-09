import React, { useRef, useState } from "react";
import { API } from "@ronmacrae/contracts";
import { apiFetch } from "../lib/api.js";
import { useAuth } from "../lib/auth.js";
import { useForegroundLocationSharing } from "../lib/geolocation.js";
import { isNative, isNativeRider } from "../native/platform.js";
import {
  isNativeSharing,
  startNativeSharing,
  stopNativeSharing,
  type NativePoint,
  type NativeShareState,
} from "../native/location.js";

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
export function LocationSharing({ riderId }: { riderId: string }): React.JSX.Element {
  const { user } = useAuth();
  if (isNative()) {
    if (!isNativeRider(user?.role)) return <></>;
    return <NativeLocationSharing riderId={riderId} />;
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
 * (Phase 5 adds the full prominent-disclosure screen and device tests.)
 */
function NativeLocationSharing({ riderId }: { riderId: string }): React.JSX.Element {
  const [state, setState] = useState<NativeShareState>(isNativeSharing() ? "sharing" : "off");
  const [error, setError] = useState<string | null>(null);
  const [lastSentAt, setLastSentAt] = useState<Date | null>(null);
  const lastSendRef = useRef(0);
  const seqRef = useRef(1);
  const lastPointRef = useRef<NativePoint | null>(null);

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

  async function start(): Promise<void> {
    setError(null);
    setState("starting");
    const next = await startNativeSharing({
      foregroundTitle: "Sharing location for your active delivery",
      foregroundMessage: "Dispatch can see where you are while you deliver. Turn off sharing to stop.",
      onPoint: (point) => {
        lastPointRef.current = point;
        const now = Date.now();
        if (now - lastSendRef.current < MIN_REPORT_INTERVAL_MS) return;
        lastSendRef.current = now;
        report(point, "active");
      },
      onError: (message) => setError(message),
    });
    setState(next);
  }

  async function stop(): Promise<void> {
    const wasSharing = isNativeSharing();
    await stopNativeSharing();
    setState("off");
    if (wasSharing && lastPointRef.current) {
      report(lastPointRef.current, "paused");
      lastPointRef.current = null;
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <button className="btn !px-3 !py-1 text-xs" onClick={() => void (state === "sharing" ? stop() : start())}>
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
      ) : null}
      <span className="text-xs text-zinc-500">Shares your location with dispatch while you deliver, even with the screen off. Stop anytime.</span>
      {error ? <span className="text-xs text-red-400">{error}</span> : null}
    </div>
  );
}
