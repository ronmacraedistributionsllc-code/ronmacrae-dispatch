import React, { useState } from "react";
import { Link } from "react-router-dom";
import { ApiError } from "../lib/api.js";

/** Public "book a delivery" form for the store's customers (no sign-in). */
export function Book(): React.JSX.Element {
  const [form, setForm] = useState({
    name: "",
    phone: "",
    pickup: "",
    destination: "",
    landmark: "",
    product: "",
    colour: "",
    size: "",
    quantity: "1",
    orderValue: "",
    payment: "cod" as "cod" | "online",
    requestedTime: "",
    instructions: "",
    consent: true,
  });
  const set = (patch: Partial<typeof form>) => setForm((f) => ({ ...f, ...patch }));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ jobNumber: string | null; customerName: string; tracking: { token: string } | null } | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const money = (raw: string) => {
        const n = Number(raw);
        return raw.trim() !== "" && Number.isFinite(n) && n > 0 ? n : null;
      };
      const body = await fetchDeliveries({
        ...form,
        name: form.name.trim(),
        phone: form.phone.trim(),
        destination: form.destination.trim(),
        landmark: form.landmark.trim() || null,
        pickup: form.pickup.trim() || null,
        product: form.product.trim() || null,
        colour: form.colour.trim() || null,
        size: form.size.trim() || null,
        quantity: Math.min(999, Math.max(1, Number(form.quantity) || 1)),
        orderValue: money(form.orderValue),
        requestedTime: form.requestedTime ? new Date(form.requestedTime).toISOString() : null,
        instructions: form.instructions.trim() || null,
      });
      setResult(body);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Booking failed, please try again");
    } finally {
      setBusy(false);
    }
  };

  const trackUrl = result?.tracking ? `${window.location.origin}/track/${result.tracking.token}` : null;

  return (
    <div className="mx-auto max-w-2xl space-y-4 p-4">
      <header>
        <h1 className="text-xl font-bold">Book a delivery</h1>
        <p className="text-sm text-zinc-400">Ronmacrae Distributions — we deliver your order to your door</p>
      </header>

      {result ? (
        <section className="card border-emerald-800/60 bg-emerald-950/30">
          <h2 className="text-base font-semibold text-emerald-300">
            {result.jobNumber ? `Order ${result.jobNumber} is booked` : "Order is booked"}
          </h2>
          <p className="mt-1 text-sm text-zinc-400">
            Thanks {result.customerName.split(" ")[0]} — we'll be in touch about your delivery.
          </p>
          {result.tracking ? (
            <div className="mt-3 space-y-2">
              <div className="label">Track your delivery</div>
              <a className="btn-accent" href={trackUrl ?? "#"} target="_blank" rel="noreferrer">
                Open your tracking page
              </a>
              <p className="break-all text-xs text-zinc-500">{trackUrl}</p>
            </div>
          ) : null}
          <Link className="btn mt-4" to="/login">
            Staff sign-in
          </Link>
        </section>
      ) : (
        <form onSubmit={(e) => void submit(e)} className="card space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className="label" htmlFor="bk-name">
                Your name
              </label>
              <input id="bk-name" className="input" required value={form.name} onChange={(e) => set({ name: e.target.value })} placeholder="Full name" />
            </div>
            <div>
              <label className="label" htmlFor="bk-phone">
                Phone
              </label>
              <input id="bk-phone" className="input" required type="tel" value={form.phone} onChange={(e) => set({ phone: e.target.value })} placeholder="876 555 1234" />
            </div>
            <div>
              <label className="label" htmlFor="bk-pickup">
                Pickup (optional)
              </label>
              <input id="bk-pickup" className="input" value={form.pickup} onChange={(e) => set({ pickup: e.target.value })} placeholder="Where the courier picks up, if not the store" />
            </div>
            <div>
              <label className="label" htmlFor="bk-destination">
                Deliver to
              </label>
              <input id="bk-destination" className="input" required value={form.destination} onChange={(e) => set({ destination: e.target.value })} placeholder="Street, area, town" />
            </div>
            <div className="sm:col-span-2">
              <label className="label" htmlFor="bk-landmark">
                Landmark (optional)
              </label>
              <input id="bk-landmark" className="input" value={form.landmark} onChange={(e) => set({ landmark: e.target.value })} placeholder="e.g. the blue gate, next to the pharmacy" />
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-4">
            <div className="sm:col-span-2">
              <label className="label" htmlFor="bk-product">
                Product
              </label>
              <input id="bk-product" className="input" value={form.product} onChange={(e) => set({ product: e.target.value })} placeholder="e.g. Black bomber jacket" />
            </div>
            <div>
              <label className="label" htmlFor="bk-colour">
                Colour
              </label>
              <input id="bk-colour" className="input" value={form.colour} onChange={(e) => set({ colour: e.target.value })} placeholder="e.g. Black" />
            </div>
            <div>
              <label className="label" htmlFor="bk-size">
                Size
              </label>
              <input id="bk-size" className="input" value={form.size} onChange={(e) => set({ size: e.target.value })} placeholder="e.g. Large" />
            </div>
            <div>
              <label className="label" htmlFor="bk-quantity">
              Quantity</label>
              <input id="bk-quantity" className="input" type="number" min={1} max={999} value={form.quantity} onChange={(e) => set({ quantity: e.target.value })} />
            </div>
            <div>
              <label className="label" htmlFor="bk-order-value">
                Order value
              </label>
              <input id="bk-order-value" className="input" type="number" min={0} step="any" value={form.orderValue} onChange={(e) => set({ orderValue: e.target.value })} placeholder="0.00" />
            </div>
            <div>
              <label className="label" htmlFor="bk-payment">
                Payment
              </label>
              <select id="bk-payment" className="input" value={form.payment} onChange={(e) => set({ payment: e.target.value as "cod" | "online" })}>
                <option value="online">Paid online</option>
                <option value="cod">Cash on delivery</option>
              </select>
            </div>
            <div>
              <label className="label" htmlFor="bk-time">
                Requested time
              </label>
              <input id="bk-time" className="input" type="datetime-local" value={form.requestedTime} onChange={(e) => set({ requestedTime: e.target.value })} />
            </div>
          </div>

          <div>
            <label className="label" htmlFor="bk-instructions">
              Delivery instructions (optional)
            </label>
            <textarea id="bk-instructions" className="input min-h-20" rows={3} maxLength={500} value={form.instructions} onChange={(e) => set({ instructions: e.target.value })} />
          </div>

          <label className="flex items-center gap-2 text-sm text-zinc-300">
            <input type="checkbox" className="size-4 accent-emerald-500" checked={form.consent} onChange={(e) => set({ consent: e.target.checked })} />
            I'm happy to receive delivery updates for this order
          </label>

          {error ? <p className="text-sm text-red-400">{error}</p> : null}

          <button className="btn" type="submit" disabled={busy}>
            {busy ? "Booking…" : "Book my delivery"}
          </button>
        </form>
      )}
    </div>
  );
}

/** Maps the form state onto the public delivery-request API. */
async function fetchDeliveries(form: {
  name: string;
  phone: string;
  pickup: string | null;
  destination: string;
  landmark: string | null;
  product: string | null;
  colour: string | null;
  size: string | null;
  quantity: number;
  orderValue: number | null;
  payment: "cod" | "online";
  requestedTime: string | null;
  instructions: string | null;
  consent: boolean;
}) {
  const res = await fetch("/api/delivery-requests", {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name: form.name,
      phone: form.phone,
      addressText: form.destination,
      landmark: form.landmark,
      pickupAddressText: form.pickup,
      itemSummary: form.product,
      itemColor: form.colour,
      itemSize: form.size,
      quantity: form.quantity,
      fare: form.orderValue,
      paymentMethod: form.payment,
      scheduledAt: form.requestedTime,
      instructions: form.instructions,
      consentTracking: form.consent,
    }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
    throw new ApiError(res.status, body?.error?.message ?? `HTTP ${res.status}`);
  }
  return res.json() as Promise<{ jobNumber: string | null; customerName: string; tracking: { token: string } | null }>;
}
