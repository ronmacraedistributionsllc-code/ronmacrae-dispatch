import { existsSync } from "node:fs";
import { resolve } from "node:path";
import Fastify, { type FastifyError, type FastifyInstance } from "fastify";
import fastifySensible from "@fastify/sensible";
import fastifyCookie from "@fastify/cookie";
import fastifyRateLimit from "@fastify/rate-limit";
import fastifyMultipart from "@fastify/multipart";
import fastifyStatic from "@fastify/static";
import fastifyWebsocket from "@fastify/websocket";
import { ZodError } from "zod";
import { WS_PATH } from "@ronmacrae/contracts";
import type { AppCtx } from "./ctx.js";
import { registerAuthHook, authRoutes } from "./modules/auth.js";
import { userRoutes } from "./modules/users.js";
import { zoneRoutes } from "./modules/zones.js";
import { quoteRoutes } from "./modules/quotes.js";
import { notificationRoutes } from "./modules/notify.js";
import { auditRoutes } from "./modules/audit.js";
import { customerRoutes } from "./modules/customers.js";
import { riderRoutes } from "./modules/riders.js";
import { bearerRoutes } from "./modules/bearer.js";
import { offerRoutes } from "./modules/offers.js";
import { pushRoutes } from "./modules/push.js";
import { geoRoutes } from "./modules/geo.js";
import { jobRoutes } from "./modules/jobs/index.js";
import { codRoutes } from "./modules/cod.js";
import { opsBoardRoutes } from "./modules/ops-board.js";
import { reportRoutes } from "./modules/reports.js";
import { deliveryMessageRoutes } from "./modules/delivery-messages.js";
import { deliveryRequestRoutes } from "./modules/delivery.js";
import { trackingRoutes } from "./modules/tracking.js";
import { settingsRoutes } from "./modules/settings.js";
import { customerDashboardRoutes } from "./modules/customer-dashboard.js";
import { customerAccountRoutes } from "./modules/customer-account.js";
import { ownerRoutes } from "./modules/owner.js";
import { cashProfileRoutes } from "./modules/cash-profile.js";
import { merchantRoutes } from "./modules/merchants.js";
import { orderRoutes } from "./modules/order.js";
import { settlementRoutes } from "./modules/settlements.js";
import { merchantNotifyRoutes } from "./modules/merchant-notify.js";
import { dispatchNotifyRoutes } from "./modules/dispatch-notify.js";
import { merchantPortalRoutes } from "./modules/merchant-portal.js";
import { inviteRoutes } from "./modules/invites.js";
import { platformAdminRoutes } from "./modules/platform-admin.js";
import { logisticsCompanyRoutes } from "./modules/logistics-companies.js";
import { logisticsPortalRoutes } from "./modules/logistics-portal.js";
import { platformMessageRoutes } from "./modules/platform-messages.js";

const SERVICE = "ronmacrae-dispatch-api";

export async function createApp(ctx: AppCtx): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });

  await app.register(fastifySensible);
  await app.register(fastifyCookie);
  await app.register(fastifyRateLimit, {
    max: ctx.config.RATE_LIMIT_MAX,
    timeWindow: "1 minute",
    errorResponseBuilder: (_req, context) => ({
      statusCode: 429,
      error: "Too Many Requests",
      message: `Rate limit exceeded, try again in ${context.after}`,
    }),
  });
  await app.register(fastifyMultipart, {
    limits: { fileSize: ctx.config.MAX_UPLOAD_BYTES },
  });

  // Twilio's status-callback webhook (see notify.ts) posts
  // application/x-www-form-urlencoded, which Fastify doesn't parse by
  // default (only JSON) — a tiny inline parser rather than a new dependency,
  // since this is the only route that ever needs it.
  app.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string" }, (_req, body, done) => {
    try {
      const params = new URLSearchParams(body as string);
      const out: Record<string, string> = {};
      for (const [key, value] of params) out[key] = value;
      done(null, out);
    } catch (err) {
      done(err as Error, undefined);
    }
  });

  // static web build in preview mode (API serves the built PWA on :3000)
  let servingWeb = false;
  if (ctx.config.WEB_DIST) {
    const root = resolve(ctx.config.WEB_DIST);
    if (existsSync(root)) {
      servingWeb = true;
      await app.register(fastifyStatic, {
        root,
        index: ["index.html"],
        maxAge: "1h",
      });
    } else {
      ctx.log.warn({ webDist: root }, "WEB_DIST set but directory missing; web serving disabled");
    }
  }

  await app.register(fastifyWebsocket);
  app.get(WS_PATH, { websocket: true }, (socket, req) => {
    const token = (req.query as { token?: string }).token ?? "";
    void ctx.hub.handleSocket(socket, token);
  });

  registerAuthHook(app, ctx);

  app.get("/api/health", async () => ({
    ok: true,
    service: SERVICE,
    queue: ctx.queue.kind,
    notifications: ctx.notifier.name,
    email: ctx.email.name,
    geo: ctx.geo.name,
    web: servingWeb,
    time: new Date().toISOString(),
  }));

  await authRoutes(app, ctx);
  await userRoutes(app, ctx);
  await zoneRoutes(app, ctx);
  await quoteRoutes(app, ctx);
  await customerRoutes(app, ctx);
  await riderRoutes(app, ctx);
  await bearerRoutes(app, ctx);
  await offerRoutes(app, ctx);
  await pushRoutes(app, ctx);
  await geoRoutes(app, ctx);
  await jobRoutes(app, ctx);
  await codRoutes(app, ctx);
  await opsBoardRoutes(app, ctx);
  await reportRoutes(app, ctx);
  await deliveryMessageRoutes(app, ctx);
  await deliveryRequestRoutes(app, ctx);
  await trackingRoutes(app, ctx);
  await customerDashboardRoutes(app, ctx);
  await customerAccountRoutes(app, ctx);
  await settingsRoutes(app, ctx);
  await notificationRoutes(app, ctx);
  await auditRoutes(app, ctx);
  await ownerRoutes(app, ctx);
  await cashProfileRoutes(app, ctx);
  await merchantRoutes(app, ctx);
  await orderRoutes(app, ctx);
  await settlementRoutes(app, ctx);
  await merchantNotifyRoutes(app, ctx);
  await dispatchNotifyRoutes(app, ctx);
  await merchantPortalRoutes(app, ctx);
  await inviteRoutes(app, ctx);
  await platformAdminRoutes(app, ctx);
  await logisticsCompanyRoutes(app, ctx);
  await logisticsPortalRoutes(app, ctx);
  await platformMessageRoutes(app, ctx);

  app.setErrorHandler((err, req, reply) => {
    const e = err as FastifyError;
    if (e instanceof ZodError) {
      reply.code(400).send({ error: { message: e.issues[0]?.message ?? "Invalid input", statusCode: 400 } });
      return;
    }
    const status = typeof e.statusCode === "number" && e.statusCode >= 400 ? e.statusCode : 500;
    if (status >= 500) ctx.log.error({ err: e.message, path: req.url }, "request failed");
    reply.code(status).send({
      error: {
        message: status >= 500 ? "Internal server error" : e.message || "Request failed",
        statusCode: status,
      },
    });
  });

  app.setNotFoundHandler((req, reply) => {
    if (servingWeb && req.method === "GET" && !req.raw.url?.startsWith("/api/") && !req.raw.url?.startsWith(WS_PATH)) {
      reply.type("text/html").sendFile("index.html");
      return;
    }
    reply.code(404).send({ error: { message: `Not found: ${req.raw.url ?? ""}`, statusCode: 404 } });
  });

  return app;
}
