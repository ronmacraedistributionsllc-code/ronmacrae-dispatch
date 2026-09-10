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
