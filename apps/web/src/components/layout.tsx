import React, { useEffect, useState } from "react";
import { NavLink, useLocation, useNavigate } from "react-router-dom";
import { useAuth, MERCHANT_PORTAL_TOKEN_KEY, LOGISTICS_PORTAL_TOKEN_KEY } from "../lib/auth.js";
import { useRealtime, type ConnectionStatus } from "../lib/realtime.js";
import { AlertsToaster } from "./alerts-toaster.js";
import { apiFetch } from "../lib/api.js";

const TABS = [
  { to: "/", label: "Dashboard", icon: "🏠", end: true },
  { to: "/ops", label: "Ops board", icon: "📋" },
  { to: "/jobs", label: "Jobs", icon: "📦", end: true },
  { to: "/jobs/new", label: "New order", icon: "➕" },
  { to: "/merchants", label: "Merchants", icon: "🏬" },
  { to: "/logistics-companies", label: "Logistics", icon: "🚚" },
  { to: "/team", label: "Team", icon: "👥" },
  { to: "/settings", label: "Settings", icon: "⚙️" },
  { to: "/map", label: "Map", icon: "🗺️" },
  { to: "/zones", label: "Zones & Fares", icon: "📍" },
  { to: "/cod", label: "COD", icon: "💵" },
  { to: "/settlements", label: "Settlements", icon: "🧾" },
  { to: "/reports", label: "Reports", icon: "📊" },
  { to: "/trash", label: "Trash", icon: "🗑️" },
  { to: "/notifications", label: "Notifications", icon: "🔔" },
  { to: "/messages", label: "Messages", icon: "💬" },
  { to: "/platform-admin", label: "Platform Admin", icon: "🛡️" },
];
/** Never shown to anyone without platformRole: "owner" — filtered
 *  alongside STAFF_ONLY_TABS/ADMIN_ACCOUNTANT_ONLY_TABS below, not just
 *  gated at the route (app.tsx's OwnerOnly) — a non-owner should never
 *  even see the tab exists. */
const OWNER_ONLY_TABS = new Set(["/platform-admin"]);
const STAFF_ONLY_TABS = new Set(["/ops", "/jobs", "/jobs/new", "/merchants", "/logistics-companies", "/team", "/settings", "/map", "/zones", "/cod", "/settlements", "/reports", "/trash"]);
/** Owner/accountant only — matches the backend's own gating on /api/reports/*. */
const ADMIN_ACCOUNTANT_ONLY_TABS = new Set(["/reports"]);
/** Primary bottom-nav slots on mobile (thumb-reachable, at most 4 so a 5th
 *  "More" button never has to squeeze in a 6th). Everything else — and Sign
 *  out, which has no dedicated tab at all — lives behind "More". */
const MAX_PRIMARY_MOBILE_TABS = 4;

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
  const { user, logout, otherWorkspaces } = useAuth();
  const navigate = useNavigate();
  const { unreadCount, markRead, status } = useRealtime();

  async function switchWorkspace(w: { type: "merchant" | "logistics"; id: string }) {
    if (w.type === "logistics") {
      const body = await apiFetch<{ token: string }>("/auth/switch-to-logistics", { method: "POST", body: JSON.stringify({ logisticsCompanyId: w.id }) });
      sessionStorage.setItem(LOGISTICS_PORTAL_TOKEN_KEY, body.token);
      navigate("/logistics");
      return;
    }
    const body = await apiFetch<{ token: string }>("/auth/switch-to-merchant", { method: "POST", body: JSON.stringify({ merchantId: w.id }) });
    sessionStorage.setItem(MERCHANT_PORTAL_TOKEN_KEY, body.token);
    navigate("/merchant");
  }
  const { pathname } = useLocation();
  const [moreOpen, setMoreOpen] = useState(false);
  // Visiting any screen acknowledges pending alerts — coarse, but simple and honest
  // (no per-item read-tracking to get subtly wrong).
  useEffect(() => {
    if (unreadCount > 0) markRead();
    // Only re-run on navigation, not on every unreadCount tick — otherwise a new
    // alert while sitting on the same page would clear itself immediately.
  }, [pathname]);
  useEffect(() => setMoreOpen(false), [pathname]);
  const tabs = TABS.filter((t) => {
    if (user?.role === "rider" && STAFF_ONLY_TABS.has(t.to)) return false;
    if (ADMIN_ACCOUNTANT_ONLY_TABS.has(t.to) && user?.role !== "admin" && user?.role !== "accountant") return false;
    if (OWNER_ONLY_TABS.has(t.to) && user?.platformRole !== "owner") return false;
    return true;
  });
  const primaryMobileTabs = tabs.slice(0, MAX_PRIMARY_MOBILE_TABS);
  const overflowMobileTabs = tabs.slice(MAX_PRIMARY_MOBILE_TABS);
  const needsMoreButton = overflowMobileTabs.length > 0;

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
        {/* Desktop/tablet: the full tab list stays here, as before. Mobile gets
         *  its own bottom nav (below) instead — a horizontally-scrolling strip
         *  of 9 tabs is hard to scan and easy to mis-tap on a phone. */}
        <nav className="hidden gap-1 md:flex md:flex-col">
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
              <span aria-hidden="true">{t.icon}</span>
              {t.label}
              {t.to === "/" && unreadCount > 0 ? (
                <span className="ml-auto rounded-full bg-red-600 px-1.5 py-0.5 text-[10px] font-bold leading-none text-white">
                  {unreadCount > 9 ? "9+" : unreadCount}
                </span>
              ) : null}
            </NavLink>
          ))}
        </nav>
        <div className="mt-auto hidden md:block">
          <div className="truncate text-sm text-zinc-200">{user?.name}</div>
          <div className="text-xs text-zinc-500">{user?.role}</div>
          {otherWorkspaces.length > 0 ? (
            <div className="mt-3 space-y-1">
              <div className="text-xs text-zinc-500">Switch workspace</div>
              {otherWorkspaces.map((w) => (
                <button key={w.id} className="btn w-full text-left text-xs" onClick={() => void switchWorkspace(w)}>
                  {w.type === "logistics" ? "🚚" : "🏬"} {w.name}
                </button>
              ))}
            </div>
          ) : null}
          <button className="btn mt-3 w-full" onClick={() => void logout()}>
            Sign out
          </button>
        </div>
      </aside>

      <main className="min-w-0 flex-1 overflow-y-auto p-4 pb-20 md:p-6 md:pb-6">{children}</main>

      {/* Mobile bottom nav — fixed, thumb-reachable, icon + label (status
       *  never relies on color alone: the unread badge carries a number,
       *  the active tab gets a filled background as well as its own color). */}
      <nav
        className="fixed inset-x-0 bottom-0 z-30 flex items-stretch border-t border-zinc-800 bg-zinc-900/95 backdrop-blur md:hidden"
        style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
        aria-label="Primary"
      >
        {primaryMobileTabs.map((t) => (
          <NavLink
            key={t.to}
            to={t.to}
            end={t.end}
            className={({ isActive }) =>
              `relative flex flex-1 flex-col items-center justify-center gap-0.5 py-2 text-[11px] font-medium ${
                isActive ? "text-brand-accent" : "text-zinc-400"
              }`
            }
          >
            <span className="text-lg leading-none" aria-hidden="true">{t.icon}</span>
            <span className="truncate">{t.label}</span>
            {t.to === "/" && unreadCount > 0 ? (
              <span className="absolute right-1/4 top-1 rounded-full bg-red-600 px-1 text-[9px] font-bold leading-tight text-white">
                {unreadCount > 9 ? "9+" : unreadCount}
              </span>
            ) : null}
          </NavLink>
        ))}
        {needsMoreButton ? (
          <button
            type="button"
            className="flex flex-1 flex-col items-center justify-center gap-0.5 py-2 text-[11px] font-medium text-zinc-400"
            onClick={() => setMoreOpen(true)}
            aria-haspopup="true"
            aria-expanded={moreOpen}
          >
            <span className="text-lg leading-none" aria-hidden="true">⋯</span>
            <span>More</span>
          </button>
        ) : null}
      </nav>

      {/* "More" sheet — dismissible (backdrop tap or Escape), and since it
       *  only ever navigates or signs out, there's no entered data to lose
       *  on dismiss. */}
      {moreOpen ? (
        <MoreSheet
          tabs={overflowMobileTabs}
          userName={user?.name ?? ""}
          userRole={user?.role ?? ""}
          onClose={() => setMoreOpen(false)}
          onSignOut={() => void logout()}
        />
      ) : null}
    </div>
  );
}

function MoreSheet({
  tabs,
  userName,
  userRole,
  onClose,
  onSignOut,
}: {
  tabs: { to: string; label: string; icon: string; end?: boolean }[];
  userName: string;
  userRole: string;
  onClose: () => void;
  onSignOut: () => void;
}): React.JSX.Element {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-40 flex items-end bg-black/60 md:hidden" role="dialog" aria-modal="true" aria-label="More" onClick={onClose}>
      <div className="w-full rounded-t-2xl bg-zinc-900 p-3 pb-[calc(1rem+env(safe-area-inset-bottom))] shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="mx-auto mb-2 h-1 w-10 rounded-full bg-zinc-700" />
        <div className="mb-2 px-2">
          <div className="truncate text-sm font-medium text-zinc-100">{userName}</div>
          <div className="text-xs text-zinc-500">{userRole}</div>
        </div>
        <div className="grid grid-cols-3 gap-2">
          {tabs.map((t) => (
            <NavLink
              key={t.to}
              to={t.to}
              end={t.end}
              className="flex flex-col items-center gap-1 rounded-lg px-2 py-3 text-xs font-medium text-zinc-200 hover:bg-zinc-800"
            >
              <span className="text-xl" aria-hidden="true">{t.icon}</span>
              <span className="text-center leading-tight">{t.label}</span>
            </NavLink>
          ))}
        </div>
        <button className="btn mt-3 w-full" onClick={onSignOut}>
          Sign out
        </button>
      </div>
    </div>
  );
}
