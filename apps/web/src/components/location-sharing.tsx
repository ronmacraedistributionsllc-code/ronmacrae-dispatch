import React from "react";
import { useForegroundLocationSharing } from "../lib/geolocation.js";

function timeAgo(d: Date | null): string {
  if (!d) return "never";
  const s = Math.round((Date.now() - d.getTime()) / 1000);
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  return `${Math.round(s / 60)}m ago`;
}

/**
 * Explicit opt-in foreground GPS sharing. See lib/geolocation.ts for the
 * foreground-only rationale — this component's job is to say that plainly in
 * the UI too, not just in a code comment.
 */
export function LocationSharing({ riderId }: { riderId: string }): React.JSX.Element {
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
