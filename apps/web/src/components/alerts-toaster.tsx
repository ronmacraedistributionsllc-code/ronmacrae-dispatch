import React, { useEffect, useState } from "react";
import type { RealtimeMessage } from "@ronmacrae/contracts";
import { useRealtime } from "../lib/realtime.js";
import { useAuth } from "../lib/auth.js";

interface ToastItem {
  id: string;
  text: string;
  tone: "info" | "danger";
}

/** Which realtime messages become a toast, and for whom — riders and staff see different things. */
function toastFor(msg: RealtimeMessage, isRider: boolean): { text: string; tone: ToastItem["tone"] } | null {
  if (msg.type === "offer" && isRider) {
    const route = [msg.payload.pickupArea, msg.payload.destinationArea].filter(Boolean).join(" → ");
    return { text: `New delivery offer${route ? `: ${route}` : ""}`, tone: "info" };
  }
  if (msg.type === "job.assigned" && !isRider) {
    const label = msg.payload.job.jobNumber ?? msg.payload.job.id.slice(0, 8);
    return { text: `${label} assigned to ${msg.payload.job.riderName ?? "a rider"}`, tone: "info" };
  }
  if (msg.type === "sos") {
    return { text: `SOS — ${msg.payload.riderName}${msg.payload.note ? `: ${msg.payload.note}` : ""}`, tone: "danger" };
  }
  return null;
}

const TOAST_TTL_MS = 7_000;

/** Global toast stack for live in-app alerts, driven by the realtime hub (see lib/realtime.tsx). */
export function AlertsToaster(): React.JSX.Element | null {
  const { user } = useAuth();
  const { subscribe } = useRealtime();
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  useEffect(() => {
    const isRider = user?.role === "rider";
    return subscribe(["offer", "job.assigned", "sos"], (msg) => {
      const toast = toastFor(msg, isRider);
      if (!toast) return;
      const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      setToasts((cur) => [...cur, { id, ...toast }]);
      setTimeout(() => setToasts((cur) => cur.filter((t) => t.id !== id)), TOAST_TTL_MS);
    });
  }, [subscribe, user?.role]);

  if (toasts.length === 0) return null;
  return (
    <div className="pointer-events-none fixed right-4 top-4 z-50 flex w-80 max-w-[calc(100vw-2rem)] flex-col gap-2">
      {toasts.map((t) => (
        <div
          key={t.id}
          role="status"
          className={`pointer-events-auto rounded-lg border px-3 py-2 text-sm shadow-lg ${
            t.tone === "danger" ? "border-red-700 bg-red-950/90 text-red-100" : "border-sky-700 bg-sky-950/90 text-sky-100"
          }`}
        >
          {t.text}
        </div>
      ))}
    </div>
  );
}
