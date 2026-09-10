import { useEffect, useRef, useState } from "react";
import { API } from "@ronmacrae/contracts";
import { apiFetch } from "./api.js";

export type ShareState = "off" | "sharing" | "paused";

const MIN_REPORT_INTERVAL_MS = 8_000;

/**
 * Foreground-only GPS sharing for the rider PWA. This explicitly does NOT claim
 * background tracking — the browser gives a page no reliable way to keep watching
 * position once the tab is hidden/backgrounded, so the watch is cleared (not just
 * throttled) the instant that happens, the state honestly flips to "paused", and
 * the rider has to resume manually when they come back. Claiming anything more
 * ("still tracking in the background") would be false.
 *
 * Reports go through the existing POST /api/rider-locations/:id/report route,
 * which feeds the same pipeline as the preview location simulator
 * (apps/api/src/rt/location-sim.ts) and overrides it for this rider's active job.
 */
export function useForegroundLocationSharing(riderId: string): {
  state: ShareState;
  error: string | null;
  lastSentAt: Date | null;
  start: () => void;
  stop: () => void;
} {
  const [state, setState] = useState<ShareState>("off");
  const [error, setError] = useState<string | null>(null);
  const [lastSentAt, setLastSentAt] = useState<Date | null>(null);
  const watchIdRef = useRef<number | null>(null);
  const lastSendRef = useRef(0);
  const seqRef = useRef(1);

  function send(point: { lat: number; lng: number }, trackingState: "active" | "paused"): void {
    void apiFetch(API.riders.report(riderId), {
      method: "POST",
      body: JSON.stringify({ point, trackingState, clientSeq: seqRef.current++ }),
    })
      .then(() => setLastSentAt(new Date()))
      .catch(() => {
        // Best-effort telemetry: a dropped report means a slightly stale map for
        // dispatch, not a broken app for the rider — never surface this as an error.
      });
  }

  function clearWatch(): void {
    if (watchIdRef.current != null) {
      navigator.geolocation.clearWatch(watchIdRef.current);
      watchIdRef.current = null;
    }
  }

  function start(): void {
    if (!("geolocation" in navigator)) {
      setError("Geolocation isn't supported in this browser");
      return;
    }
    setError(null);
    setState("sharing");
    watchIdRef.current = navigator.geolocation.watchPosition(
      (pos) => {
        setError(null);
        const now = Date.now();
        if (now - lastSendRef.current < MIN_REPORT_INTERVAL_MS) return;
        lastSendRef.current = now;
        send({ lat: pos.coords.latitude, lng: pos.coords.longitude }, "active");
      },
      (err) => setError(err.message || "Could not get your location"),
      { enableHighAccuracy: true, maximumAge: 10_000, timeout: 20_000 },
    );
  }

  function stop(): void {
    const wasSharing = state === "sharing";
    clearWatch();
    setState("off");
    if (wasSharing) {
      navigator.geolocation.getCurrentPosition(
        (pos) => send({ lat: pos.coords.latitude, lng: pos.coords.longitude }, "paused"),
        () => {},
        { maximumAge: 30_000, timeout: 5_000 },
      );
    }
  }

  useEffect(() => {
    function onVisibility(): void {
      if (document.hidden && watchIdRef.current != null) {
        clearWatch();
        setState("paused");
      }
    }
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);

  useEffect(() => () => clearWatch(), []);

  return { state, error, lastSentAt, start, stop };
}
