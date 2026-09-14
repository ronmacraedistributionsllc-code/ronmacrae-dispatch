import type { FastifyInstance } from "fastify";
import { httpErrors } from "@fastify/sensible";
import type { AppCtx } from "../ctx.js";
import { format, money } from "@ronmacrae/money";
import { PAYMENT_METHOD_LABELS, type PaymentMethod } from "@ronmacrae/contracts";
import { pointFromJson } from "../geo-mappers.js";

/**
 * Merchant new-order notification email (spec section 18: "STORE OWNER
 * EMAIL — IMMEDIATE"). Sent once per job, guarded against duplicates by
 * `Job.merchantNotifiedAt` (a genuine idempotency guard, not just a
 * courtesy — see the schema's own doc comment on that field): whichever
 * caller wins the guarded update is the only one that actually sends,
 * even under a retry/concurrent-call race.
 *
 * Never blocks order creation on this — the caller (`order.ts`) fires this
 * without awaiting its result on the response path, and any failure here
 * is logged, not thrown further. `resendMerchantOrderEmail` below is the
 * explicit, staff-triggered retry for when a provider failure needs a
 * second attempt.
 */

function mapsLink(point: { lat: number; lng: number } | null): string | null {
  return point ? `https://www.google.com/maps/dir/?api=1&destination=${point.lat},${point.lng}` : null;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

async function loadForEmail(ctx: AppCtx, jobId: string) {
  return ctx.prisma.job.findUnique({
    where: { id: jobId },
    include: { customer: true, merchant: true, items: { orderBy: { createdAt: "asc" } } },
  });
}

/** Builds and sends the email, but only if it hasn't already been sent for
 *  this job — `force` bypasses that guard (used by the explicit staff
 *  resend action only). Returns null (not an error) when there's simply
 *  nothing to notify (no merchant, or no recipient configured). */
export async function sendMerchantOrderEmail(ctx: AppCtx, jobId: string, force = false): Promise<{ status: "sent" | "failed" | "skipped"; error?: string } | null> {
  const job = await loadForEmail(ctx, jobId);
  if (!job || !job.merchant) return null;
  const recipients = (job.merchant.notificationEmails ?? "")
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (recipients.length === 0) return { status: "skipped", error: "This merchant has no notification email configured" };

  if (!force) {
    const guarded = await ctx.prisma.job.updateMany({ where: { id: jobId, merchantNotifiedAt: null }, data: { merchantNotifiedAt: new Date() } });
    if (guarded.count === 0) return { status: "skipped", error: "Already sent" };
  } else {
    await ctx.prisma.job.update({ where: { id: jobId }, data: { merchantNotifiedAt: new Date() } });
  }

  const cur = job.currency;
  const subtotal = money(job.fare ?? 0, cur);
  const fee = job.fee != null ? money(job.fee, cur) : null;
  const total = money(job.subtotal ?? job.amountExpected ?? 0, cur);
  const point = pointFromJson(job.point);
  const link = mapsLink(point);
  const orderRef = job.jobNumber ?? job.id.slice(0, 8);
  const when = job.scheduledAt ? new Date(job.scheduledAt).toLocaleString("en-JM", { dateStyle: "medium", timeStyle: "short" }) : "As soon as possible";
  const paymentLabel = PAYMENT_METHOD_LABELS[job.paymentMethod as PaymentMethod] ?? job.paymentMethod;
  const adminOrderLink = `${ctx.config.APP_ORIGIN}/jobs?search=${encodeURIComponent(orderRef)}`;

  const itemLines = job.items.map((it) => `${it.quantity}× ${it.name}${it.size ? ` (${it.size})` : ""}${it.color ? ` — ${it.color}` : ""}: ${format(money(it.unitPrice * it.quantity, it.currency))}`);
  const itemRowsHtml = job.items
    .map(
      (it) =>
        `<tr><td style="padding:4px 8px;border-bottom:1px solid #eee">${escapeHtml(it.name)}${it.size ? ` (${escapeHtml(it.size)})` : ""}${it.color ? ` — ${escapeHtml(it.color)}` : ""}${it.notes ? `<br><span style="color:#888;font-size:12px">${escapeHtml(it.notes)}</span>` : ""}</td><td style="padding:4px 8px;border-bottom:1px solid #eee;text-align:center">${it.quantity}</td><td style="padding:4px 8px;border-bottom:1px solid #eee;text-align:right">${format(money(it.unitPrice * it.quantity, it.currency))}</td></tr>`,
    )
    .join("");

  const text = [
    `NEW ORDER #${orderRef} — ${format(total)}`,
    "",
    `Date/time requested: ${when}`,
    `Customer: ${job.customer.name}`,
    `Phone: ${job.customer.phone}`,
    `Delivery address: ${job.addressText ?? "(not given)"}`,
    job.landmark ? `Landmark: ${job.landmark}` : null,
    link ? `Map: ${link}` : null,
    "",
    "Items:",
    ...itemLines,
    "",
    `Subtotal: ${format(subtotal)}`,
    fee ? `Delivery fee: ${format(fee)}` : "Delivery fee: to be confirmed",
    `Total: ${format(total)}`,
    `Payment method: ${paymentLabel}`,
    job.instructions ? `Notes: ${job.instructions}` : null,
    "",
    `View this order: ${adminOrderLink}`,
  ]
    .filter((l): l is string => l != null)
    .join("\n");

  const html = `
    <div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;margin:0 auto;color:#1a1a1a">
      <h2 style="margin:0 0 4px">NEW ORDER #${escapeHtml(orderRef)}</h2>
      <p style="margin:0 0 16px;color:#555">${escapeHtml(job.merchant.name)} · ${escapeHtml(format(total))}</p>
      <table style="width:100%;border-collapse:collapse;margin-bottom:16px;font-size:14px">
        <tr><td style="padding:4px 8px;color:#888">Requested</td><td style="padding:4px 8px">${escapeHtml(when)}</td></tr>
        <tr><td style="padding:4px 8px;color:#888">Customer</td><td style="padding:4px 8px">${escapeHtml(job.customer.name)} · ${escapeHtml(job.customer.phone)}</td></tr>
        <tr><td style="padding:4px 8px;color:#888">Deliver to</td><td style="padding:4px 8px">${escapeHtml(job.addressText ?? "(not given)")}${job.landmark ? ` (${escapeHtml(job.landmark)})` : ""}</td></tr>
        ${link ? `<tr><td style="padding:4px 8px;color:#888">Map</td><td style="padding:4px 8px"><a href="${link}">${link}</a></td></tr>` : ""}
        <tr><td style="padding:4px 8px;color:#888">Payment</td><td style="padding:4px 8px">${escapeHtml(paymentLabel)}</td></tr>
      </table>
      <table style="width:100%;border-collapse:collapse;font-size:14px;margin-bottom:12px">
        <thead><tr><th style="text-align:left;padding:4px 8px;border-bottom:2px solid #333">Item</th><th style="padding:4px 8px;border-bottom:2px solid #333">Qty</th><th style="text-align:right;padding:4px 8px;border-bottom:2px solid #333">Amount</th></tr></thead>
        <tbody>${itemRowsHtml}</tbody>
      </table>
      <table style="width:100%;border-collapse:collapse;font-size:14px;margin-bottom:16px">
        <tr><td style="padding:2px 8px;color:#888">Subtotal</td><td style="padding:2px 8px;text-align:right">${escapeHtml(format(subtotal))}</td></tr>
        <tr><td style="padding:2px 8px;color:#888">Delivery fee</td><td style="padding:2px 8px;text-align:right">${fee ? escapeHtml(format(fee)) : "To be confirmed"}</td></tr>
        <tr><td style="padding:4px 8px;font-weight:bold">Total</td><td style="padding:4px 8px;text-align:right;font-weight:bold">${escapeHtml(format(total))}</td></tr>
      </table>
      ${job.instructions ? `<p style="font-size:13px;color:#555"><strong>Notes:</strong> ${escapeHtml(job.instructions)}</p>` : ""}
      <p><a href="${adminOrderLink}" style="display:inline-block;background:#111;color:#fff;padding:8px 16px;border-radius:4px;text-decoration:none;font-size:14px">View this order</a></p>
    </div>`;

  const result = await ctx.email.send({
    to: recipients,
    subject: `NEW ORDER #${orderRef} — ${format(total)}`,
    text,
    html,
    refId: job.id,
  });
  await ctx.audit.record({ id: null, role: "system" }, `merchant.notify.${result.status}`, "job", job.id, {
    provider: ctx.email.name,
    providerRef: result.providerRef ?? null,
    recipients,
    error: result.error ?? null,
  });
  if (result.status === "failed") {
    // The timestamp is a short idempotency claim while the provider call is
    // in flight. A failed provider call must release it so the explicit retry
    // path, or a later order-processing retry, can genuinely try again.
    await ctx.prisma.job.updateMany({ where: { id: job.id, merchantNotifiedAt: { not: null } }, data: { merchantNotifiedAt: null } });
    ctx.log.error({ jobId: job.id, error: result.error }, "merchant order email send failed");
  }
  return { status: result.status, error: result.error };
}

/** Staff-facing manual retry (spec section 19: "email should still be
 *  retryable" on a provider failure) — bypasses the idempotency guard
 *  deliberately, since this IS the explicit "try again" action. */
export async function merchantNotifyRoutes(app: FastifyInstance, ctx: AppCtx): Promise<void> {
  app.post<{ Params: { id: string } }>(
    "/api/jobs/:id/notify-merchant",
    { preHandler: ctx.requireStaff("admin", "dispatcher") },
    async (req) => {
      const job = await ctx.prisma.job.findFirst({ where: { id: req.params.id, businessId: req.user!.businessId! } });
      if (!job) throw httpErrors.createError(404, "Job not found");
      const result = await sendMerchantOrderEmail(ctx, req.params.id, true);
      if (!result) throw httpErrors.createError(409, "This order has no merchant to notify");
      await ctx.audit.record({ id: req.user!.sub, role: req.user!.role }, "merchant.notify.resend", "job", req.params.id, { status: result.status });
      return result;
    },
  );
}
