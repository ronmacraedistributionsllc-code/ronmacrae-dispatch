import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { RealtimeMessage } from "@ronmacrae/contracts";
import { WS_PATH } from "@ronmacrae/contracts";
import { getAccessToken, refreshAccessToken } from "./api.js";
import { useAuth } from "./auth.js";

type Handler = (msg: RealtimeMessage) => void;
type Subscription = { types: RealtimeMessage["type"][] | "*"; handler: Handler };

/** "live" once the current socket completes the server's `hello` handshake;
 *  "offline" when the browser itself reports no network (so retrying would be
 *  pointless to promise); "reconnecting" the rest of the time — an attempt is
 *  in flight or scheduled and will keep happening indefinitely. */
export type ConnectionStatus = "live" | "reconnecting" | "offline";

interface RealtimeState {
  /** @deprecated use `status` — kept as `status === "live"` for any caller that only needs a boolean. */
  connected: boolean;
  status: ConnectionStatus;
  /** Subscribe to one or more message types (or "*" for all). Returns an unsubscribe function. */
  subscribe: (types: RealtimeMessage["type"][] | "*", handler: Handler) => () => void;
  /** Fires every time the socket (re)establishes a live connection, including the
   *  first one — the moment to refetch anything that might have been missed while
   *  disconnected, rather than waiting on a page's own poll interval. */
  onReconnect: (handler: () => void) => () => void;
  /** Count of alert-worthy realtime messages received since the last markRead(). */
  unreadCount: number;
  /** Acknowledge — call when the user has visited a screen that shows what came in. */
  markRead: () => void;
}

/** Same "is this worth the user's attention" rule the alert toasts use — kept here
 *  too (rather than only in alerts-toaster.tsx) so the unread badge counts exactly
 *  what a toast would have shown, for whichever role is logged in. */
function isAlertWorthy(msg: { type: string; payload?: unknown }, role: string | undefined): boolean {
  const isRider = role === "rider";
  if (msg.type === "offer") return isRider;
  if (msg.type === "job.assigned") {
    const source = (msg.payload as { source?: string } | undefined)?.source;
    return isRider ? source === "assign" : true;
  }
  if (msg.type === "sos") return true;
  // A new order landing is dispatch's own equivalent of a courier's "new
  // offer" — never relevant to a rider (they get their own offer/
  // assignment signal instead, not a raw new-order count).
  if (msg.type === "job.created") return !isRider;
  // Spec item 5 — a rider or dispatcher who has no idea a message came in
  // can't know to go check for one. Skip a rider's own just-sent message
  // (there's only ever one active rider session); staff is a shared role
  // across several real people, so any delivery_message counts for them.
  if (msg.type === "delivery_message") {
    const senderRole = (msg.payload as { senderRole?: string } | undefined)?.senderRole;
    return isRider ? senderRole !== "rider" : true;
  }
  return false;
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
  const [status, setStatus] = useState<ConnectionStatus>("reconnecting");
  const [unreadCount, setUnreadCount] = useState(0);
  const subscriptionsRef = useRef(new Set<Subscription>());
  const reconnectHandlersRef = useRef(new Set<() => void>());
  const roleRef = useRef(user?.role);
  roleRef.current = user?.role;

  useEffect(() => {
    if (!user) {
      setStatus("reconnecting");
      return;
    }
    let cancelled = false;
    let socket: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let attempt = 0;

    // The browser's own online/offline signal distinguishes "actively retrying"
    // from "there is no point retrying yet" — both keep trying regardless (the
    // network can come back at any moment), but the label shown to the user
    // should be honest about which is going on.
    const applyOfflineAwareStatus = () => {
      if (cancelled) return;
      setStatus(navigator.onLine === false ? "offline" : "reconnecting");
    };
    window.addEventListener("online", applyOfflineAwareStatus);
    window.addEventListener("offline", applyOfflineAwareStatus);

    function scheduleReconnect(): void {
      if (cancelled) return;
      applyOfflineAwareStatus();
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
          setStatus("live");
          for (const handler of reconnectHandlersRef.current) handler();
          return;
        }
        if (msg.type === "joined") return;
        if (isAlertWorthy(msg, roleRef.current)) setUnreadCount((n) => n + 1);
        for (const sub of subscriptionsRef.current) {
          if (sub.types === "*" || (sub.types as string[]).includes(msg.type)) sub.handler(msg as RealtimeMessage);
        }
      };
      ws.onclose = (event) => {
        if (cancelled) return;
        if (event.code === 4401) {
          // stale/invalid token — refresh before the next connect attempt
          applyOfflineAwareStatus();
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
      window.removeEventListener("online", applyOfflineAwareStatus);
      window.removeEventListener("offline", applyOfflineAwareStatus);
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

  const onReconnect = useMemo(
    () => (handler: () => void) => {
      reconnectHandlersRef.current.add(handler);
      return () => reconnectHandlersRef.current.delete(handler);
    },
    [],
  );

  const markRead = useMemo(() => () => setUnreadCount(0), []);

  const value = useMemo(
    () => ({ connected: status === "live", status, subscribe, onReconnect, unreadCount, markRead }),
    [status, subscribe, onReconnect, unreadCount, markRead],
  );
  return <RealtimeContext.Provider value={value}>{children}</RealtimeContext.Provider>;
}

export function useRealtime(): RealtimeState {
  const ctx = useContext(RealtimeContext);
  if (!ctx) throw new Error("useRealtime must be used within RealtimeProvider");
  return ctx;
}
