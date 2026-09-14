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
  /** The default business every pre-multi-tenancy test fixture lands in (see
   *  the businessId auto-fill extension below). Tests exercising real
   *  cross-business isolation create a second Business explicitly instead of
   *  relying on this one. */
  business: { id: string; name: string };
  tokenFor: (user: { id: string; name: string; role: Role; riderId?: string; businessId?: string | null; platformRole?: "owner" }) => Promise<string>;
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
    // Every test in one file shares this one harness/app instance, so every
    // `app.inject()` call — across every `it()` block — counts against the
    // same in-memory rate-limit bucket, unlike real traffic spread across
    // many actual users/IPs. Several login/signup routes set their own
    // deliberately tight per-route limit (e.g. 10/min on merchant-portal
    // login) that RATE_LIMIT_MAX alone can't raise — a per-route `config.
    // rateLimit` fully replaces the plugin's global default for that route,
    // it doesn't read RATE_LIMIT_MAX at all. DISABLE_RATE_LIMIT (see
    // server.ts) skips registering the plugin altogether instead, which
    // makes every per-route override inert too. Never set outside this
    // harness — same "e2e's own RATE_LIMIT_MAX override, Stage 21 notes"
    // problem class, just needing the stronger fix once real coverage grew
    // enough sequential same-route calls in one file to hit a specific
    // route's own limit, not just the shared global one.
    DISABLE_RATE_LIMIT: "1",
  });
  const log = createLogger("error", "api-test");
  const basePrisma = getPrisma(config);
  const business = await basePrisma.business.create({ data: { name: "Test Business", slug: `test-business-${dbName}` } });

  // Most existing test fixtures predate multi-tenancy and create Job/Customer/
  // Zone/JobOffer/Rider rows with no businessId at all. Rather than editing
  // ~90 call sites across a dozen files, this extension fills in the one
  // default business whenever a test fixture omits it — real request-handling
  // code always sets businessId explicitly from the authenticated actor, so
  // this default never fires for anything going through the actual API, only
  // for these direct-to-Prisma test setup calls. A rider fixture also gets an
  // active RiderMembership at that business, matching the platform's rule
  // that only an active membership makes a rider eligible for that
  // business's offers/assignments.
  const prisma = basePrisma.$extends({
    query: {
      job: { create: ({ args, query }) => { args.data.businessId ??= business.id; return query(args); } },
      customer: { create: ({ args, query }) => { args.data.businessId ??= business.id; return query(args); } },
      zone: { create: ({ args, query }) => { args.data.businessId ??= business.id; return query(args); } },
      jobOffer: { create: ({ args, query }) => { args.data.businessId ??= business.id; return query(args); } },
      rider: {
        create: async ({ args, query }) => {
          const rider = (await query(args)) as { id: string };
          await basePrisma.riderMembership.create({ data: { riderId: rider.id, businessId: business.id, status: "active", approvedAt: new Date() } });
          return rider;
        },
      },
    },
  }) as unknown as PrismaClient;

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
    business,
    // Staff roles default to the harness's own business unless the test
    // explicitly passes a different one (or `businessId: null` — used for a
    // platform-owner token, which has no single business). Riders never
    // carry a businessId on their own token (their access is per-job via
    // RiderMembership, not a fixed session business).
    tokenFor: (user) => {
      const businessId =
        user.businessId === null
          ? undefined
          : (user.businessId ?? (user.role !== "rider" && !user.platformRole ? business.id : undefined));
      return jwt.issueAccess({ id: user.id, name: user.name, role: user.role, riderId: user.riderId, businessId, platformRole: user.platformRole });
    },
    cleanup: async () => {
      await app.close();
      await basePrisma.$disconnect();
      rmSync(dbFile, { force: true });
      rmSync(`${dbFile}-journal`, { force: true });
    },
  };
}
