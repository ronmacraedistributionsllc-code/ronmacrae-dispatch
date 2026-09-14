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
  const [rating, setRating] = useState<{ average: number | null; count: number } | null>(null);
  const [hasStaffAccess, setHasStaffAccess] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [orders, setOrders] = useState<PortalOrder[] | null>(null);
  const [tab, setTab] = useState<"orders" | "catalog" | "couriers" | "messages">("orders");
  const [booking, setBooking] = useState(false);
  const navigate = useNavigate();
  const { refresh: refreshStaffSession } = useAuth();

  const reloadOrders = useCallback((tok: string) => {
    portalFetch<{ orders: PortalOrder[] }>(API.merchantPortal.orders, { headers: { authorization: `Bearer ${tok}` } })
      .then((r) => setOrders(r.orders))
      .catch((err) => setError(err instanceof PortalError ? err.message : "Could not load your orders"));
  }, []);

  function signOut() {
    sessionStorage.removeItem(STORAGE_KEY);
    setToken(null);
    setOrders(null);
    setMerchantName(null);
  }

  const loadDashboard = useCallback(async (tok: string) => {
    try {
      const [me, ordersRes] = await Promise.all([
        portalFetch<{ merchant: { name: string }; rating: { average: number | null; count: number }; hasStaffAccess: boolean }>(API.merchantPortal.me, { headers: { authorization: `Bearer ${tok}` } }),
        portalFetch<{ orders: PortalOrder[] }>(API.merchantPortal.orders, { headers: { authorization: `Bearer ${tok}` } }),
      ]);
      setMerchantName(me.merchant.name);
      setRating(me.rating);
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
          <p className="text-sm text-zinc-400">
            {rating && rating.count > 0
              ? `★ ${rating.average?.toFixed(1)} · ${rating.count} rating${rating.count === 1 ? "" : "s"}`
              : "Orders placed through your store link."}
          </p>
        </div>
        <div className="flex gap-2">
          <button className="btn-accent !px-3 !py-1 text-xs" onClick={() => setBooking((v) => !v)}>{booking ? "Cancel" : "+ Book Delivery"}</button>
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
        <button className={`px-3 py-2 text-sm font-medium ${tab === "couriers" ? "border-b-2 border-brand-accent text-brand-accent" : "text-zinc-400"}`} onClick={() => setTab("couriers")}>Couriers</button>
        <button className={`px-3 py-2 text-sm font-medium ${tab === "messages" ? "border-b-2 border-brand-accent text-brand-accent" : "text-zinc-400"}`} onClick={() => setTab("messages")}>Messages</button>
      </div>

      {error ? <p className="text-sm text-red-400">{error}</p> : null}

      {tab === "orders" ? (
        <>
          {booking && token ? (
            <BookDeliveryForm token={token} onDone={() => { setBooking(false); reloadOrders(token); }} />
          ) : null}
          {orders === null ? <p className="text-sm text-zinc-400">Loading…</p> : null}
          {orders && orders.length === 0 ? <div className="card text-sm text-zinc-400">No orders yet — book one above.</div> : null}
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
                {(o.status === "new" || o.status === "assigned") && token ? (
                  <AssignCourier token={token} order={o} onAssigned={() => reloadOrders(token)} />
                ) : null}
                {o.status === "delivered" ? <RateOrder jobId={o.id} token={token} /> : null}
              </section>
            ))}
          </div>
        </>
      ) : tab === "catalog" ? (
        <Catalog token={token} />
      ) : tab === "couriers" ? (
        <Couriers token={token} />
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

interface BookItem {
  name: string;
  quantity: number;
  unitPrice: string;
  saveToCatalog: boolean;
}

/** A merchant books a delivery on behalf of a customer (spec: merchant
 *  book-delivery). Pickup is the merchant's own saved address (server-side);
 *  free-text items can optionally be saved into this merchant's catalog. */
function BookDeliveryForm({ token, onDone }: { token: string; onDone: () => void }): React.JSX.Element {
  const [customerName, setCustomerName] = useState("");
  const [customerPhone, setCustomerPhone] = useState("");
  const [customerEmail, setCustomerEmail] = useState("");
  const [addressText, setAddressText] = useState("");
  const [instructions, setInstructions] = useState("");
  const [paymentMethod, setPaymentMethod] = useState("cod");
  const [items, setItems] = useState<BookItem[]>([{ name: "", quantity: 1, unitPrice: "", saveToCatalog: false }]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function updateItem(i: number, patch: Partial<BookItem>) {
    setItems((prev) => prev.map((it, idx) => (idx === i ? { ...it, ...patch } : it)));
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await portalFetch(API.merchantPortal.createOrder, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
        body: JSON.stringify({
          customerName,
          customerPhone,
          customerEmail: customerEmail || undefined,
          addressText,
          instructions: instructions || undefined,
          paymentMethod,
          items: items
            .filter((it) => it.name.trim().length > 0)
            .map((it) => ({ name: it.name.trim(), quantity: it.quantity, unitPrice: it.unitPrice ? Number(it.unitPrice) : undefined, saveToCatalog: it.saveToCatalog })),
        }),
      });
      onDone();
    } catch (err) {
      setError(err instanceof PortalError ? err.message : "Could not book this delivery");
    } finally {
      setBusy(false);
    }
  }

  const canSubmit = customerName.trim().length > 0 && customerPhone.replace(/[^\d]/g, "").length >= 7 && addressText.trim().length >= 3 && items.some((it) => it.name.trim().length > 0);

  return (
    <form className="card space-y-3" onSubmit={(e) => void submit(e)}>
      <h2 className="font-semibold">Book a delivery</h2>
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label className="label" htmlFor="b-cname">Customer name</label>
          <input id="b-cname" className="input" required value={customerName} onChange={(e) => setCustomerName(e.target.value)} />
        </div>
        <div>
          <label className="label" htmlFor="b-cphone">Customer phone</label>
          <input id="b-cphone" className="input" required value={customerPhone} onChange={(e) => setCustomerPhone(e.target.value)} placeholder="876 555 1234" />
        </div>
        <div className="sm:col-span-2">
          <label className="label" htmlFor="b-cemail">Customer email (optional)</label>
          <input id="b-cemail" type="email" className="input" value={customerEmail} onChange={(e) => setCustomerEmail(e.target.value)} />
        </div>
        <div className="sm:col-span-2">
          <label className="label" htmlFor="b-addr">Drop-off address</label>
          <input id="b-addr" className="input" required value={addressText} onChange={(e) => setAddressText(e.target.value)} />
        </div>
      </div>

      <div className="space-y-2">
        <p className="text-sm text-zinc-400">Items</p>
        {items.map((it, i) => (
          <div key={i} className="grid gap-2 sm:grid-cols-[1fr_4rem_6rem_auto]">
            <input className="input" placeholder="Item / product" value={it.name} onChange={(e) => updateItem(i, { name: e.target.value })} />
            <input className="input" type="number" min={1} value={it.quantity} onChange={(e) => updateItem(i, { quantity: Number(e.target.value) || 1 })} />
            <input className="input" type="number" min={0} step="0.01" placeholder="Price" value={it.unitPrice} onChange={(e) => updateItem(i, { unitPrice: e.target.value })} />
            <button type="button" className="btn !px-2 !py-1 text-xs !border-red-800 !text-red-300" onClick={() => setItems((prev) => prev.filter((_, idx) => idx !== i))}>✕</button>
          </div>
        ))}
        <div className="flex flex-wrap items-center justify-between gap-2">
          <button type="button" className="btn !px-3 !py-1 text-xs" onClick={() => setItems((prev) => [...prev, { name: "", quantity: 1, unitPrice: "", saveToCatalog: false }])}>+ Add item</button>
          <label className="flex items-center gap-2 text-xs text-zinc-400">
            <input type="checkbox" checked={items.some((it) => it.saveToCatalog)} onChange={(e) => setItems((prev) => prev.map((it) => ({ ...it, saveToCatalog: e.target.checked })))} />
            Add these items to my catalog
          </label>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label className="label" htmlFor="b-pay">Payment method</label>
          <select id="b-pay" className="input" value={paymentMethod} onChange={(e) => setPaymentMethod(e.target.value)}>
            <option value="cod">Cash on delivery</option>
            <option value="online">Online</option>
            <option value="card">Card</option>
            <option value="transfer">Transfer</option>
            <option value="paid_at_store">Paid at store</option>
          </select>
        </div>
        <div>
          <label className="label" htmlFor="b-instr">Instructions (optional)</label>
          <input id="b-instr" className="input" value={instructions} onChange={(e) => setInstructions(e.target.value)} />
        </div>
      </div>

      {error ? <p className="text-sm text-red-400">{error}</p> : null}
      <button className="btn-accent" disabled={busy || !canSubmit}>{busy ? "Booking…" : "Book delivery"}</button>
    </form>
  );
}

/** Assign one of this merchant's own couriers to one of its own orders
 *  (spec: merchant delivery assignment) — the roster is this merchant's
 *  MerchantRider list, never another merchant's. */
function AssignCourier({ token, order, onAssigned }: { token: string; order: PortalOrder; onAssigned: () => void }): React.JSX.Element {
  const [riders, setRiders] = useState<MerchantRider[] | null>(null);
  const [selected, setSelected] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    portalFetch<{ riders: MerchantRider[] }>(API.merchantPortal.riders, { headers: { authorization: `Bearer ${token}` } })
      .then((r) => setRiders(r.riders))
      .catch(() => setRiders([]));
  }, [token]);

  async function assign() {
    setBusy(true);
    setError(null);
    try {
      await portalFetch(API.merchantPortal.assignRider(order.id), { method: "POST", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ riderId: selected }) });
      onAssigned();
    } catch (err) {
      setError(err instanceof PortalError ? err.message : "Could not assign courier");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border border-zinc-800 p-2">
      <select className="input !w-auto !py-1 text-xs" value={selected} disabled={busy} onChange={(e) => setSelected(e.target.value)}>
        <option value="" disabled>Assign courier…</option>
        {(riders ?? []).map((r) => (
          <option key={r.id} value={r.id}>{r.name} ({r.vehicle})</option>
        ))}
      </select>
      <button className="btn !px-3 !py-1 text-xs" disabled={busy || !selected} onClick={() => void assign()}>Assign</button>
      {error ? <span className="text-xs text-red-400">{error}</span> : null}
    </div>
  );
}

interface MerchantRider {
  id: string;
  name: string;
  phone: string;
  vehicle: string;
  plate: string | null;
  status: string;
  active: boolean;
  platformStatus: string;
  addedAt: string;
}

interface RiderSearchResult {
  id: string;
  name: string;
  phone: string;
  vehicle: string;
  active: boolean;
  platformStatus: string;
  alreadyAttached: boolean;
}

const RIDER_STATUS_LABEL: Record<string, string> = { offline: "Offline", available: "Available", on_job: "On a job", unavailable: "Unavailable" };

/**
 * A merchant's own courier roster (spec: merchant rider management) —
 * real MerchantRider data, not a mock list. Add searches the central rider
 * registry; remove detaches only this merchant's relationship, never the
 * courier's platform account.
 */
function Couriers({ token }: { token: string }): React.JSX.Element {
  const [riders, setRiders] = useState<MerchantRider[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [q, setQ] = useState("");
  const [results, setResults] = useState<RiderSearchResult[] | null>(null);

  const reload = useCallback(() => {
    portalFetch<{ riders: MerchantRider[] }>(API.merchantPortal.riders, { headers: { authorization: `Bearer ${token}` } })
      .then((r) => setRiders(r.riders))
      .catch((err) => setError(err instanceof PortalError ? err.message : "Could not load your couriers"));
  }, [token]);

  useEffect(() => reload(), [reload]);

  function search(term: string) {
    setQ(term);
    portalFetch<{ riders: RiderSearchResult[] }>(`${API.merchantPortal.riderSearch}?q=${encodeURIComponent(term)}`, { headers: { authorization: `Bearer ${token}` } })
      .then((r) => setResults(r.riders))
      .catch((err) => setError(err instanceof PortalError ? err.message : "Could not search couriers"));
  }

  async function add(riderId: string) {
    setError(null);
    try {
      await portalFetch(API.merchantPortal.addRider, { method: "POST", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ riderId }) });
      setAdding(false);
      setQ("");
      setResults(null);
      reload();
    } catch (err) {
      setError(err instanceof PortalError ? err.message : "Could not add this courier");
    }
  }

  async function remove(riderId: string) {
    setError(null);
    try {
      await portalFetch(API.merchantPortal.removeRider(riderId), { method: "DELETE", headers: { authorization: `Bearer ${token}` } });
      reload();
    } catch (err) {
      setError(err instanceof PortalError ? err.message : "Could not remove this courier");
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-zinc-400">Couriers attached to your store.</p>
        <button className="btn-accent !px-3 !py-1 text-xs" onClick={() => { setAdding((v) => !v); setResults(null); setQ(""); }}>{adding ? "Cancel" : "+ Add courier"}</button>
      </div>
      {error ? <p className="text-sm text-red-400">{error}</p> : null}

      {adding ? (
        <div className="card space-y-2">
          <p className="text-sm text-zinc-400">Find an existing courier by name, phone, or email.</p>
          <input className="input" autoFocus placeholder="Search couriers…" value={q} onChange={(e) => search(e.target.value)} />
          {results === null ? null : results.length === 0 ? <p className="text-sm text-zinc-500">No couriers match that search.</p> : null}
          <div className="space-y-2">
            {results?.map((r) => (
              <div key={r.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-zinc-800 p-2">
                <div>
                  <p className="text-sm font-medium">{r.name} <span className="text-xs text-zinc-500">· {r.vehicle}</span></p>
                  <p className="text-xs text-zinc-500">{r.phone}{!r.active ? " · disabled" : ""}</p>
                </div>
                {r.alreadyAttached ? (
                  <span className="text-xs text-zinc-500">Already attached</span>
                ) : (
                  <button className="btn !px-3 !py-1 text-xs" onClick={() => void add(r.id)}>Add</button>
                )}
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {riders === null ? <p className="text-sm text-zinc-400">Loading…</p> : null}
      {riders && riders.length === 0 ? <div className="card text-sm text-zinc-400">No couriers attached yet — add one above.</div> : null}
      <div className="space-y-2">
        {riders?.map((r) => (
          <div key={r.id} className={`card flex flex-wrap items-center justify-between gap-2 ${r.active ? "" : "opacity-60"}`}>
            <div>
              <p className="font-medium">{r.name} <span className="text-xs text-zinc-500">· {r.vehicle}{r.plate ? ` · ${r.plate}` : ""}</span></p>
              <p className="text-xs text-zinc-500">
                {r.phone} · {RIDER_STATUS_LABEL[r.status] ?? r.status}
                {r.platformStatus !== "approved" ? ` · ${r.platformStatus}` : ""} · added {new Date(r.addedAt).toLocaleDateString()}
              </p>
            </div>
            <div className="flex items-center gap-2">
              {!r.active ? <span className="rounded bg-zinc-800 px-2 py-0.5 text-xs font-medium text-zinc-500">Disabled</span> : null}
              <button type="button" className="btn !px-3 !py-1 text-xs !border-red-800 !text-red-300" onClick={() => void remove(r.id)}>Remove</button>
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
