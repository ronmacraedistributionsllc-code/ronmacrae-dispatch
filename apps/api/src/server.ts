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
import { deliveryRequestRoutes } from "./modules/delivery.js";
import { trackingRoutes } from "./modules/tracking.js";
import { settingsRoutes } from "./modules/settings.js";

const SERVICE = "ronmacrae-dispatch-api";

export async function createApp(ctx: AppCtx): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });

  await app.register(fastifySensible);
  await app.register(fastifyCookie);
  await app.register(fastifyRateLimit, {
    max: 1000,
    timeWindow: "1 minute",
    errorResponseBuilder: (_req, context) => ({
      statusCode: 429,
      error: "Too Many Requests",
      message: `Rate limit exceeded, try again in ${context}`,
    }),
  });
  await app.register(fastifyMultipart, {
    limits: { fileSize: ctx.config.MAX_UPLOAD_BYTES },
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
  await deliveryRequestRoutes(app, ctx);
  await trackingRoutes(app, ctx);
  await settingsRoutes(app, ctx);
  await notificationRoutes(app, ctx);
  await auditRoutes(app, ctx);

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
