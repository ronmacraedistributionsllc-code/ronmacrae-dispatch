import type { FastifyRequest } from "fastify";
import type { AppCtx } from "../ctx.js";

/**
 * Optional `Idempotency-Key` handling for rider mutations (the offline
 * action queue replays with the key it generated at enqueue time).
 *
 * Only successes are stored: rejections from these endpoints are
 * deterministic (guarded conditional writes return the same 409 on
 * re-execution — "already claimed", "already moved on", "wrong PIN"), so
 * re-running them is safe and needs no stored copy. Keys are scoped per
 * user (composite id), so one rider's key can never replay another
 * rider's response. Malformed keys are ignored (treated as absent), never
 * rejected — forward-compat over strictness.
 */
export function idempotencyKeyFrom(req: FastifyRequest): string | undefined {
  const raw = req.headers["idempotency-key"];
  if (typeof raw !== "string") return undefined;
  const key = raw.trim();
  return /^[A-Za-z0-9_-]{8,100}$/.test(key) ? key : undefined;
}

export async function withIdempotency<T>(
  ctx: AppCtx,
  userId: string,
  key: string | undefined,
  execute: () => Promise<{ status: number; body: T }>,
): Promise<{ status: number; body: T; replayed: boolean }> {
  if (!key) {
    const fresh = await execute();
    return { ...fresh, replayed: false };
  }
  const existing = await ctx.prisma.idempotencyKey.findUnique({ where: { userId_key: { userId, key } } });
  if (existing) return { status: existing.status, body: JSON.parse(existing.body) as T, replayed: true };
  const result = await execute();
  try {
    await ctx.prisma.idempotencyKey.create({ data: { userId, key, status: result.status, body: JSON.stringify(result.body) } });
  } catch {
    // Lost a race with an identical key — return the winner's stored result.
    const winner = await ctx.prisma.idempotencyKey.findUnique({ where: { userId_key: { userId, key } } });
    if (winner) return { status: winner.status, body: JSON.parse(winner.body) as T, replayed: true };
  }
  // Opportunistic retention: keys are useless after the queue has replayed
  // (minutes), so a week of history is plenty. Fire-and-forget.
  void ctx.prisma.idempotencyKey
    .deleteMany({ where: { userId, createdAt: { lt: new Date(Date.now() - 7 * 24 * 3600 * 1000) } } })
    .catch(() => {});
  return { ...result, replayed: false };
}
