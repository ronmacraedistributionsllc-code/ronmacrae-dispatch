/**
 * Integration test harness: a real Fastify app wired to a real (but disposable,
 * per-test-file) sqlite database, so offer/assignment tests exercise actual Prisma
 * transactions and row locking rather than mocks. Never touches `data/dev.db`.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import { loadConfig } from "../../src/config.js";
import { getPrisma, type PrismaClient } from "../../src/prisma.js";
import { JwtIssuer } from "../../src/lib/jwt.js";
import { createQueueDriver } from "../../src/queue/index.js";
import { RealtimeHub } from "../../src/rt/hub.js";
import { createGeoProvider } from "@ronmacrae/geo";
import { createNotificationProvider } from "@ronmacrae/notifications";
import { buildCtx, type AppCtx } from "../../src/ctx.js";
import { createApp } from "../../src/server.js";
import { createLogger } from "../../src/lib/log.js";
import type { Role } from "@ronmacrae/contracts";

const apiRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Push the canonical schema onto a fresh, uniquely-named sqlite file for this test file. */
function prepareTestDb(dbFile: string): void {
  rmSync(dbFile, { force: true });
  rmSync(`${dbFile}-journal`, { force: true });
  mkdirSync(dirname(dbFile), { recursive: true });
  const schema = join(apiRoot, "prisma", "schema.generated.prisma");
  if (!existsSync(schema)) {
    throw new Error(
      `${schema} is missing. Run "DEV_DB=1 npm run db:prepare" in apps/api at least once before running the offers integration tests.`,
    );
  }
  const res = spawnSync("npx", ["--no-install", "prisma", "db", "push", `--schema=${schema}`, "--skip-generate", "--accept-data-loss"], {
    cwd: apiRoot,
    env: { ...process.env, DATABASE_URL: `file:${dbFile}` },
    stdio: "pipe",
  });
  if (res.status !== 0) {
    throw new Error(`prisma db push failed for test db ${dbFile}:\n${res.stdout}\n${res.stderr}`);
  }
}

export interface TestHarness {
  app: FastifyInstance;
  ctx: AppCtx;
  prisma: PrismaClient;
  jwt: JwtIssuer;
  tokenFor: (user: { id: string; name: string; role: Role; riderId?: string }) => Promise<string>;
  cleanup: () => Promise<void>;
}

/** Build an isolated app + db for one test file. Call once in `beforeAll`. */
export async function buildTestHarness(dbName: string): Promise<TestHarness> {
  const dbFile = join(apiRoot, "data", `${dbName}.db`);
  prepareTestDb(dbFile);

  const config = loadConfig({
    ...process.env,
    DEV_DB: "1",
    // Relative (not absolute) on purpose: config.ts's effectiveDatabaseUrl() mis-resolves
    // an absolute "file:/..." DEV_DB URL (it strips the leading "/" along with "file:",
    // so the startsWith("/") absolute-path check never matches, and apiRoot gets
    // prepended twice). That's a pre-existing bug, out of scope here — see
    // WORK_IN_PROGRESS.md. Sticking to the same relative form the app's own .env uses
    // sidesteps it without touching unrelated production code.
    DATABASE_URL: `file:./data/${dbName}.db`,
    QUEUE_DRIVER: "memory",
    NOTIFICATION_PROVIDER: "memory",
    LOG_LEVEL: "error",
  });
  const log = createLogger("error", "api-test");
  const prisma = getPrisma(config);
  const jwt = new JwtIssuer(config.SESSION_SECRET);
  const queue = createQueueDriver(log, "memory", "");
  const hub = new RealtimeHub(jwt, prisma, log, config.APP_ORIGIN);
  const geo = createGeoProvider({ googleApiKey: undefined, jamnavApiKey: undefined, jamnavEnabled: false });
  const notifier = createNotificationProvider({ provider: "memory", log: () => {} });
  const ctx = buildCtx(prisma, config, jwt, queue, hub, geo, notifier, log);
  const app = await createApp(ctx);
  await app.ready();

  return {
    app,
    ctx,
    prisma,
    jwt,
    tokenFor: (user) => jwt.issueAccess(user),
    cleanup: async () => {
      await app.close();
      await prisma.$disconnect();
      rmSync(dbFile, { force: true });
      rmSync(`${dbFile}-journal`, { force: true });
    },
  };
}
