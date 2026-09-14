import React, { useCallback, useEffect, useState } from "react";
import { Navigate, useNavigate } from "react-router-dom";
import { API } from "@ronmacrae/contracts";
import type { PlatformMessagesDto } from "@ronmacrae/contracts";
import { setAccessToken } from "../lib/api.js";
import { useAuth } from "../lib/auth.js";
import { PlatformChat } from "../components/platform-chat.js";

const API_BASE = import.meta.env.VITE_API_BASE ?? "/api";
const STORAGE_KEY = "logisticsPortalToken";

class PortalError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Deliberately separate, minimal fetch helper — same reasoning as
 *  merchant-portal.tsx's portalFetch: this session has nothing to do with
 *  the staff session's refresh flow. */
async function portalFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const apiPath = path.startsWith("/api/") ? path.slice(4) : path;
  const res = await fetch(`${API_BASE}${apiPath}`, {
    ...init,
    headers: {
      ...(init.body != null ? { "content-type": "application/json" } : {}),
      ...init.headers,
    },
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
    throw new PortalError(res.status, body?.error?.message ?? `HTTP ${res.status}`);
  }
  return (await res.json()) as T;
}

interface FleetRider {
  id: string;
  name: string;
  phone: string;
  vehicle: string;
  status: string;
  active: boolean;
  platformStatus: string;
  dailyCapacity: number;
  activeJobCount: number;
}

const STATUS_LABEL: Record<string, string> = { offline: "Offline", available: "Available", on_job: "On a job", unavailable: "Unavailable" };
const STATUS_DOT: Record<string, string> = { offline: "bg-zinc-600", available: "bg-emerald-500", on_job: "bg-sky-500", unavailable: "bg-amber-500" };

/**
 * A logistics/bearer company's own login — a read-only fleet dashboard
 * scoped to exactly its own attached riders. Its own auth "face"
 * (logistics-portal.ts's logistics_portal token), same pattern as
 * merchant-portal.tsx. Which riders show up here is a Platform Admin
 * decision (Rider.attachedLogisticsCompanyId) — this portal can look, not
 * assign.
 */
export function LogisticsPortal(): React.JSX.Element {
  const [token, setToken] = useState<string | null>(() => sessionStorage.getItem(STORAGE_KEY));
  const [error, setError] = useState<string | null>(null);
  const [companyName, setCompanyName] = useState<string | null>(null);
  const [hasStaffAccess, setHasStaffAccess] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [riders, setRiders] = useState<FleetRider[] | null>(null);
  const [chattingWith, setChattingWith] = useState<string | null>(null);
  const [showOwnerChat, setShowOwnerChat] = useState(false);
  const navigate = useNavigate();
  const { refresh: refreshStaffSession } = useAuth();

  function signOut() {
    sessionStorage.removeItem(STORAGE_KEY);
    setToken(null);
    setRiders(null);
    setCompanyName(null);
  }

  const loadDashboard = useCallback(async (tok: string) => {
    try {
      const [me, ridersRes] = await Promise.all([
        portalFetch<{ logisticsCompany: { name: string }; hasStaffAccess: boolean }>(API.logisticsPortal.me, { headers: { authorization: `Bearer ${tok}` } }),
        portalFetch<{ riders: FleetRider[] }>(API.logisticsPortal.riders, { headers: { authorization: `Bearer ${tok}` } }),
      ]);
      setCompanyName(me.logisticsCompany.name);
      setHasStaffAccess(me.hasStaffAccess);
      setRiders(ridersRes.riders);
    } catch (err) {
      if (err instanceof PortalError && err.status === 401) {
        signOut();
      } else {
        setError(err instanceof PortalError ? err.message : "Could not load your fleet dashboard");
      }
    }
  }, []);

  useEffect(() => {
    if (token) void loadDashboard(token);
  }, [token, loadDashboard]);

  async function switchToStaff() {
    if (!token) return;
    setSwitching(true);
    try {
      const body = await portalFetch<{ accessToken: string }>(API.logisticsPortal.switchToStaff, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
      });
      setAccessToken(body.accessToken);
      await refreshStaffSession();
      navigate("/");
    } catch (err) {
      setError(err instanceof PortalError ? err.message : "Could not switch workspace");
    } finally {
      setSwitching(false);
    }
  }

  // One shared sign-in for everyone — this page is a destination, not its
  // own login, same rule as merchant-portal.tsx.
  if (!token) return <Navigate to="/" replace />;

  return (
    <div className="mx-auto max-w-3xl space-y-4 p-4">
      <header className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold">{companyName ?? "Your fleet"}</h1>
          <p className="text-sm text-zinc-400">Couriers Platform Admin has attached to your company.</p>
        </div>
        <div className="flex gap-2">
          {hasStaffAccess ? (
            <button className="btn !px-3 !py-1 text-xs" disabled={switching} onClick={() => void switchToStaff()}>
              {switching ? "Switching…" : "Switch to staff dashboard"}
            </button>
          ) : null}
          <button className="btn !px-3 !py-1 text-xs" onClick={() => setShowOwnerChat((v) => !v)}>
            {showOwnerChat ? "Hide messages" : "Message Platform Admin"}
          </button>
          <button className="btn !px-3 !py-1 text-xs" onClick={signOut}>Sign out</button>
        </div>
      </header>

      {showOwnerChat ? (
        <section className="card">
          <PlatformChat
            queryKey={`logistics-owner-${token}`}
            fetchMessages={() => portalFetch<PlatformMessagesDto>(API.logisticsPortal.ownerMessages, { headers: { authorization: `Bearer ${token}` } })}
            sendMessage={(body) => portalFetch<PlatformMessagesDto>(API.logisticsPortal.ownerMessages, { method: "POST", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ body }) })}
          />
        </section>
      ) : null}

      {error ? <p className="text-sm text-red-400">{error}</p> : null}

      {riders === null ? <p className="text-sm text-zinc-400">Loading…</p> : null}
      {riders && riders.length === 0 ? (
        <div className="card text-sm text-zinc-400">No couriers attached yet — ask Platform Admin to attach couriers to your company.</div>
      ) : null}
      <div className="space-y-2">
        {riders?.map((r) => (
          <div key={r.id} className={`card space-y-2 ${r.active ? "" : "opacity-60"}`}>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <p className="font-medium">{r.name}</p>
                <p className="text-xs text-zinc-500">{r.phone} · {r.vehicle} · {r.activeJobCount}/{r.dailyCapacity} active jobs</p>
              </div>
              <div className="flex items-center gap-2">
                {!r.active ? <span className="rounded bg-zinc-800 px-2 py-0.5 text-xs font-medium text-zinc-500">Disabled</span> : null}
                <span className="flex items-center gap-1.5 rounded bg-zinc-800 px-2 py-0.5 text-xs font-medium text-zinc-300">
                  <span className={`h-2 w-2 rounded-full ${STATUS_DOT[r.status] ?? "bg-zinc-600"}`} />
                  {STATUS_LABEL[r.status] ?? r.status}
                </span>
                <button type="button" className="btn !px-3 !py-1 text-xs" onClick={() => setChattingWith(chattingWith === r.id ? null : r.id)}>
                  {chattingWith === r.id ? "Hide chat" : "Message"}
                </button>
              </div>
            </div>
            {chattingWith === r.id ? (
              <PlatformChat
                queryKey={`fleet-${r.id}`}
                fetchMessages={() => portalFetch<PlatformMessagesDto>(API.logisticsPortal.riderMessages(r.id), { headers: { authorization: `Bearer ${token}` } })}
                sendMessage={(body) => portalFetch<PlatformMessagesDto>(API.logisticsPortal.riderMessages(r.id), { method: "POST", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ body }) })}
              />
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
}
