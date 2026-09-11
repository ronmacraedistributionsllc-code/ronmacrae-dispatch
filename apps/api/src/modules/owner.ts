import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppCtx } from "../ctx.js";
import { findDuplicateCandidates, mergeCustomerIdentities } from "./customer-identity.js";

/**
 * Platform-owner-only routes (Stage 23) — identity duplicate-resolution.
 * Everything here is deliberately narrow: this is not a general owner
 * console (business creation/listing and rider platform-approval screens
 * remain a documented, open gap from Stage 20) — just the one owner-scoped
 * capability this stage actually needed: reviewing and resolving
 * CustomerIdentity duplicates across businesses, audited.
 */
export async function ownerRoutes(app: FastifyInstance, ctx: AppCtx): Promise<void> {
  app.get("/api/owner/customer-identities/duplicates", { preHandler: ctx.requireOwner }, async () => {
    return { candidates: await findDuplicateCandidates(ctx) };
  });

  const MergeBody = z.object({
    intoId: z.string().min(1),
    reason: z.string().max(500).optional(),
  });
  app.post<{ Params: { id: string } }>("/api/owner/customer-identities/:id/merge", { preHandler: ctx.requireOwner }, async (req) => {
    const body = MergeBody.parse(req.body);
    await mergeCustomerIdentities(ctx, { id: req.user!.sub, role: req.user!.role }, req.params.id, body.intoId, body.reason);
    return { ok: true };
  });
}
