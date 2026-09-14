import React, { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { API, PAYMENT_METHOD_LABELS, type PaymentMethod } from "@ronmacrae/contracts";
import type {
  MerchantPublicDto,
  OrderItemInput,
  ProductDto,
  PublicOrderPricingDto,
  PublicOrderResultDto,
} from "@ronmacrae/contracts";
import { ApiError, apiFetch, formatMoney } from "../lib/api.js";
import { AddressPicker, type ConfirmedLocation } from "../components/address-picker.js";

/** Today at 12:00 PM, in local time (spec item 2 default). */
function todayLocalDate(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

let nextRowId = 1;
interface ItemRow {
  rowId: number;
  productId: string | null;
  productVariantId: string | null;
  name: string;
  size: string;
  color: string;
  quantity: string;
  unitPrice: string;
  notes: string;
}

function emptyRow(): ItemRow {
  return { rowId: nextRowId++, productId: null, productVariantId: null, name: "", size: "", color: "", quantity: "1", unitPrice: "", notes: "" };
}

function toItemInput(row: ItemRow): OrderItemInput | null {
  const quantity = Math.max(1, Math.min(999, Number(row.quantity) || 1));
  if (row.productVariantId || row.productId) {
    return { productId: row.productId, productVariantId: row.productVariantId, size: row.size || null, color: row.color || null, quantity, notes: row.notes || null };
  }
  const name = row.name.trim();
  if (!name) return null;
  const unitPrice = row.unitPrice.trim() !== "" ? Number(row.unitPrice) : null;
  return { name, size: row.size || null, color: row.color || null, quantity, unitPrice, notes: row.notes || null };
}

/**
 * The main public order form (spec section 5) — no login, no app, reachable
 * at `/order` (the courier's own default storefront) or `/order/:merchantSlug`
 * (a specific merchant's own link). Every price shown here is a preview from
 * the server (`/api/order/quote`); the real submission recomputes it
 * independently — nothing typed here is ever trusted as the final price.
 */
export function PublicOrder(): React.JSX.Element {
  const { merchantSlug } = useParams();

  const [merchant, setMerchant] = useState<MerchantPublicDto | null>(null);
  const [merchantError, setMerchantError] = useState<string | null>(null);
  const [products, setProducts] = useState<ProductDto[]>([]);
  const [loadingMerchant, setLoadingMerchant] = useState(Boolean(merchantSlug));

  useEffect(() => {
    if (!merchantSlug) return;
    let cancelled = false;
    setLoadingMerchant(true);
    apiFetch<{ merchant: MerchantPublicDto }>(API.merchants.public(merchantSlug))
      .then((r) => {
        if (cancelled) return;
        setMerchant(r.merchant);
        if (r.merchant.hasCatalog) {
          apiFetch<{ products: ProductDto[] }>(API.products.public(merchantSlug))
            .then((pr) => !cancelled && setProducts(pr.products))
            .catch(() => {});
        }
      })
      .catch((err) => !cancelled && setMerchantError(err instanceof ApiError ? err.message : "This order link isn't available"))
      .finally(() => !cancelled && setLoadingMerchant(false));
    return () => {
      cancelled = true;
    };
  }, [merchantSlug]);

  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [alternatePhone, setAlternatePhone] = useState("");
  const [destination, setDestination] = useState<ConfirmedLocation | null>(null);
  const [landmark, setLandmark] = useState("");
  const [apartmentUnit, setApartmentUnit] = useState("");
  const [items, setItems] = useState<ItemRow[]>([emptyRow()]);
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>("cod");
  const [requestedDate, setRequestedDate] = useState(todayLocalDate);
  const [requestedTime, setRequestedTime] = useState("12:00");
  const [instructions, setInstructions] = useState("");
  const [consent, setConsent] = useState(true);

  const [pricing, setPricing] = useState<PublicOrderPricingDto | null>(null);
  const [quoting, setQuoting] = useState(false);
  // Distinct from the plain "add items" placeholder below — a quote can
  // fail for a real reason (an item's out of stock, or no longer exists)
  // that the customer needs to actually see and act on, not a silently
  // blank price the previous version left them with.
  const [quoteError, setQuoteError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<PublicOrderResultDto | null>(null);

  const setItem = (rowId: number, patch: Partial<ItemRow>) => setItems((rows) => rows.map((r) => (r.rowId === rowId ? { ...r, ...patch } : r)));
  const addItem = () => setItems((rows) => [...rows, emptyRow()]);
  const removeItem = (rowId: number) => setItems((rows) => (rows.length > 1 ? rows.filter((r) => r.rowId !== rowId) : rows));

  const pickProduct = (rowId: number, productId: string) => {
    const product = products.find((p) => p.id === productId);
    if (!product) return setItem(rowId, { productId: null, productVariantId: null, name: "" });
    // Prefer a variant that's actually in stock — falls back to the first
    // one (still selectable, so its out-of-stock state is visible below)
    // only when every variant is out.
    const defaultVariant = product.variants.find((v) => v.inventoryQty == null || v.inventoryQty > 0) ?? product.variants[0] ?? null;
    setItem(rowId, {
      productId: product.id,
      productVariantId: defaultVariant?.id ?? null,
      name: product.name,
      size: defaultVariant?.size ?? "",
      color: defaultVariant?.color ?? "",
    });
  };

  // A product with more than one catalog variant (size/colour) needs a real
  // picker — previously this silently bound to variants[0] regardless of
  // what the customer then typed into the free-text Size/Colour fields
  // below, so an edit there changed the *label* without changing which
  // variant (and therefore which price and stock) was actually ordered.
  const pickVariant = (rowId: number, variantId: string) => {
    const variant = products.flatMap((p) => p.variants).find((v) => v.id === variantId);
    if (!variant) return;
    setItem(rowId, { productVariantId: variant.id, size: variant.size ?? "", color: variant.color ?? "" });
  };

  // Live price preview — recomputed server-side, never trusted from the form itself.
  useEffect(() => {
    const itemInputs = items.map(toItemInput).filter((i): i is OrderItemInput => i != null);
    if (itemInputs.length === 0) {
      setPricing(null);
      setQuoteError(null);
      return;
    }
    let cancelled = false;
    setQuoting(true);
    const t = setTimeout(() => {
      apiFetch<PublicOrderPricingDto>(API.order.quote, {
        method: "POST",
        body: JSON.stringify({ merchantSlug: merchantSlug || null, point: destination?.point ?? null, items: itemInputs }),
      })
        .then((p) => {
          if (cancelled) return;
          setPricing(p);
          setQuoteError(null);
        })
        .catch((err) => {
          if (cancelled) return;
          setPricing(null);
          setQuoteError(err instanceof ApiError ? err.message : "Could not price this order — please check your items.");
        })
        .finally(() => !cancelled && setQuoting(false));
    }, 400);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [JSON.stringify(items.map((r) => [r.productVariantId, r.productId, r.name, r.quantity, r.unitPrice])), destination?.point.lat, destination?.point.lng, merchantSlug]);

  const canSubmit = name.trim().length > 0 && phone.replace(/[^\d]/g, "").length >= 7 && destination != null && items.some((r) => toItemInput(r) != null) && !busy && !quoteError;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!destination) return setError("Please confirm a delivery location.");
    const itemInputs = items.map(toItemInput).filter((i): i is OrderItemInput => i != null);
    if (itemInputs.length === 0) return setError("Add at least one item.");
    setBusy(true);
    setError(null);
    try {
      const path = merchantSlug ? API.order.createForMerchant(merchantSlug) : API.order.create;
      const body = await apiFetch<PublicOrderResultDto>(path, {
        method: "POST",
        body: JSON.stringify({
          name: name.trim(),
          phone: phone.trim(),
          email: email.trim() || null,
          alternatePhone: alternatePhone.trim() || null,
          addressText: destination.address,
          addressProviderText: destination.providerAddress,
          landmark: landmark.trim() || null,
          apartmentUnit: apartmentUnit.trim() || null,
          point: destination.point,
          items: itemInputs,
          paymentMethod,
          scheduledAt: new Date(`${requestedDate}T${requestedTime || "12:00"}:00`).toISOString(),
          instructions: instructions.trim() || null,
          consentTracking: consent,
        }),
      });
      setResult(body);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not place your order — please try again.");
    } finally {
      setBusy(false);
    }
  }

  if (loadingMerchant) {
    return (
      <div className="mx-auto max-w-2xl space-y-4 p-4">
        <p className="text-sm text-zinc-400">Loading…</p>
      </div>
    );
  }
  if (merchantSlug && merchantError) {
    return (
      <div className="mx-auto max-w-2xl space-y-4 p-4">
        <div className="card">
          <h1 className="text-lg font-semibold text-amber-300">This order link isn't available</h1>
          <p className="mt-1 text-sm text-zinc-400">Check the link, or contact the store directly.</p>
        </div>
      </div>
    );
  }

  if (result) {
    const trackUrl = result.tracking ? `${window.location.origin}/track/${result.tracking.token}` : null;
    return (
      <div className="mx-auto max-w-2xl space-y-4 p-4">
        <section className="card space-y-3 border-emerald-800/60 bg-emerald-950/30">
          <div>
            <h1 className="text-lg font-semibold text-emerald-300">
              {result.jobNumber ? `Order ${result.jobNumber} received` : "Order received"}
            </h1>
            {result.merchantName ? <p className="text-sm text-zinc-400">{result.merchantName}</p> : null}
          </div>
          <ul className="divide-y divide-zinc-800 text-sm">
            {result.items.map((it) => (
              <li key={it.id} className="flex items-center justify-between gap-2 py-1.5">
                <span className="text-zinc-300">
                  {it.quantity}× {it.name}
                  {it.size ? ` (${it.size})` : ""}
                  {it.color ? ` — ${it.color}` : ""}
                </span>
                <span className="text-zinc-200">{formatMoney(it.lineTotal)}</span>
              </li>
            ))}
          </ul>
          <dl className="space-y-1 border-t border-zinc-800 pt-2 text-sm">
            <div className="flex justify-between"><dt className="text-zinc-500">Subtotal</dt><dd className="text-zinc-200">{formatMoney(result.pricing.subtotal)}</dd></div>
            <div className="flex justify-between">
              <dt className="text-zinc-500">Delivery</dt>
              <dd className="text-zinc-200">{result.pricing.deliveryFeeConfirmed ? formatMoney(result.pricing.deliveryFee) : "To be confirmed"}</dd>
            </div>
            <div className="flex justify-between font-semibold"><dt>Total</dt><dd>{formatMoney(result.pricing.total)}</dd></div>
          </dl>
          {trackUrl ? (
            <a className="btn-accent block text-center" href={trackUrl}>Track my order</a>
          ) : null}
          <Link className="btn block text-center" to="/my-packages">
            Claim my account — track faster next time
          </Link>
        </section>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-2xl space-y-4 p-4">
      <header>
        <h1 className="text-xl font-bold">{merchant ? `Order from ${merchant.name}` : "Book a delivery"}</h1>
        <p className="text-sm text-zinc-400">
          {merchant?.pickupAddressText ? `Pickup: ${merchant.pickupAddressText}` : "No account or app needed — just fill this out."}
        </p>
      </header>

      <form onSubmit={(e) => void submit(e)} className="space-y-4">
        <section className="card space-y-3">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-400">Your details</h2>
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className="label" htmlFor="po-name">Full name</label>
              <input id="po-name" className="input" required value={name} onChange={(e) => setName(e.target.value)} />
            </div>
            <div>
              <label className="label" htmlFor="po-phone">Phone</label>
              <input id="po-phone" className="input" type="tel" required inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="876 555 1234" />
            </div>
            <div>
              <label className="label" htmlFor="po-email">Email (optional)</label>
              <input id="po-email" className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
            </div>
            <div>
              <label className="label" htmlFor="po-alt-phone">Alternate phone (optional)</label>
              <input id="po-alt-phone" className="input" type="tel" value={alternatePhone} onChange={(e) => setAlternatePhone(e.target.value)} />
            </div>
          </div>
        </section>

        <section className="card space-y-3">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-400">Delivery location</h2>
          <AddressPicker title="Delivery address" value={destination} onChange={setDestination} required />
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className="label" htmlFor="po-apt">Apartment / unit (optional)</label>
              <input id="po-apt" className="input" value={apartmentUnit} onChange={(e) => setApartmentUnit(e.target.value)} />
            </div>
            <div>
              <label className="label" htmlFor="po-landmark">Landmark (optional)</label>
              <input id="po-landmark" className="input" value={landmark} onChange={(e) => setLandmark(e.target.value)} placeholder="e.g. next to the pharmacy" />
            </div>
          </div>
        </section>

        <section className="card space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-400">Items</h2>
            <button type="button" className="btn !px-3 !py-1 text-xs" onClick={addItem}>+ Add another item</button>
          </div>
          <div className="space-y-3">
            {items.map((row, i) => (
              <div key={row.rowId} className="space-y-2 rounded-lg border border-zinc-700 p-3">
                <div className="flex items-center justify-between">
                  <p className="text-xs font-medium uppercase tracking-wide text-zinc-500">Item {i + 1}</p>
                  {items.length > 1 ? (
                    <button type="button" className="text-xs text-red-400 underline" onClick={() => removeItem(row.rowId)}>Remove</button>
                  ) : null}
                </div>
                {products.length > 0 ? (
                  <div>
                    <label className="label" htmlFor={`po-product-${row.rowId}`}>Product</label>
                    <select id={`po-product-${row.rowId}`} className="input" value={row.productId ?? ""} onChange={(e) => (e.target.value ? pickProduct(row.rowId, e.target.value) : setItem(row.rowId, { productId: null, productVariantId: null }))}>
                      <option value="">Type it in manually below…</option>
                      {products.map((p) => (
                        <option key={p.id} value={p.id}>{p.name} — {formatMoney(p.price)}</option>
                      ))}
                    </select>
                  </div>
                ) : null}
                {!row.productId ? (
                  <div>
                    {/* Distinct from the catalog select above once a catalog
                     *  exists — both were labelled plain "Product" before this,
                     *  so whenever nothing had been picked yet (row.productId
                     *  null, the initial state) two different form fields
                     *  shared the exact same accessible name. */}
                    <label className="label" htmlFor={`po-item-name-${row.rowId}`}>{products.length > 0 ? "Item name" : "Product"}</label>
                    <input id={`po-item-name-${row.rowId}`} className="input" value={row.name} onChange={(e) => setItem(row.rowId, { name: e.target.value })} placeholder="e.g. Black bomber jacket" />
                  </div>
                ) : null}
                {(() => {
                  const product = products.find((p) => p.id === row.productId);
                  const variant = product?.variants.find((v) => v.id === row.productVariantId);
                  // A catalog product with real variants (size/colour rows,
                  // each its own price and stock) needs an actual picker —
                  // typing into free-text Size/Colour never changed which
                  // variant (and therefore which price/stock) was ordered.
                  if (product && product.variants.length > 0) {
                    return (
                      <div>
                        <label className="label" htmlFor={`po-variant-${row.rowId}`}>Size / colour</label>
                        <select id={`po-variant-${row.rowId}`} className="input" value={row.productVariantId ?? ""} onChange={(e) => pickVariant(row.rowId, e.target.value)}>
                          {product.variants.map((v) => {
                            const label = [v.size, v.color].filter(Boolean).join(" / ") || "Standard";
                            const outOfStock = v.inventoryQty != null && v.inventoryQty <= 0;
                            return (
                              <option key={v.id} value={v.id} disabled={outOfStock}>
                                {label} — {formatMoney(v.price)}{outOfStock ? " (out of stock)" : v.inventoryQty != null && v.inventoryQty <= 5 ? ` (${v.inventoryQty} left)` : ""}
                              </option>
                            );
                          })}
                        </select>
                        {variant?.inventoryQty != null && variant.inventoryQty <= 0 ? (
                          <p className="mt-1 text-xs text-red-400">This option is out of stock — pick another, or remove this item.</p>
                        ) : variant?.inventoryQty != null && variant.inventoryQty <= 5 ? (
                          <p className="mt-1 text-xs text-amber-400">Only {variant.inventoryQty} left.</p>
                        ) : null}
                      </div>
                    );
                  }
                  return null;
                })()}
                {(() => {
                  const hasVariants = Boolean(products.find((p) => p.id === row.productId)?.variants.length);
                  return (
                <div className={`grid gap-2 ${hasVariants ? "grid-cols-1" : "grid-cols-3"}`}>
                  {!hasVariants ? (
                    <>
                      <div>
                        <label className="label" htmlFor={`po-size-${row.rowId}`}>Size</label>
                        <input id={`po-size-${row.rowId}`} className="input" value={row.size} onChange={(e) => setItem(row.rowId, { size: e.target.value })} />
                      </div>
                      <div>
                        <label className="label" htmlFor={`po-color-${row.rowId}`}>Colour</label>
                        <input id={`po-color-${row.rowId}`} className="input" value={row.color} onChange={(e) => setItem(row.rowId, { color: e.target.value })} />
                      </div>
                    </>
                  ) : null}
                  <div>
                    <label className="label" htmlFor={`po-qty-${row.rowId}`}>Quantity</label>
                    <input id={`po-qty-${row.rowId}`} className="input" type="number" min={1} max={999} value={row.quantity} onChange={(e) => setItem(row.rowId, { quantity: e.target.value })} />
                  </div>
                </div>
                  );
                })()}
                {!row.productId ? (
                  <div>
                    <label className="label" htmlFor={`po-price-${row.rowId}`}>Price each (optional — the store can confirm it)</label>
                    <input id={`po-price-${row.rowId}`} className="input" type="number" min={0} step="any" value={row.unitPrice} onChange={(e) => setItem(row.rowId, { unitPrice: e.target.value })} placeholder="0.00" />
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        </section>

        <section className="card">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-zinc-400">Delivery date &amp; time</h2>
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className="label" htmlFor="po-date">Requested date</label>
              <input id="po-date" className="input" type="date" value={requestedDate} onChange={(e) => setRequestedDate(e.target.value)} />
            </div>
            <div>
              <label className="label" htmlFor="po-time">Requested time <span className="text-zinc-500">(defaults to 12:00 PM)</span></label>
              <input id="po-time" className="input" type="time" value={requestedTime} onChange={(e) => setRequestedTime(e.target.value)} />
            </div>
          </div>
          <div className="mt-3">
            <label className="label" htmlFor="po-instructions">Delivery instructions (optional)</label>
            <textarea id="po-instructions" className="input min-h-16" maxLength={500} value={instructions} onChange={(e) => setInstructions(e.target.value)} />
          </div>
          <div className="mt-3">
            <label className="label" htmlFor="po-payment">Payment method</label>
            <select id="po-payment" className="input" value={paymentMethod} onChange={(e) => setPaymentMethod(e.target.value as PaymentMethod)}>
              {(["cod", "online", "paid_at_store", "other"] as PaymentMethod[]).map((m) => (
                <option key={m} value={m}>{PAYMENT_METHOD_LABELS[m]}</option>
              ))}
            </select>
          </div>
        </section>

        <section className="card space-y-2">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-400">Order summary</h2>
          {quoting ? <p className="text-sm text-zinc-500">Calculating…</p> : null}
          {!quoting && quoteError ? <p className="text-sm text-red-400">{quoteError}</p> : null}
          {pricing ? (
            <dl className="space-y-1 text-sm">
              <div className="flex justify-between"><dt className="text-zinc-500">Subtotal</dt><dd className="text-zinc-200">{formatMoney(pricing.subtotal)}</dd></div>
              <div className="flex justify-between">
                <dt className="text-zinc-500">Delivery fee</dt>
                <dd className="text-zinc-200">{pricing.deliveryFeeConfirmed ? formatMoney(pricing.deliveryFee) : destination ? "Requires confirmation" : "Confirm your address first"}</dd>
              </div>
              <div className="flex justify-between border-t border-zinc-800 pt-1 font-semibold"><dt>Total</dt><dd>{formatMoney(pricing.total)}</dd></div>
            </dl>
          ) : !quoteError ? (
            <p className="text-sm text-zinc-500">Add items and confirm your address to see pricing.</p>
          ) : null}
          <label className="flex items-center gap-2 pt-2 text-sm text-zinc-300">
            <input type="checkbox" className="size-4 accent-emerald-500" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
            I'm happy to receive delivery updates for this order
          </label>
        </section>

        {error ? <p className="text-sm text-red-400">{error}</p> : null}
        <button className="btn-accent w-full !py-3 text-base font-semibold" type="submit" disabled={!canSubmit}>
          {busy ? "Placing order…" : "Place order"}
        </button>
      </form>
    </div>
  );
}
