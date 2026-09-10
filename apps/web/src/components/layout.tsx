import type React from "react";
import { NavLink } from "react-router-dom";
import { useAuth } from "../lib/auth.js";
import { AlertsToaster } from "./alerts-toaster.js";

const TABS = [
  { to: "/", label: "Dashboard", end: true },
  { to: "/jobs", label: "Jobs", end: true },
  { to: "/jobs/new", label: "New Order" },
  { to: "/zones", label: "Zones & Fares" },
  { to: "/notifications", label: "Notifications" },
];

export function Layout({ children }: { children: React.ReactNode }): React.JSX.Element {
  const { user, logout } = useAuth();
  const tabs = user?.role === "rider" ? TABS.filter((t) => t.to !== "/jobs" && t.to !== "/jobs/new") : TABS;
  return (
    <div className="flex h-full min-h-dvh flex-col md:flex-row">
      <AlertsToaster />
      <aside className="flex shrink-0 flex-col gap-1 border-b border-zinc-800 bg-zinc-900/60 p-4 md:w-56 md:border-b-0 md:border-r">
        <div className="mb-4">
          <div className="text-base font-bold text-brand-accent">Ronmacrae</div>
          <div className="text-xs uppercase tracking-widest text-zinc-400">Dispatch</div>
        </div>
        <nav className="flex gap-1 overflow-x-auto md:flex-col">
          {tabs.map((t) => (
            <NavLink
              key={t.to}
              to={t.to}
              end={t.end}
              className={({ isActive }) =>
                `whitespace-nowrap rounded-lg px-3 py-2 text-sm font-medium transition ${
                  isActive ? "bg-brand text-white" : "text-zinc-300 hover:bg-zinc-800"
                }`
              }
            >
              {t.label}
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
