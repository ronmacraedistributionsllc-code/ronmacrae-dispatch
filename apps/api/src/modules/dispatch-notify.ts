import type { FastifyInstance } from "fastify";
import { httpErrors } from "@fastify/sensible";
import type { AppCtx } from "../ctx.js";
import { format, money } from "@ronmacrae/money";
import { PAYMENT_METHOD_LABELS, type PaymentMethod } from "@ronmacrae/contracts";

/**
 * Dispatch-side "a new order came in" email — distinct from
 * merchant-notify.ts's merchant email: this fires for EVERY order
 * (merchant-linked or not), sent to the business's own
 * `dispatchNotificationEmail` (settings.ts), not any merchant's. The two
 * are independent — a merchant order fires both, a direct/in-house order
 * fires only this one.
 *
 * Same idempotency-guard pattern as the merchant email
 * (`Job.dispatchNotifiedAt`), same "never blocks order creation, log and
 * move on" contract.
 */

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

async function loadForEmail(ctx: AppCtx, jobId: string) {
  return ctx.prisma.job.findUnique({
    where: { id: jobId },
    include: { customer: true, merchant: true, business: true, items: { orderBy: { createdAt: "asc" } } },
  });
}

export async function sendDispatchOrderNotification(
  ctx: AppCtx,
  jobId: string,
  force = false,
): Promise<{ status: "sent" | "failed" | "skipped"; error?: string } | null> {
  const job = await loadForEmail(ctx, jobId);
  if (!job) return null;
  const to = job.business.dispatchNotificationEmail?.trim();
  if (!to) return { status: "skipped", error: "No dispatch notification email configured for this business" };

  if (!force) {
    const guarded = await ctx.prisma.job.updateMany({ where: { id: jobId, dispatchNotifiedAt: null }, data: { dispatchNotifiedAt: new Date() } });
    if (guarded.count === 0) return { status: "skipped", error: "Already sent" };
  } else {
    await ctx.prisma.job.update({ where: { id: jobId }, data: { dispatchNotifiedAt: new Date() } });
  }

  const cur = job.currency;
  const total = money(job.subtotal ?? job.amountExpected ?? 0, cur);
  const orderRef = job.jobNumber ?? job.id.slice(0, 8);
  const when = job.scheduledAt ? new Date(job.scheduledAt).toLocaleString("en-JM", { dateStyle: "medium", timeStyle: "short" }) : "As soon as possible";
  const paymentLabel = PAYMENT_METHOD_LABELS[job.paymentMethod as PaymentMethod] ?? job.paymentMethod;
  const source = job.merchant ? job.merchant.name : "Direct order";
  const adminOrderLink = `${ctx.config.APP_ORIGIN}/jobs?search=${encodeURIComponent(orderRef)}`;

  const itemLines = job.items.map((it) => `${it.quantity}× ${it.name}${it.size ? ` (${it.size})` : ""}: ${format(money(it.unitPrice * it.quantity, it.currency))}`);

  const text = [
    `NEW ORDER #${orderRef} — ${format(total)} (${source})`,
    "",
    `Requested: ${when}`,
    `Customer: ${job.customer.name}`,
    `Phone: ${job.customer.phone}`,
    `Delivery address: ${job.addressText ?? "(not given)"}`,
    "",
    "Items:",
    ...itemLines,
    "",
    `Total: ${format(total)}`,
    `Payment method: ${paymentLabel}`,
    "",
    `Open in dispatch: ${adminOrderLink}`,
  ].join("\n");

  const html = `
    <div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;margin:0 auto;color:#1a1a1a">
      <h2 style="margin:0 0 4px">NEW ORDER #${escapeHtml(orderRef)}</h2>
      <p style="margin:0 0 16px;color:#555">${escapeHtml(source)} · ${escapeHtml(format(total))}</p>
      <table style="width:100%;border-collapse:collapse;font-size:14px;margin-bottom:16px">
        <tr><td style="padding:4px 8px;color:#888">Requested</td><td style="padding:4px 8px">${escapeHtml(when)}</td></tr>
        <tr><td style="padding:4px 8px;color:#888">Customer</td><td style="padding:4px 8px">${escapeHtml(job.customer.name)} · ${escapeHtml(job.customer.phone)}</td></tr>
        <tr><td style="padding:4px 8px;color:#888">Deliver to</td><td style="padding:4px 8px">${escapeHtml(job.addressText ?? "(not given)")}</td></tr>
        <tr><td style="padding:4px 8px;color:#888">Payment</td><td style="padding:4px 8px">${escapeHtml(paymentLabel)}</td></tr>
      </table>
      <p><a href="${adminOrderLink}" style="display:inline-block;background:#111;color:#fff;padding:8px 16px;border-radius:4px;text-decoration:none;font-size:14px">Open in dispatch</a></p>
    </div>`;

  const result = await ctx.email.send({ to, subject: `NEW ORDER #${orderRef} — ${format(total)}`, text, html, refId: job.id });
  await ctx.audit.record({ id: null, role: "system" }, `dispatch.notify.${result.status}`, "job", job.id, {
    provider: ctx.email.name,
    providerRef: result.providerRef ?? null,
    recipient: to,
    error: result.error ?? null,
  });
  if (result.status === "failed") {
    // Release the in-flight idempotency claim. A provider failure is not a
    // delivery and must remain retryable rather than looking successful.
    await ctx.prisma.job.updateMany({ where: { id: job.id, dispatchNotifiedAt: { not: null } }, data: { dispatchNotifiedAt: null } });
    ctx.log.error({ jobId: job.id, error: result.error }, "dispatch order email send failed");
  }
  return { status: result.status, error: result.error };
}

/** Staff-facing manual resend, mirroring merchant-notify.ts's own. */
export async function dispatchNotifyRoutes(app: FastifyInstance, ctx: AppCtx): Promise<void> {
  app.post<{ Params: { id: string } }>(
    "/api/jobs/:id/notify-dispatch",
    { preHandler: ctx.requireStaff("admin", "dispatcher") },
    async (req) => {
      const job = await ctx.prisma.job.findFirst({ where: { id: req.params.id, businessId: req.user!.businessId! } });
      if (!job) throw httpErrors.createError(404, "Job not found");
      const result = await sendDispatchOrderNotification(ctx, req.params.id, true);
      if (!result) throw httpErrors.createError(404, "Job not found");
      await ctx.audit.record({ id: req.user!.sub, role: req.user!.role }, "dispatch.notify.resend", "job", req.params.id, { status: result.status });
      return result;
    },
  );
}
