import React, { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import type { CustomerDto, JobDto, JobSource, Priority, TrackingLinkDto } from "@ronmacrae/contracts";
import { ApiError, apiFetch } from "../lib/api.js";
import { useAuth } from "../lib/auth.js";

/** Store channels: where the order came from / which courier handles it. */
export const CHANNELS: { value: JobSource; label: string }[] = [
  { value: "courier", label: "Local delivery (our riders)" },
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

interface FormState {
  customerName: string;
  customerPhone: string;
  pickup: string;
  destination: string;
  landmark: string;
  product: string;
  colour: string;
  size: string;
  quantity: string;
  orderValue: string;
  deliveryFee: string;
  payment: "cod" | "online";
  requestedTime: string;
  priority: Priority;
  channel: JobSource;
  instructions: string;
}

const EMPTY_FORM: FormState = {
  customerName: "",
  customerPhone: "",
  pickup: "",
  destination: "",
  landmark: "",
  product: "",
  colour: "",
  size: "",
  quantity: "1",
  orderValue: "",
  deliveryFee: "",
  payment: "cod",
  requestedTime: "",
  priority: "normal",
  channel: "courier",
  instructions: "",
};

export interface BookingResult {
  job: JobDto;
  link: TrackingLinkDto | null;
}

/** Staff "book a delivery" form: the real store workflow, one screen. */
export function NewJob(): React.JSX.Element {
  const { user } = useAuth();
  const canWrite = user?.role === "admin" || user?.role === "dispatcher";

  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [selected, setSelected] = useState<CustomerDto | null>(null);
  const [matches, setMatches] = useState<CustomerDto[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [linkError, setLinkError] = useState<string | null>(null);
  const [result, setResult] = useState<BookingResult | null>(null);

  const set = (patch: Partial<FormState>) => setForm((f) => ({ ...f, ...patch }));

  // debounce customer search on name/phone (matches when the fields look edited)
  const searchKey = `${form.customerName.trim().toLowerCase()}|${form.customerPhone.replace(/[^\d]/g, "")}`;
  useEffect(() => {
    const name = form.customerName.trim();
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
    set({ customerName: c.name, customerPhone: c.phone });
    setMatches([]);
  };

  const money = (raw: string): number | undefined => {
    const n = Number(raw);
    return raw.trim() !== "" && Number.isFinite(n) && n > 0 ? n : undefined;
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canWrite) return;
    setError(null);
    if (form.customerName.trim().length < 1) return setError("Customer name is required");
    if (form.customerPhone.replace(/[^\d]/g, "").length < 7) return setError("A valid customer phone is required");
    if (form.destination.trim().length < 3) return setError("Destination address is required");
    if (form.product.trim().length < 1) return setError("Product is required");

    setBusy(true);
    setLinkError(null);
    try {
      let customerId = selected?.id ?? "";
      if (!customerId) {
        const created = await apiFetch<{ customer: CustomerDto }>("/customers", {
          method: "POST",
          body: JSON.stringify({
            name: form.customerName.trim(),
            phone: form.customerPhone.trim(),
            addressText: form.destination.trim(),
            landmark: form.landmark.trim(),
          }),
        });
        customerId = created.customer.id;
      }
      const job = await apiFetch<{ job: JobDto }>("/jobs", {
        method: "POST",
        body: JSON.stringify({
          customerId,
          type: "delivery",
          priority: form.priority,
          source: form.channel,
          addressText: form.destination.trim(),
          landmark: form.landmark.trim() || undefined,
          pickupAddressText: form.pickup.trim() || undefined,
          itemSummary: form.product.trim(),
          quantity: Math.min(999, Math.max(1, Number(form.quantity) || 1)),
          itemSize: form.size.trim() || undefined,
          itemColor: form.colour.trim() || undefined,
          fare: money(form.orderValue),
          fee: money(form.deliveryFee),
          paymentMethod: form.payment,
          scheduledAt: form.requestedTime ? new Date(form.requestedTime).toISOString() : undefined,
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
      setForm(EMPTY_FORM);
      setSelected(null);
      setMatches([]);
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
          <p className="text-sm text-zinc-400">Key the order, and we'll book the job and the customer tracking link</p>
        </div>
        <Link className="btn" to="/jobs">
          Jobs queue
        </Link>
      </header>

      <section className="card">
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-zinc-400">Customer</h2>
        <div className="grid gap-3 md:grid-cols-2">
          <div>
            <label className="label" htmlFor="nj-name">
              Customer name
            </label>
            <input
              id="nj-name"
              className="input"
              required
              value={form.customerName}
              onChange={(e) => {
                setSelected(null);
                set({ customerName: e.target.value });
              }}
              placeholder="e.g. Shelly Smith"
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

      <section className="card">
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-zinc-400">Pickup &amp; destination</h2>
        <div className="grid gap-3 md:grid-cols-3">
          <div>
            <label className="label" htmlFor="nj-pickup">
              Pickup
            </label>
            <input
              id="nj-pickup"
              className="input"
              value={form.pickup}
              onChange={(e) => set({ pickup: e.target.value })}
              placeholder="Store address (if not the usual)"
            />
          </div>
          <div>
            <label className="label" htmlFor="nj-destination">
              Destination
            </label>
            <input
              id="nj-destination"
              className="input"
              required
              value={form.destination}
              onChange={(e) => set({ destination: e.target.value })}
              placeholder="Street, area, town"
            />
          </div>
          <div>
            <label className="label" htmlFor="nj-landmark">
              Landmark
            </label>
            <input
              id="nj-landmark"
              className="input"
              value={form.landmark}
              onChange={(e) => set({ landmark: e.target.value })}
              placeholder="e.g. next to the church"
            />
          </div>
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
              Colour
            </label>
            <input id="nj-colour" className="input" value={form.colour} onChange={(e) => set({ colour: e.target.value })} placeholder="e.g. Black" />
          </div>
          <div>
            <label className="label" htmlFor="nj-size">
              Size
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
              value={form.quantity}
              onChange={(e) => set({ quantity: e.target.value })}
            />
          </div>
        </div>
      </section>

      <section className="card">
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-zinc-400">Payment &amp; timing</h2>
        <div className="grid gap-3 md:grid-cols-4">
          <div>
            <label className="label" htmlFor="nj-order-value">
              Order value
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
              Delivery fee
            </label>
            <input
              id="nj-fee"
              className="input"
              type="number"
              min={0}
              step="any"
              value={form.deliveryFee}
              onChange={(e) => set({ deliveryFee: e.target.value })}
              placeholder="e.g. 350"
            />
          </div>
          <div>
            <label className="label" htmlFor="nj-payment">
              Payment
            </label>
            <select
              id="nj-payment"
              className="input"
              value={form.payment}
              onChange={(e) => set({ payment: e.target.value as "cod" | "online" })}
            >
              <option value="cod">Cash on delivery</option>
              <option value="online">Paid online</option>
            </select>
          </div>
          <div>
            <label className="label" htmlFor="nj-time">
              Requested time
            </label>
            <input
              id="nj-time"
              className="input"
              type="datetime-local"
              value={form.requestedTime}
              onChange={(e) => set({ requestedTime: e.target.value })}
            />
          </div>
        </div>
      </section>

      <section className="card">
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-zinc-400">Courier &amp; priority</h2>
        <div className="grid gap-3 md:grid-cols-2">
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
          <div>
            <label className="label" htmlFor="nj-priority">
              Priority
            </label>
            <select id="nj-priority" className="input" value={form.priority} onChange={(e) => set({ priority: e.target.value as Priority })}>
              <option value="normal">Normal</option>
              <option value="express">Express</option>
              <option value="urgent">Urgent</option>
            </select>
          </div>
          <div className="md:col-span-2">
            <label className="label" htmlFor="nj-instructions">
              Delivery instructions
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

      {error ? <p className="text-sm text-red-400">{error}</p> : null}

      <div className="flex items-center gap-3">
        <button className="btn" type="submit" disabled={busy}>
          {busy ? "Booking…" : "Book delivery"}
        </button>
        <button className="btn-accent" type="button" disabled={busy} onClick={() => setForm((f) => ({ ...EMPTY_FORM, priority: f.priority, channel: f.channel }))}>
          Clear
        </button>
      </div>

      {result ? (
        <section className="card border-emerald-800/60 bg-emerald-950/30">
          <h2 className="text-base font-semibold text-emerald-300">
            Booked — {result.job.jobNumber ?? result.job.id.slice(0, 8)}
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
