import React, { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import type { CustomerDto, FareQuoteDto, JobDto, JobSource, MerchantDto, TrackingLinkDto } from "@ronmacrae/contracts";
import { API } from "@ronmacrae/contracts";
import { ApiError, apiFetch } from "../lib/api.js";
import { useAuth } from "../lib/auth.js";
import { AddressPicker, type ConfirmedLocation } from "../components/address-picker.js";

/** Store channels: where the order came from / which courier handles it. */
export const CHANNELS: { value: JobSource; label: string }[] = [
  { value: "courier", label: "Local delivery (our couriers)" },
  { value: "manual", label: "In-store / phone" },
  { value: "knutsford", label: "Knutsford" },
  { value: "zipmail", label: "Zipmail" },
  { value: "web", label: "Website" },
  { value: "woo", label: "Online store" },
];

export function channelLabel(value: string): string {
  return CHANNELS.find((c) => c.value === value)?.label ?? value;
}

export function paymentLabel(value: string): string {
  if (value === "cod") return "Cash on delivery";
  if (value === "online") return "Paid online";
  return value;
}

/** Store's default pickup — geocoded once on load, but always editable (same flow as the destination). */
const DEFAULT_PICKUP_ADDRESS = "15-17 Half Way Tree Road, Kingston, Jamaica";

interface FormState {
  firstName: string;
  lastName: string;
  customerPhone: string;
  /** Which store/merchant client this order is for — "" = direct/in-house order. */
  merchantId: string;
  landmark: string;
  product: string;
  colour: string;
  size: string;
  quantity: string;
  orderValue: string;
  deliveryFee: string;
  payment: "cod" | "online";
  requestedDate: string;
  requestedTime: string;
  urgent: boolean;
  channel: JobSource;
  instructions: string;
}

/** Today, in the browser's own local date — never UTC, or a Jamaica evening
 *  booking could default to tomorrow. */
function todayLocalDate(): string {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

/** Spec item 2 — today + 12:00 PM by default; the dispatcher can change
 *  either field, but doing nothing books for noon today. A function (not a
 *  static constant) so "today" is recomputed every time the form resets. */
function makeEmptyForm(): FormState {
  return {
    firstName: "",
    lastName: "",
    customerPhone: "",
    merchantId: "",
    landmark: "",
    product: "",
    colour: "",
    size: "",
    quantity: "1",
    orderValue: "",
    deliveryFee: "",
    payment: "cod",
    requestedDate: todayLocalDate(),
    requestedTime: "12:00",
    urgent: false,
    channel: "courier",
    instructions: "",
  };
}

export interface BookingResult {
  job: JobDto;
  link: TrackingLinkDto | null;
}

/** Staff "book a delivery" form: address-first, one screen after the destination is confirmed. */
export function NewJob(): React.JSX.Element {
  const { user } = useAuth();
  const canWrite = user?.role === "admin" || user?.role === "dispatcher";

  const [destination, setDestination] = useState<ConfirmedLocation | null>(null);
  const [pickup, setPickup] = useState<ConfirmedLocation | null>(null);
  const [pickupLoadError, setPickupLoadError] = useState(false);

  const [form, setForm] = useState<FormState>(makeEmptyForm);
  const [selected, setSelected] = useState<CustomerDto | null>(null);
  const [matches, setMatches] = useState<CustomerDto[]>([]);
  const [merchants, setMerchants] = useState<MerchantDto[]>([]);
  useEffect(() => {
    apiFetch<{ merchants: MerchantDto[] }>(API.merchants.list)
      .then((r) => setMerchants(r.merchants.filter((m) => m.active)))
      .catch(() => setMerchants([]));
  }, []);
  const [feeAutoFilled, setFeeAutoFilled] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [linkError, setLinkError] = useState<string | null>(null);
  const [result, setResult] = useState<BookingResult | null>(null);

  const set = (patch: Partial<FormState>) => setForm((f) => ({ ...f, ...patch }));

  // Resolve the default pickup once — still fully editable via its own AddressPicker.
  useEffect(() => {
    let cancelled = false;
    apiFetch<{ results: { point: { lat: number; lng: number }; label: string }[] }>(API.geo.geocode, {
      method: "POST",
      body: JSON.stringify({ query: DEFAULT_PICKUP_ADDRESS, limit: 1 }),
    })
      .then((r) => {
        if (cancelled) return;
        const first = r.results[0];
        // The default pickup starts out as the provider's own match for our
        // standard address — but it's still just a starting point: the field is
        // editable like any other, and if staff type over it their text becomes
        // authoritative just like everywhere else.
        if (first) setPickup({ address: DEFAULT_PICKUP_ADDRESS, providerAddress: first.label, point: first.point });
        else setPickupLoadError(true);
      })
      .catch(() => {
        if (!cancelled) setPickupLoadError(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // debounce customer search on name/phone (matches when the fields look edited)
  const searchKey = `${form.firstName.trim().toLowerCase()} ${form.lastName.trim().toLowerCase()}|${form.customerPhone.replace(/[^\d]/g, "")}`;
  useEffect(() => {
    const name = `${form.firstName.trim()} ${form.lastName.trim()}`.trim();
    const digits = form.customerPhone.replace(/[^\d]/g, "");
    if (name.length < 2 && digits.length < 7) {
      setMatches([]);
      return;
    }
    const t = setTimeout(() => {
      const q = digits.length >= 7 ? digits : name;
      void apiFetch<{ customers: CustomerDto[] }>(`/customers/search?q=${encodeURIComponent(q)}&take=5`)
        .then((b) => setMatches(b.customers))
        .catch(() => setMatches([]));
    }, 400);
    return () => clearTimeout(t);
  }, [searchKey]);

  const pickCustomer = (c: CustomerDto) => {
    setSelected(c);
    const [first, ...rest] = c.name.split(" ");
    set({ firstName: first ?? c.name, lastName: rest.join(" ") });
    setMatches([]);
  };

  // Auto-suggest the delivery fee once both points are known — the real zone/distance
  // engine (POST /api/quotes), not a guess. The staff member can still override it by
  // typing in the field directly; once they do, auto-fill stops touching it.
  useEffect(() => {
    if (!feeAutoFilled || !pickup || !destination) return;
    let cancelled = false;
    apiFetch<FareQuoteDto>(API.quotes.create, {
      method: "POST",
      body: JSON.stringify({ fromPoint: pickup.point, toPoint: destination.point, urgent: form.urgent }),
    })
      .then((q) => {
        if (!cancelled) set({ deliveryFee: String(q.fee.amount) });
      })
      .catch(() => {
        // no quote available (offline routing, no zone match) — leave the field for manual entry
      });
    return () => {
      cancelled = true;
    };
  }, [pickup?.point.lat, pickup?.point.lng, destination?.point.lat, destination?.point.lng, form.urgent, feeAutoFilled]);

  const money = (raw: string): number | undefined => {
    const n = Number(raw);
    return raw.trim() !== "" && Number.isFinite(n) && n > 0 ? n : undefined;
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canWrite || !destination) return;
    setError(null);
    if (form.firstName.trim().length < 1) return setError("Customer first name is required");
    if (form.customerPhone.replace(/[^\d]/g, "").length < 7) return setError("A valid customer phone is required");
    if (!pickup) return setError("Pickup location is required");
    if (form.product.trim().length < 1) return setError("Product is required");

    setBusy(true);
    setLinkError(null);
    try {
      const fullName = form.lastName.trim() ? `${form.firstName.trim()} ${form.lastName.trim()}` : form.firstName.trim();
      let customerId = selected?.id ?? "";
      if (!customerId) {
        const created = await apiFetch<{ customer: CustomerDto }>("/customers", {
          method: "POST",
          body: JSON.stringify({
            name: fullName,
            phone: form.customerPhone.trim(),
            addressText: destination.address,
            landmark: form.landmark.trim(),
          }),
        });
        customerId = created.customer.id;
      }
      const job = await apiFetch<{ job: JobDto }>("/jobs", {
        method: "POST",
        body: JSON.stringify({
          customerId,
          merchantId: form.merchantId || undefined,
          type: "delivery",
          priority: form.urgent ? "urgent" : "normal",
          source: form.channel,
          addressText: destination.address,
          addressProviderText: destination.providerAddress ?? undefined,
          point: destination.point,
          landmark: form.landmark.trim() || undefined,
          pickupAddressText: pickup.address,
          pickupAddressProviderText: pickup.providerAddress ?? undefined,
          pickupPoint: pickup.point,
          itemSummary: form.product.trim(),
          quantity: Math.min(999, Math.max(1, Number(form.quantity) || 1)),
          itemSize: form.size.trim() || undefined,
          itemColor: form.colour.trim() || undefined,
          fare: money(form.orderValue),
          fee: money(form.deliveryFee),
          paymentMethod: form.payment,
          // Date-only in the UI; store at local noon so no timezone rollover flips the date.
          // Date-only + a separate time-of-day in the UI (spec item 2: today +
          // noon by default, either field independently editable) — combined
          // here into one instant. Local-noon-if-no-time-given so a blank time
          // never rolls the date over across a timezone boundary.
          scheduledAt: form.requestedDate ? new Date(`${form.requestedDate}T${form.requestedTime || "12:00"}:00`).toISOString() : undefined,
          instructions: form.instructions.trim() || undefined,
        }),
      });
      let link: TrackingLinkDto | null = null;
      try {
        link = (await apiFetch<{ link: TrackingLinkDto }>(`/jobs/${job.job.id}/tracking-link`, { method: "POST" })).link;
      } catch (err) {
        // tracking is best-effort; the job itself is booked
        link = null;
        setLinkError(err instanceof ApiError ? err.message : "tracking request failed");
      }
      setResult({ job: job.job, link });
      setForm(makeEmptyForm());
      setSelected(null);
      setMatches([]);
      setDestination(null);
      setFeeAutoFilled(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Booking failed, please try again");
    } finally {
      setBusy(false);
    }
  };

  const trackUrl = result?.link ? `${window.location.origin}/track/${result.link.token}` : null;
  const copyLink = useMemo(
    () => async () => {
      if (!trackUrl) return;
      try {
        await navigator.clipboard.writeText(trackUrl);
      } catch {
        // non-secure context: the link text is selected next to the button
      }
    },
    [trackUrl],
  );

  if (!canWrite) {
    return (
      <div className="space-y-4">
        <h1 className="text-xl font-bold">Book a delivery</h1>
        <div className="card">
          <p className="text-sm text-zinc-400">
            Your role is read-only. Ask a dispatcher or admin to book the delivery.
          </p>
        </div>
      </div>
    );
  }

  return (
    <form onSubmit={(e) => void submit(e)} className="space-y-4">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold">Book a delivery</h1>
          <p className="text-sm text-zinc-400">Confirm the destination first, then key the rest of the order</p>
        </div>
        <Link className="btn" to="/jobs">
          Jobs queue
        </Link>
      </header>

      <section className="card">
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-zinc-400">Step 1 — Delivery destination</h2>
        <AddressPicker title="Destination address" value={destination} onChange={setDestination} required />
      </section>

      {destination ? (
        <>
          {merchants.length > 0 ? (
            <section className="card">
              <label className="label" htmlFor="nj-merchant">Store / merchant (optional)</label>
              <select id="nj-merchant" className="input max-w-sm" value={form.merchantId} onChange={(e) => set({ merchantId: e.target.value })}>
                <option value="">Direct order (no third-party store)</option>
                {merchants.map((m) => (
                  <option key={m.id} value={m.id}>{m.name}</option>
                ))}
              </select>
              <p className="mt-1 text-xs text-zinc-500">Attributes this order's cash accounting to that store, and sends them a new-order email.</p>
            </section>
          ) : null}
          <section className="card">
            <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-zinc-400">Customer</h2>
            <div className="grid gap-3 md:grid-cols-3">
              <div>
                <label className="label" htmlFor="nj-first-name">
                  First name
                </label>
                <input
                  id="nj-first-name"
                  className="input"
                  required
                  value={form.firstName}
                  onChange={(e) => {
                    setSelected(null);
                    set({ firstName: e.target.value });
                  }}
                  placeholder="e.g. Shelly"
                />
              </div>
              <div>
                <label className="label" htmlFor="nj-last-name">
                  Last name <span className="text-zinc-500">(optional)</span>
                </label>
                <input
                  id="nj-last-name"
                  className="input"
                  value={form.lastName}
                  onChange={(e) => {
                    setSelected(null);
                    set({ lastName: e.target.value });
                  }}
                  placeholder="e.g. Smith"
                />
              </div>
              <div>
                <label className="label" htmlFor="nj-phone">
                  Phone
                </label>
                <input
                  id="nj-phone"
                  className="input"
                  required
                  type="tel"
                  value={form.customerPhone}
                  onChange={(e) => {
                    setSelected(null);
                    set({ customerPhone: e.target.value });
                  }}
                  placeholder="e.g. 876 555 1234"
                />
              </div>
            </div>
            {matches.length > 0 ? (
              <div className="mt-2">
                <div className="label">Known customers — click to reuse</div>
                <ul className="divide-y divide-zinc-800 rounded-lg border border-zinc-800">
                  {matches.map((c) => (
                    <li key={c.id}>
                      <button type="button" className="flex w-full items-center justify-between px-3 py-2 text-left text-sm hover:bg-zinc-800" onClick={() => pickCustomer(c)}>
                        <span className="text-zinc-200">{c.name}</span>
                        <span className="text-xs text-zinc-500">{c.phone}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            {selected ? (
              <p className="mt-2 text-xs text-emerald-400">
                Booking for {selected.name} ({selected.phone})
              </p>
            ) : null}
          </section>

          <section className="card space-y-3">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-400">Pickup &amp; destination</h2>
            {pickup ? (
              <AddressPicker title="Pickup location" value={pickup} onChange={setPickup} bias={destination.point} required />
            ) : pickupLoadError ? (
              <AddressPicker title="Pickup location" value={null} onChange={setPickup} required />
            ) : (
              <p className="text-sm text-zinc-500">Loading default pickup location…</p>
            )}
            <AddressPicker title="Destination address" value={destination} onChange={setDestination} bias={pickup?.point} required />
            <div>
              <label className="label" htmlFor="nj-landmark">
                Landmark <span className="text-zinc-500">(optional)</span>
              </label>
              <input
                id="nj-landmark"
                className="input"
                value={form.landmark}
                onChange={(e) => set({ landmark: e.target.value })}
                placeholder="e.g. next to the church"
              />
            </div>
          </section>

          <section className="card">
            <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-zinc-400">Product</h2>
            <div className="grid gap-3 md:grid-cols-4">
              <div className="md:col-span-2">
                <label className="label" htmlFor="nj-product">
                  Product
                </label>
                <input
                  id="nj-product"
                  className="input"
                  required
                  value={form.product}
                  onChange={(e) => set({ product: e.target.value })}
                  placeholder="e.g. Black bomber jacket"
                />
              </div>
              <div>
                <label className="label" htmlFor="nj-colour">
                  Colour <span className="text-zinc-500">(optional)</span>
                </label>
                <input id="nj-colour" className="input" value={form.colour} onChange={(e) => set({ colour: e.target.value })} placeholder="e.g. Black" />
              </div>
              <div>
                <label className="label" htmlFor="nj-size">
                  Size <span className="text-zinc-500">(optional)</span>
                </label>
                <input id="nj-size" className="input" value={form.size} onChange={(e) => set({ size: e.target.value })} placeholder="e.g. Large" />
              </div>
              <div>
                <label className="label" htmlFor="nj-quantity">
                  Quantity
                </label>
                <input
                  id="nj-quantity"
                  className="input"
                  type="number"
                  min={1}
                  max={999}
                  required
                  value={form.quantity}
                  onChange={(e) => set({ quantity: e.target.value })}
                />
              </div>
            </div>
          </section>

          <section className="card">
            <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-zinc-400">Requested delivery</h2>
            <div className="grid gap-3 md:grid-cols-3">
              <div>
                <label className="label" htmlFor="nj-date">
                  Requested date
                </label>
                <input id="nj-date" className="input" type="date" value={form.requestedDate} onChange={(e) => set({ requestedDate: e.target.value })} />
              </div>
              <div>
                <label className="label" htmlFor="nj-time">
                  Requested time <span className="text-zinc-500">(defaults to 12:00 PM)</span>
                </label>
                <input id="nj-time" className="input" type="time" value={form.requestedTime} onChange={(e) => set({ requestedTime: e.target.value })} />
              </div>
              <div className="flex items-end pb-2">
                <label className="flex items-center gap-2 text-sm text-zinc-200">
                  <input type="checkbox" checked={form.urgent} onChange={(e) => set({ urgent: e.target.checked })} />
                  <span>
                    <span className="font-medium text-amber-300">Urgent delivery</span> — this order should be completed sooner than a normal delivery
                  </span>
                </label>
              </div>
              <div>
                <label className="label" htmlFor="nj-channel">
                  Courier type
                </label>
                <select id="nj-channel" className="input" value={form.channel} onChange={(e) => set({ channel: e.target.value as JobSource })}>
                  {CHANNELS.map((c) => (
                    <option key={c.value} value={c.value}>
                      {c.label}
                    </option>
                  ))}
                </select>
              </div>
              <div className="md:col-span-3">
                <label className="label" htmlFor="nj-instructions">
                  Delivery instructions <span className="text-zinc-500">(optional)</span>
                </label>
                <textarea
                  id="nj-instructions"
                  className="input min-h-20"
                  rows={3}
                  maxLength={500}
                  value={form.instructions}
                  onChange={(e) => set({ instructions: e.target.value })}
                  placeholder="Gate code, who answers the phone, leave with the neighbour…"
                />
              </div>
            </div>
          </section>

          <section className="card">
            <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-zinc-400">Payment</h2>
            <div className="grid gap-3 md:grid-cols-3">
              <div>
                <label className="label" htmlFor="nj-order-value">
                  Order value <span className="text-zinc-500">(optional)</span>
                </label>
                <input
                  id="nj-order-value"
                  className="input"
                  type="number"
                  min={0}
                  step="any"
                  value={form.orderValue}
                  onChange={(e) => set({ orderValue: e.target.value })}
                  placeholder="0.00"
                />
              </div>
              <div>
                <label className="label" htmlFor="nj-fee">
                  Delivery fee {feeAutoFilled ? <span className="text-zinc-500">(auto-calculated — edit to override)</span> : null}
                </label>
                <input
                  id="nj-fee"
                  className="input"
                  type="number"
                  min={0}
                  step="any"
                  value={form.deliveryFee}
                  onChange={(e) => {
                    setFeeAutoFilled(false);
                    set({ deliveryFee: e.target.value });
                  }}
                  placeholder="e.g. 350"
                />
              </div>
              <div>
                <label className="label" htmlFor="nj-payment">
                  Payment
                </label>
                <select id="nj-payment" className="input" value={form.payment} onChange={(e) => set({ payment: e.target.value as "cod" | "online" })}>
                  <option value="cod">Cash on delivery</option>
                  <option value="online">Paid online</option>
                </select>
              </div>
            </div>
          </section>

          {error ? <p className="text-sm text-red-400">{error}</p> : null}

          <div className="flex items-center gap-3">
            <button className="btn" type="submit" disabled={busy}>
              {busy ? "Booking…" : "Book delivery"}
            </button>
            <button
              className="btn-accent"
              type="button"
              disabled={busy}
              onClick={() => {
                setForm((f) => ({ ...makeEmptyForm(), channel: f.channel }));
                setDestination(null);
                setFeeAutoFilled(true);
              }}
            >
              Clear
            </button>
          </div>
        </>
      ) : null}

      {result ? (
        <section className="card border-emerald-800/60 bg-emerald-950/30">
          <h2 className="text-base font-semibold text-emerald-300">
            Booked — {result.job.jobNumber ?? result.job.id.slice(0, 8)}
            {result.job.priority === "urgent" ? <span className="ml-2 rounded bg-red-900/60 px-2 py-0.5 text-xs font-medium text-red-200">URGENT</span> : null}
          </h2>
          <p className="mt-1 text-sm text-zinc-400">
            {result.job.customerName} · {channelLabel(result.job.source)} · {paymentLabel(result.job.paymentMethod)}
          </p>
          {result.link ? (
            <div className="mt-3 space-y-2">
              <div className="label">Customer tracking link</div>
              <div className="flex flex-wrap items-center gap-2">
                <a
                  className="input min-w-60 flex-1 !text-sky-300 hover:!border-sky-700"
                  href={`${window.location.origin}/track/${result.link.token}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  {trackUrl}
                </a>
                <button type="button" className="btn" onClick={() => void copyLink()}>
                  Copy
                </button>
              </div>
              <p className="text-xs text-zinc-500">
                Send it to the customer (SMS / WhatsApp). It expires {new Date(result.link.expiresAt).toLocaleString("en-GB")}.
              </p>
            </div>
          ) : (
            <p className="mt-3 text-sm text-amber-400">
              The job is booked, but the tracking link could not be created
              {linkError ? ` (${linkError})` : ""}. Generate it from the Jobs queue.
            </p>
          )}
          <Link className="btn mt-3" to="/jobs">
            Open the Jobs queue
          </Link>
        </section>
      ) : null}
    </form>
  );
}
