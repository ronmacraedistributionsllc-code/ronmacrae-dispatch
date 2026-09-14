import type { AppCtx } from "../ctx.js";

/**
 * Platform-owner-facing email when a new merchant or logistics-company
 * self-signup application arrives (spec: "merchant signup must... notify
 * the platform admin"). Same "never blocks the caller, best-effort,
 * audited" contract as dispatch-notify.ts / merchant-notify.ts — the
 * applicant's own signup request must never fail because this side
 * notification did; callers fire this with `void ...catch(...)`, never
 * awaited on the response path.
 *
 * Sent to every active platform-owner account with an email address —
 * there may be more than one owner, and this is a shared inbox notice,
 * not one specific owner's personal alert. If no owner account has an
 * email set (a fresh install before anyone's been granted one), this is
 * a silent no-op: there's genuinely nobody to notify, not a failure.
 */
export async function notifyOwnersOfApplication(
  ctx: AppCtx,
  kind: "merchant" | "logistics_company",
  entity: { id: string; name: string; applicantEmail: string },
): Promise<{ status: "sent" | "failed" | "skipped"; error?: string }> {
  const owners = await ctx.prisma.user.findMany({
    where: { platformRole: "owner", active: true, email: { not: null } },
    select: { email: true },
  });
  const to = owners.map((o) => o.email).filter((e): e is string => !!e);
  if (to.length === 0) return { status: "skipped", error: "No active platform-owner account has an email address" };

  const label = kind === "merchant" ? "merchant" : "logistics company";
  const reviewLink = `${ctx.config.APP_ORIGIN}/platform-admin`;
  const result = await ctx.email.send({
    to,
    subject: `New ${label} application: ${entity.name}`,
    text: [
      `${entity.name} (${entity.applicantEmail}) applied to become a ${label} on Ronmacrae Dispatch and is waiting for review.`,
      "",
      `Review it: ${reviewLink}`,
    ].join("\n"),
    refId: entity.id,
  });
  await ctx.audit.record(
    { id: null, role: "system" },
    `platform.${kind}.application.notify.${result.status}`,
    kind,
    entity.id,
    { recipients: to.length, error: result.status === "failed" ? result.error : null },
  );
  return result;
}
