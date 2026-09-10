import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { RealtimeMessage } from "@ronmacrae/contracts";
import { WS_PATH } from "@ronmacrae/contracts";
import { getAccessToken, refreshAccessToken } from "./api.js";
import { useAuth } from "./auth.js";

type Handler = (msg: RealtimeMessage) => void;
type Subscription = { types: RealtimeMessage["type"][] | "*"; handler: Handler };

interface RealtimeState {
  /** True once the current socket has completed the server's `hello` handshake. */
  connected: boolean;
  /** Subscribe to one or more message types (or "*" for all). Returns an unsubscribe function. */
  subscribe: (types: RealtimeMessage["type"][] | "*", handler: Handler) => () => void;
}

const RealtimeContext = createContext<RealtimeState | null>(null);

const MAX_BACKOFF_MS = 30_000;

/**
 * Websocket client for the realtime hub (`apps/api/src/rt/hub.ts`). Connects once
 * per logged-in session, reconnects with backoff on drop, and refreshes the access
 * token on an auth-rejected connect (the hub validates the JWT once, at connect
 * time, so a 15-minute-old token can go stale between reconnects).
 *
 * Pages should treat this as a supplement, not a replacement, for their own
 * polling — a missed reconnect window (offline, tab suspended) shouldn't leave a
 * page silently stale forever.
 */
export function RealtimeProvider({ children }: { children: ReactNode }): ReactNode {
  const { user } = useAuth();
  const [connected, setConnected] = useState(false);
  const subscriptionsRef = useRef(new Set<Subscription>());

  useEffect(() => {
    if (!user) {
      setConnected(false);
      return;
    }
    let cancelled = false;
    let socket: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let attempt = 0;

    function scheduleReconnect(): void {
      if (cancelled) return;
      const delay = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** attempt);
      attempt += 1;
      reconnectTimer = setTimeout(() => void connect(), delay);
    }

    async function connect(): Promise<void> {
      if (cancelled) return;
      let token = getAccessToken();
      if (!token) {
        const ok = await refreshAccessToken();
        token = ok ? getAccessToken() : null;
      }
      if (!token || cancelled) {
        scheduleReconnect();
        return;
      }
      const proto = window.location.protocol === "https:" ? "wss" : "ws";
      const ws = new WebSocket(`${proto}://${window.location.host}${WS_PATH}?token=${encodeURIComponent(token)}`);
      socket = ws;

      ws.onmessage = (event) => {
        let msg: { type: string; payload?: unknown };
        try {
          msg = JSON.parse(event.data as string) as { type: string; payload?: unknown };
        } catch {
          return;
        }
        if (msg.type === "hello") {
          attempt = 0;
          setConnected(true);
          return;
        }
        if (msg.type === "joined") return;
        for (const sub of subscriptionsRef.current) {
          if (sub.types === "*" || (sub.types as string[]).includes(msg.type)) sub.handler(msg as RealtimeMessage);
        }
      };
      ws.onclose = (event) => {
        setConnected(false);
        if (cancelled) return;
        if (event.code === 4401) {
          // stale/invalid token — refresh before the next connect attempt
          void refreshAccessToken().finally(scheduleReconnect);
        } else {
          scheduleReconnect();
        }
      };
      ws.onerror = () => ws.close();
    }

    void connect();
    return () => {
      cancelled = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      socket?.close();
    };
  }, [user?.id]);

  const subscribe = useMemo(
    () => (types: RealtimeMessage["type"][] | "*", handler: Handler) => {
      const sub: Subscription = { types, handler };
      subscriptionsRef.current.add(sub);
      return () => subscriptionsRef.current.delete(sub);
    },
    [],
  );

  const value = useMemo(() => ({ connected, subscribe }), [connected, subscribe]);
  return <RealtimeContext.Provider value={value}>{children}</RealtimeContext.Provider>;
}

export function useRealtime(): RealtimeState {
  const ctx = useContext(RealtimeContext);
  if (!ctx) throw new Error("useRealtime must be used within RealtimeProvider");
  return ctx;
}
