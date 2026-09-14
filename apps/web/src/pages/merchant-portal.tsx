import React, { useCallback, useEffect, useState, type FormEvent } from "react";
import { Navigate, useNavigate } from "react-router-dom";
import { API } from "@ronmacrae/contracts";
import type { PlatformMessagesDto, ProductDto } from "@ronmacrae/contracts";
import { formatMoney, setAccessToken } from "../lib/api.js";
import { useAuth } from "../lib/auth.js";
import { PlatformChat } from "../components/platform-chat.js";

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
  const [error, setError] = useState<string | null>(null);
  const [merchantName, setMerchantName] = useState<string | null>(null);
  const [hasStaffAccess, setHasStaffAccess] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [orders, setOrders] = useState<PortalOrder[] | null>(null);
  const [tab, setTab] = useState<"orders" | "catalog" | "messages">("orders");
  const navigate = useNavigate();
  const { refresh: refreshStaffSession } = useAuth();

  function signOut() {
    sessionStorage.removeItem(STORAGE_KEY);
    setToken(null);
    setOrders(null);
    setMerchantName(null);
  }

  const loadDashboard = useCallback(async (tok: string) => {
    try {
      const [me, ordersRes] = await Promise.all([
        portalFetch<{ merchant: { name: string }; hasStaffAccess: boolean }>(API.merchantPortal.me, { headers: { authorization: `Bearer ${tok}` } }),
        portalFetch<{ orders: PortalOrder[] }>(API.merchantPortal.orders, { headers: { authorization: `Bearer ${tok}` } }),
      ]);
      setMerchantName(me.merchant.name);
      setHasStaffAccess(me.hasStaffAccess);
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

  async function switchToStaff() {
    if (!token) return;
    setSwitching(true);
    try {
      const body = await portalFetch<{ accessToken: string }>(API.merchantPortal.switchToStaff, {
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
  // own login: visiting it without a session goes to the same login
  // everyone else uses, which routes back here once it resolves to a
  // merchant workspace.
  if (!token) return <Navigate to="/" replace />;

  return (
    <div className="mx-auto max-w-3xl space-y-4 p-4">
      <header className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold">{merchantName ?? "Your store"}</h1>
          <p className="text-sm text-zinc-400">Orders placed through your store link.</p>
        </div>
        <div className="flex gap-2">
          {hasStaffAccess ? (
            <button className="btn !px-3 !py-1 text-xs" disabled={switching} onClick={() => void switchToStaff()}>
              {switching ? "Switching…" : "Switch to staff dashboard"}
            </button>
          ) : null}
          <button className="btn !px-3 !py-1 text-xs" onClick={signOut}>Sign out</button>
        </div>
      </header>

      <div className="flex gap-1 border-b border-zinc-800">
        <button className={`px-3 py-2 text-sm font-medium ${tab === "orders" ? "border-b-2 border-brand-accent text-brand-accent" : "text-zinc-400"}`} onClick={() => setTab("orders")}>Orders</button>
        <button className={`px-3 py-2 text-sm font-medium ${tab === "catalog" ? "border-b-2 border-brand-accent text-brand-accent" : "text-zinc-400"}`} onClick={() => setTab("catalog")}>Catalog</button>
        <button className={`px-3 py-2 text-sm font-medium ${tab === "messages" ? "border-b-2 border-brand-accent text-brand-accent" : "text-zinc-400"}`} onClick={() => setTab("messages")}>Messages</button>
      </div>

      {error ? <p className="text-sm text-red-400">{error}</p> : null}

      {tab === "orders" ? (
        <>
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
                  <span className="text-zinc-400">{o.paymentMethodLabel}{o.riderName ? ` · courier: ${o.riderName}` : ""}</span>
                  <span className="font-semibold">{formatMoney(o.total)}</span>
                </div>
                {o.status === "delivered" ? <RateOrder jobId={o.id} token={token} /> : null}
              </section>
            ))}
          </div>
        </>
      ) : tab === "catalog" ? (
        <Catalog token={token} />
      ) : (
        <section className="card">
          <p className="mb-2 text-sm text-zinc-400">A direct line to Platform Admin about your store.</p>
          <PlatformChat
            queryKey={`merchant-owner-${token}`}
            fetchMessages={() => portalFetch<PlatformMessagesDto>(API.merchantPortal.ownerMessages, { headers: { authorization: `Bearer ${token}` } })}
            sendMessage={(body) => portalFetch<PlatformMessagesDto>(API.merchantPortal.ownerMessages, { method: "POST", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ body }) })}
          />
        </section>
      )}
    </div>
  );
}

function Catalog({ token }: { token: string }): React.JSX.Element {
  const [products, setProducts] = useState<ProductDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const reload = useCallback(() => {
    portalFetch<{ products: ProductDto[] }>(API.merchantPortal.products, { headers: { authorization: `Bearer ${token}` } })
      .then((r) => setProducts(r.products))
      .catch((err) => setError(err instanceof PortalError ? err.message : "Could not load your catalog"));
  }, [token]);

  useEffect(() => reload(), [reload]);

  async function toggleActive(p: ProductDto) {
    try {
      await portalFetch(API.merchantPortal.updateProduct(p.id), {
        method: "PATCH",
        headers: { authorization: `Bearer ${token}` },
        body: JSON.stringify({ active: !p.active }),
      });
      reload();
    } catch (err) {
      setError(err instanceof PortalError ? err.message : "Could not update this product");
    }
  }

  async function remove(p: ProductDto) {
    try {
      await portalFetch(API.merchantPortal.deleteProduct(p.id), { method: "DELETE", headers: { authorization: `Bearer ${token}` } });
      reload();
    } catch (err) {
      setError(err instanceof PortalError ? err.message : "Could not remove this product");
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-zinc-400">What customers pick from on your order form.</p>
        <button className="btn-accent !px-3 !py-1 text-xs" onClick={() => setCreating((v) => !v)}>{creating ? "Cancel" : "+ Add product"}</button>
      </div>
      {error ? <p className="text-sm text-red-400">{error}</p> : null}
      {creating ? <CreateProductForm token={token} onDone={() => { setCreating(false); reload(); }} /> : null}
      {products === null ? <p className="text-sm text-zinc-400">Loading…</p> : null}
      {products && products.length === 0 ? <div className="card text-sm text-zinc-400">No products yet — customers will type free-text items until you add some.</div> : null}
      <div className="space-y-2">
        {products?.map((p) => (
          <div key={p.id} className={`card flex flex-wrap items-center justify-between gap-2 ${p.active ? "" : "opacity-60"}`}>
            <div>
              <p className="font-medium">{p.name}</p>
              <p className="text-xs text-zinc-500">{formatMoney(p.price)}{p.variants.length > 0 ? ` · ${p.variants.length} variant(s)` : ""}</p>
            </div>
            <div className="flex gap-2">
              <button type="button" className="btn !px-3 !py-1 text-xs" onClick={() => void toggleActive(p)}>{p.active ? "Deactivate" : "Activate"}</button>
              <button type="button" className="btn !px-3 !py-1 text-xs !border-red-800 !text-red-300" onClick={() => void remove(p)}>Delete</button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Spec: "Authorized... merchant may rate after a completed delivery." */
function RateOrder({ jobId, token }: { jobId: string; token: string }): React.JSX.Element {
  const [score, setScore] = useState(0);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(n: number) {
    setScore(n);
    setBusy(true);
    setError(null);
    try {
      await portalFetch(API.merchantPortal.rate(jobId), { method: "POST", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ score: n }) });
      setDone(true);
    } catch (err) {
      if (err instanceof PortalError && err.status === 409) setDone(true);
      else setError(err instanceof PortalError ? err.message : "Could not submit rating");
    } finally {
      setBusy(false);
    }
  }

  if (done) return <p className="text-xs text-emerald-400">Rated — thank you.</p>;
  return (
    <div className="flex items-center gap-1 text-lg">
      <span className="mr-1 text-xs text-zinc-500">Rate courier:</span>
      {[1, 2, 3, 4, 5].map((n) => (
        <button key={n} type="button" disabled={busy} className={n <= score ? "text-amber-400" : "text-zinc-700"} onClick={() => void submit(n)}>★</button>
      ))}
      {error ? <span className="ml-2 text-xs text-red-400">{error}</span> : null}
    </div>
  );
}

function CreateProductForm({ token, onDone }: { token: string; onDone: () => void }): React.JSX.Element {
  const [name, setName] = useState("");
  const [price, setPrice] = useState("");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await portalFetch(API.merchantPortal.createProduct, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
        body: JSON.stringify({ name, price: Number(price), description: description || undefined }),
      });
      onDone();
    } catch (err) {
      setError(err instanceof PortalError ? err.message : "Could not create this product");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="card space-y-3" onSubmit={(e) => void submit(e)}>
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label className="label" htmlFor="cp-name">Product name</label>
          <input id="cp-name" className="input" required value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div>
          <label className="label" htmlFor="cp-price">Price</label>
          <input id="cp-price" className="input" type="number" min={0} step="0.01" required value={price} onChange={(e) => setPrice(e.target.value)} />
        </div>
        <div className="sm:col-span-2">
          <label className="label" htmlFor="cp-desc">Description (optional)</label>
          <input id="cp-desc" className="input" value={description} onChange={(e) => setDescription(e.target.value)} />
        </div>
      </div>
      {error ? <p className="text-sm text-red-400">{error}</p> : null}
      <button className="btn-accent" disabled={busy || !name.trim() || !price}>{busy ? "Saving…" : "Add product"}</button>
    </form>
  );
}
