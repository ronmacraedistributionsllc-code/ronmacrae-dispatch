import type { FastifyRequest, preHandlerAsyncHookHandler } from "fastify";
import { httpErrors } from "@fastify/sensible";
import type { StaffRole } from "@ronmacrae/contracts";

/**
 * Role guards, composed onto AppCtx in ctx.ts.
 * The global auth hook (registered in server.ts) populates request.user;
 * these guards only enforce roles.
 */

export function makeRequireStaff(...roles: StaffRole[]): preHandlerAsyncHookHandler {
  return async (req: FastifyRequest) => {
    if (!req.user) throw httpErrors.createError(401, "Authentication required");
    if (!roles.includes(req.user.role as StaffRole)) {
      throw httpErrors.createError(403, "Insufficient permissions");
    }
    // Every business-scoped route relies on req.user.businessId being set —
    // a platform-owner session deliberately has none (the owner console is
    // separate, business-scoped routes never accept it), so without this
    // check an owner's token could otherwise pass the role check above and
    // then hit a list/create route with businessId `undefined`, which Prisma
    // treats as "no filter" rather than "no business" — this is the one
    // guard standing between that and a real cross-tenant data leak.
    if (!req.user.businessId) {
      throw httpErrors.createError(403, "No business context for this session");
    }
  };
}

/** Platform-owner-only routes (business management, rider platform approval) —
 *  independent of, and never satisfied by, any business's own StaffMembership. */
export function makeRequireOwner(): preHandlerAsyncHookHandler {
  return async (req: FastifyRequest) => {
    if (!req.user) throw httpErrors.createError(401, "Authentication required");
    if (req.user.platformRole !== "owner") throw httpErrors.createError(403, "Platform-owner only");
  };
}

export function makeRequireRider(): preHandlerAsyncHookHandler {
  return async (req: FastifyRequest) => {
    if (!req.user) throw httpErrors.createError(401, "Authentication required");
    if (req.user.role !== "rider") throw httpErrors.createError(403, "Bearer-only endpoint");
  };
}

export function makeRequireAnyUser(): preHandlerAsyncHookHandler {
  return async (req: FastifyRequest) => {
    if (!req.user) throw httpErrors.createError(401, "Authentication required");
  };
}

/** Staff = anyone with a non-rider role. */
export function isStaff(role: string | undefined | null): role is StaffRole {
  return role === "admin" || role === "dispatcher" || role === "accountant" || role === "viewer";
}
