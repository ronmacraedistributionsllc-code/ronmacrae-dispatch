import type { FastifyInstance, preHandlerAsyncHookHandler } from "fastify";
import type { AppConfig } from "./config.js";
import type { PrismaClient } from "./prisma.js";
import type { JwtIssuer, AccessTokenPayload } from "./lib/jwt.js";
import type { QueueDriver } from "./queue/index.js";
import type { RealtimeHub } from "./rt/hub.js";
import type { CompositeGeoProvider } from "@ronmacrae/geo";
import type { NotificationProvider, EmailProvider } from "@ronmacrae/notifications";
import { createEmailProvider } from "@ronmacrae/notifications";
import type { Logger } from "./lib/log.js";
import { AuditService } from "./modules/audit.js";
import { NotifyService } from "./modules/notify.js";
import { PushService } from "./modules/push.js";
import { LocationSimulator } from "./rt/location-sim.js";
import { makeRequireRider, makeRequireStaff, makeRequireAnyUser, makeRequireOwner } from "./modules/guards.js";
import type { StaffRole } from "@ronmacrae/contracts";

export interface AppCtx {
  prisma: PrismaClient;
  config: AppConfig;
  jwt: JwtIssuer;
  queue: QueueDriver;
  hub: RealtimeHub;
  geo: CompositeGeoProvider;
  notifier: NotificationProvider;
  /** Transactional email only (verification/password-reset codes, Stage
   *  25) — memory/dev-log provider only, see @ronmacrae/notifications'
   *  email.ts for why no real provider exists yet. */
  email: EmailProvider;
  audit: AuditService;
  notify: NotifyService;
  /** opt-in Web Push (VAPID); see modules/push.ts */
  push: PushService;
  /** simulated rider location (preview); see rt/location-sim.ts */
  sim: LocationSimulator;
  log: Logger;

  requireStaff: (...roles: StaffRole[]) => preHandlerAsyncHookHandler;
  requireRider: preHandlerAsyncHookHandler;
  requireAuth: preHandlerAsyncHookHandler;
  requireOwner: preHandlerAsyncHookHandler;
}

declare module "fastify" {
  interface FastifyRequest {
    user: AccessTokenPayload | null;
  }
  interface FastifyInstance {
    ctx: AppCtx;
  }
}

export function buildCtx(
  prisma: PrismaClient,
  config: AppConfig,
  jwt: JwtIssuer,
  queue: QueueDriver,
  hub: RealtimeHub,
  geo: CompositeGeoProvider,
  notifier: NotificationProvider,
  log: Logger,
): AppCtx {
  const audit = new AuditService(prisma, log);
  const notify = new NotifyService(prisma, notifier, queue, hub, config, log, audit);
  const push = new PushService(prisma, config, log);
  const sim = new LocationSimulator(prisma, hub, log);
  // Only "memory" ever exists (see email.ts) — no config knob to wire up,
  // since there's nothing real to select between.
  const email = createEmailProvider({ provider: "memory", log: (line) => log.info({ line }, "outbound email") });
  return {
    prisma,
    config,
    jwt,
    queue,
    hub,
    geo,
    notifier,
    email,
    audit,
    notify,
    push,
    sim,
    log,
    requireStaff: (...roles: StaffRole[]) => makeRequireStaff(...roles),
    requireRider: makeRequireRider(),
    requireAuth: makeRequireAnyUser(),
    requireOwner: makeRequireOwner(),
  };
}

export function getCtx(app: FastifyInstance): AppCtx {
  return app.ctx;
}
