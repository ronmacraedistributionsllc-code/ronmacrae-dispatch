import type React from "react";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "../lib/auth.js";
import { RiderDashboard } from "./rider-dashboard.js";
import { apiFetch, formatMoney } from "../lib/api.js";
import type { OutboxMessageDto, UserDto, ZoneDto } from "@ronmacrae/contracts";

interface Health {
  ok: boolean;
  service: string;
  queue: string;
  notifications: string;
  geo: string;
  web: boolean;
}

export function Dashboard(): React.JSX.Element {
  const { user } = useAuth();
  return user?.role === "rider" ? <RiderDashboard /> : <DispatcherDashboard />;
}

function DispatcherDashboard(): React.JSX.Element {
  const { user } = useAuth();
  const health = useQuery({ queryKey: ["health"], queryFn: () => apiFetch<Health>("/health"), retry: false });
  const zones = useQuery({ queryKey: ["zones"], queryFn: () => apiFetch<{ zones: ZoneDto[] }>("/zones") });
  const users = useQuery({ queryKey: ["users"], queryFn: () => apiFetch<{ users: UserDto[] }>("/users") });
  const outbox = useQuery({
    queryKey: ["notifications"],
    queryFn: () => apiFetch<{ messages: OutboxMessageDto[] }>("/notifications?take=8"),
    refetchInterval: 15_000,
  });

  return (
    <div className="space-y-4">
      <header>
        <h1 className="text-xl font-bold">
          Welcome back, {user?.name?.split(" ")[0]}
        </h1>
        <p className="text-sm text-zinc-400">Dispatcher overview</p>
      </header>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <div className="card">
          <div className="label">API</div>
          <div className={`text-lg font-semibold ${health.data?.ok ? "text-emerald-400" : "text-red-400"}`}>
            {health.data?.ok ? "Healthy" : "Unreachable"}
          </div>
          {health.data ? (
            <div className="mt-1 text-xs text-zinc-500">
              queue: {health.data.queue} · notify: {health.data.notifications} · geo: {health.data.geo}
            </div>
          ) : null}
        </div>
        <div className="card">
          <div className="label">Zones</div>
          <div className="text-lg font-semibold">{zones.data?.zones.length ?? "–"}</div>
          <div className="mt-1 truncate text-xs text-zinc-500">
            {zones.data?.zones.map((z) => z.name).join(" · ") ?? "deliverable areas"}
          </div>
        </div>
        <div className="card">
          <div className="label">Staff</div>
          <div className="text-lg font-semibold">{users.data?.users.length ?? "–"}</div>
          <div className="mt-1 text-xs text-zinc-500">users with portal access</div>
        </div>
        <div className="card">
          <div className="label">Outbox</div>
          <div className="text-lg font-semibold">{outbox.data?.messages.length ?? "–"}</div>
          <div className="mt-1 text-xs text-zinc-500">recent customer messages</div>
        </div>
      </div>

      <section className="card">
        <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-zinc-400">Latest notifications</h2>
        {outbox.data && outbox.data.messages.length > 0 ? (
          <ul className="divide-y divide-zinc-800">
            {outbox.data.messages.map((m) => (
              <li key={m.id} className="flex items-center gap-3 py-2 text-sm">
                <span
                  className={`w-20 shrink-0 rounded px-2 py-0.5 text-center text-xs font-medium ${
                    m.status === "delivered"
                      ? "bg-emerald-900/50 text-emerald-300"
                      : m.status === "failed"
                        ? "bg-red-900/50 text-red-300"
                        : "bg-zinc-800 text-zinc-300"
                  }`}
                >
                  {m.status}
                </span>
                <span className="truncate text-zinc-300">
                  {m.template} → {m.to}
                </span>
                <span className="ml-auto shrink-0 text-xs text-zinc-500">
                  {new Date(m.createdAt).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-zinc-500">No customer messages yet — they appear here as jobs move.</p>
        )}
      </section>

      <section className="card">
        <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-zinc-400">Fare preview</h2>
        <p className="text-sm text-zinc-400">
          Use <span className="text-brand-accent">Zones &amp; Fares</span> to quote a delivery fee for any two
          points.
        </p>
        {zones.data ? (
          <div className="mt-3 flex flex-wrap gap-2">
            {zones.data.zones.map((z) => (
              <span key={z.id} className="rounded-full border border-zinc-700 px-3 py-1 text-xs text-zinc-300">
                {z.name} · {formatMoney(z.baseFee)} base
              </span>
            ))}
          </div>
        ) : null}
      </section>
    </div>
  );
}
