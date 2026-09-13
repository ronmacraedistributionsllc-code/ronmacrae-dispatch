import React, { useCallback, useEffect, useState, type FormEvent } from "react";
import { API } from "@ronmacrae/contracts";
import { formatMoney } from "../lib/api.js";

const API_BASE = import.meta.env.VITE_API_BASE ?? "/api";
const STORAGE_KEY = "merchantPortalToken";

class PortalError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * A deliberately separate, minimal fetch helper — not the shared apiFetch()
 * from lib/api.ts. That helper's 401 handling tries to refresh the *staff*
 * session; a merchant-portal session has nothing to do with that and no
 * refresh flow of its own (see my-packages.tsx's own dashboardFetch, same
 * reasoning, same shape).
 */
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

interface PortalOrder {
  id: string;
  jobNumber: string | null;
  status: string;
  createdAt: string;
  scheduledAt: string | null;
  customerName: string;
  customerPhone: string;
  addressText: string | null;
  items: { name: string; quantity: number; size: string | null; color: string | null; unitPrice: { amount: number; currency: string } }[];
  subtotal: { amount: number; currency: string } | null;
  total: { amount: number; currency: string } | null;
  paymentMethodLabel: string;
  riderName: string | null;
}

/**
 * A merchant's own login — view-only, scoped to exactly its own orders.
 * Its own auth "face" (merchant-portal.ts's merchant_portal token), same
 * pattern as the customer dashboard and rider bearer face: a separate
 * token, separate storage key, separate fetch helper, never mixed with
 * the staff session.
 */
export function MerchantPortal(): React.JSX.Element {
  const [token, setToken] = useState<string | null>(() => sessionStorage.getItem(STORAGE_KEY));
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [merchantName, setMerchantName] = useState<string | null>(null);
  const [orders, setOrders] = useState<PortalOrder[] | null>(null);

  function signOut() {
    sessionStorage.removeItem(STORAGE_KEY);
    setToken(null);
    setOrders(null);
    setMerchantName(null);
  }

  const loadDashboard = useCallback(async (tok: string) => {
    try {
      const [me, ordersRes] = await Promise.all([
        portalFetch<{ merchant: { name: string } }>(API.merchantPortal.me, { headers: { authorization: `Bearer ${tok}` } }),
        portalFetch<{ orders: PortalOrder[] }>(API.merchantPortal.orders, { headers: { authorization: `Bearer ${tok}` } }),
      ]);
      setMerchantName(me.merchant.name);
      setOrders(ordersRes.orders);
    } catch (err) {
      if (err instanceof PortalError && err.status === 401) {
        signOut();
      } else {
        setError(err instanceof PortalError ? err.message : "Could not load your dashboard");
      }
    }
  }, []);

  useEffect(() => {
    if (token) void loadDashboard(token);
  }, [token, loadDashboard]);

  async function login(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const body = await portalFetch<{ token: string; merchant: { name: string } }>(API.merchantPortal.login, {
        method: "POST",
        body: JSON.stringify({ email, password }),
      });
      sessionStorage.setItem(STORAGE_KEY, body.token);
      setToken(body.token);
      setMerchantName(body.merchant.name);
    } catch (err) {
      setError(err instanceof PortalError ? err.message : "Could not sign in");
    } finally {
      setBusy(false);
    }
  }

  if (!token) {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-zinc-950 p-4">
        <form onSubmit={(e) => void login(e)} className="card w-full max-w-sm space-y-4">
          <div className="text-center">
            <h1 className="text-lg font-bold text-brand-accent">Merchant Portal</h1>
            <p className="text-sm text-zinc-400">View orders placed through your store link.</p>
          </div>
          <div>
            <label className="label" htmlFor="mp-email">Email</label>
            <input id="mp-email" type="email" className="input" required autoFocus value={email} onChange={(e) => setEmail(e.target.value)} />
          </div>
          <div>
            <label className="label" htmlFor="mp-password">Password</label>
            <input id="mp-password" type="password" className="input" required value={password} onChange={(e) => setPassword(e.target.value)} />
          </div>
          {error ? <p className="text-sm text-red-400">{error}</p> : null}
          <button className="btn-accent w-full" disabled={busy}>{busy ? "Signing in…" : "Sign in"}</button>
          <p className="text-center text-xs text-zinc-500">Don't have portal access? Ask your dispatch contact to set it up.</p>
        </form>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl space-y-4 p-4">
      <header className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold">{merchantName ?? "Your store"}</h1>
          <p className="text-sm text-zinc-400">Orders placed through your store link.</p>
        </div>
        <button className="btn !px-3 !py-1 text-xs" onClick={signOut}>Sign out</button>
      </header>

      {error ? <p className="text-sm text-red-400">{error}</p> : null}
      {orders === null ? <p className="text-sm text-zinc-400">Loading…</p> : null}
      {orders && orders.length === 0 ? <div className="card text-sm text-zinc-400">No orders yet.</div> : null}

      <div className="space-y-3">
        {orders?.map((o) => (
          <section key={o.id} className="card space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h2 className="font-semibold">{o.jobNumber ?? o.id.slice(0, 8)}</h2>
                <p className="text-xs text-zinc-500">{o.customerName} · {o.customerPhone}</p>
              </div>
              <span className="rounded bg-zinc-800 px-2 py-0.5 text-xs font-medium text-zinc-300">{o.status}</span>
            </div>
            <p className="text-sm text-zinc-300">{o.addressText ?? "No address given"}</p>
            <ul className="text-sm text-zinc-400">
              {o.items.map((it, i) => (
                <li key={i}>{it.quantity}× {it.name}{it.size ? ` (${it.size})` : ""} — {formatMoney(it.unitPrice)}</li>
              ))}
            </ul>
            <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
              <span className="text-zinc-400">{o.paymentMethodLabel}{o.riderName ? ` · rider: ${o.riderName}` : ""}</span>
              <span className="font-semibold">{formatMoney(o.total)}</span>
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}
