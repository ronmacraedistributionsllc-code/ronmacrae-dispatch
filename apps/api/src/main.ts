import { loadConfig } from "./config.js";
import { createLogger } from "./lib/log.js";
import { getPrisma } from "./prisma.js";
import { JwtIssuer } from "./lib/jwt.js";
import { createQueueDriver } from "./queue/index.js";
import { RealtimeHub } from "./rt/hub.js";
import { createGeoProvider } from "@ronmacrae/geo";
import { createNotificationProvider } from "@ronmacrae/notifications";
import { buildCtx } from "./ctx.js";
import { createApp } from "./server.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const log = createLogger(config.LOG_LEVEL, "api");

  const prisma = getPrisma(config);
  await prisma.$connect();

  const jwt = new JwtIssuer(config.SESSION_SECRET);
  const queue = createQueueDriver(log, config.QUEUE_DRIVER, config.REDIS_URL);
  const hub = new RealtimeHub(jwt, prisma, log, config.APP_ORIGIN);
  const geo = createGeoProvider({
    googleApiKey: config.GOOGLE_MAPS_API_KEY || undefined,
    jamnavApiKey: config.JAMNAV_API_KEY || undefined,
    jamnavEnabled: config.JAMNAV_ENABLED,
  });
  const notifier = createNotificationProvider({
    provider: config.NOTIFICATION_PROVIDER,
    twilio: {
      accountSid: config.TWILIO_ACCOUNT_SID || undefined,
      authToken: config.TWILIO_AUTH_TOKEN || undefined,
      whatsappFrom: config.TWILIO_WHATSAPP_FROM || undefined,
      smsFrom: config.TWILIO_SMS_FROM || undefined,
    },
    log: (line) => log.info({ line }, "outbound notification"),
  });

  const ctx = buildCtx(prisma, config, jwt, queue, hub, geo, notifier, log);
  const app = await createApp(ctx);

  queue.register(["notify.dispatch"], (job) =>
    ctx.notify.dispatch((job.payload as { id: string }).id),
  );
  await queue.start();
  hub.startPing();

  await app.listen({ port: config.PORT, host: config.HOST });
  log.info(
    { port: config.PORT, db: config.DEV_DB ? "sqlite" : "postgres", queue: queue.kind, web: config.WEB_DIST || null },
    "ronmacrae-dispatch api listening",
  );

  const shutdown = async (signal: string): Promise<void> => {
    log.info({ signal }, "shutting down");
    try {
      await app.close();
      await queue.stop();
      await ctx.sim.stopAll();
      await hub.stop();
      await prisma.$disconnect();
      process.exit(0);
    } catch (err) {
      log.error({ err: String(err) }, "shutdown failed");
      process.exit(1);
    }
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error("fatal:", err);
  process.exit(1);
});
