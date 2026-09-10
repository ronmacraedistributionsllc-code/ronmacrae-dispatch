import React, { useEffect } from "react";
import { NavLink, useLocation } from "react-router-dom";
import { useAuth } from "../lib/auth.js";
import { useRealtime, type ConnectionStatus } from "../lib/realtime.js";
import { AlertsToaster } from "./alerts-toaster.js";

const TABS = [
  { to: "/", label: "Dashboard", end: true },
  { to: "/ops", label: "Ops board" },
  { to: "/jobs", label: "Jobs", end: true },
  { to: "/jobs/new", label: "New Order" },
  { to: "/map", label: "Map" },
  { to: "/zones", label: "Zones & Fares" },
  { to: "/cod", label: "COD" },
  { to: "/notifications", label: "Notifications" },
];
const STAFF_ONLY_TABS = new Set(["/ops", "/jobs", "/jobs/new", "/map", "/cod"]);

const CONNECTION_LABEL: Record<ConnectionStatus, string> = {
  live: "Live",
  reconnecting: "Reconnecting…",
  offline: "Offline",
};
const CONNECTION_DOT: Record<ConnectionStatus, string> = {
  live: "bg-emerald-500",
  reconnecting: "bg-amber-500 animate-pulse",
  offline: "bg-red-600",
};

export function Layout({ children }: { children: React.ReactNode }): React.JSX.Element {
  const { user, logout } = useAuth();
  const { unreadCount, markRead, status } = useRealtime();
  const { pathname } = useLocation();
  // Visiting any screen acknowledges pending alerts — coarse, but simple and honest
  // (no per-item read-tracking to get subtly wrong).
  useEffect(() => {
    if (unreadCount > 0) markRead();
    // Only re-run on navigation, not on every unreadCount tick — otherwise a new
    // alert while sitting on the same page would clear itself immediately.
  }, [pathname]);
  const tabs = user?.role === "rider" ? TABS.filter((t) => !STAFF_ONLY_TABS.has(t.to)) : TABS;
  return (
    <div className="flex h-full min-h-dvh flex-col md:flex-row">
      <AlertsToaster />
      <aside className="flex shrink-0 flex-col gap-1 border-b border-zinc-800 bg-zinc-900/60 p-4 md:w-56 md:border-b-0 md:border-r">
        <div className="mb-4 flex items-center justify-between gap-2">
          <div>
            <div className="text-base font-bold text-brand-accent">Ronmacrae</div>
            <div className="text-xs uppercase tracking-widest text-zinc-400">Dispatch</div>
          </div>
          <div
            className="flex items-center gap-1.5 whitespace-nowrap text-xs text-zinc-400"
            title="Realtime connection status"
            data-testid="connection-status"
          >
            <span className={`h-2 w-2 rounded-full ${CONNECTION_DOT[status]}`} />
            {CONNECTION_LABEL[status]}
          </div>
        </div>
        <nav className="flex gap-1 overflow-x-auto md:flex-col">
          {tabs.map((t) => (
            <NavLink
              key={t.to}
              to={t.to}
              end={t.end}
              className={({ isActive }) =>
                `flex items-center gap-1.5 whitespace-nowrap rounded-lg px-3 py-2 text-sm font-medium transition ${
                  isActive ? "bg-brand text-white" : "text-zinc-300 hover:bg-zinc-800"
                }`
              }
            >
              {t.label}
              {t.to === "/" && unreadCount > 0 ? (
                <span className="rounded-full bg-red-600 px-1.5 py-0.5 text-[10px] font-bold leading-none text-white">
                  {unreadCount > 9 ? "9+" : unreadCount}
                </span>
              ) : null}
            </NavLink>
          ))}
        </nav>
        <div className="mt-auto hidden md:block">
          <div className="truncate text-sm text-zinc-200">{user?.name}</div>
          <div className="text-xs text-zinc-500">{user?.role}</div>
          <button className="btn mt-3 w-full" onClick={() => void logout()}>
            Sign out
          </button>
        </div>
      </aside>
      <main className="min-w-0 flex-1 overflow-y-auto p-4 md:p-6">{children}</main>
    </div>
  );
}
