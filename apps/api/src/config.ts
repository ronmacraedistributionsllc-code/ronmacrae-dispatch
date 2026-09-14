/**
 * Centralised, validated configuration.
 * Every secret comes from the environment; nothing is hard-coded.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const apiRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = join(apiRoot, "..", "..");

/**
 * Minimal .env reader (mirrors scripts/prepare-db.mjs so the app and the DB
 * preparer agree). Real environment variables always win over the file.
 */
function loadRootEnv(): Record<string, string> {
  const file = join(repoRoot, ".env");
  if (!existsSync(file)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (key) out[key] = value;
  }
  return out;
}

/** Well-known dev-only secret so the zero-service preview needs no credentials. */
const DEV_SESSION_SECRET = "dev-insecure-session-secret-0123456789";

/**
 * Well-known dev-only Web Push (VAPID) key pair, same rationale as
 * DEV_SESSION_SECRET: the zero-service local preview needs no credentials setup.
 * A real deployment must set VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY itself — see below.
 */
const DEV_VAPID_PUBLIC_KEY = "BM_4rERFDNAdJ9zRVhImBXUT4tR2IGTBYnIBjlTSsapbDAGmTVCubSaj_DRaBn5Ofnqb2qe8StE3DKj_tfDmjVU";
const DEV_VAPID_PRIVATE_KEY = "dzlPYNLkxFNJr5fJD6Vs13Ms3PqTlVRs5u5zs3ftG4g";

const EnvSchema = z.object({
  APP_ORIGIN: z.string().default("http://localhost:5173"),
  SESSION_SECRET: z.string().min(16, "SESSION_SECRET must be at least 16 chars").optional().default(""),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  HOST: z.string().default("0.0.0.0"),
  PORT: z.coerce.number().int().positive().default(3000),

  DEV_DB: z
    .string()
    .default("1")
    .transform((v) => v === "1" || v === "true"),
  DATABASE_URL: z.string().default(""),

  QUEUE_DRIVER: z.enum(["memory", "bullmq"]).default("memory"),
  REDIS_URL: z.string().default(""),

  GOOGLE_MAPS_API_KEY: z.string().optional().or(z.literal("")).default(""),
  JAMNAV_API_KEY: z.string().optional().or(z.literal("")).default(""),
  JAMNAV_ENABLED: z.string().default("").transform((v) => v === "1" || v === "true"),

  NOTIFICATION_PROVIDER: z.enum(["memory", "twilio"]).default("memory"),
  TWILIO_ACCOUNT_SID: z.string().default(""),
  TWILIO_AUTH_TOKEN: z.string().default(""),
  TWILIO_WHATSAPP_FROM: z.string().default(""),
  TWILIO_SMS_FROM: z.string().default(""),

  /** Transactional email (verification codes, and merchant new-order
   *  notifications) — see @ronmacrae/notifications' email.ts. Leave at
   *  "memory" (the default) with no real provider connected; set
   *  EMAIL_PROVIDER=resend + RESEND_API_KEY + EMAIL_FROM to send real mail. */
  EMAIL_PROVIDER: z.enum(["memory", "resend"]).default("memory"),
  RESEND_API_KEY: z.string().default(""),
  EMAIL_FROM: z.string().default(""),

  WOO_API_URL: z.string().default("https://ronmacraedistributions.com/wp-json/wc/v3"),
  WOO_CONSUMER_KEY: z.string().default(""),
  WOO_CONSUMER_SECRET: z.string().default(""),
  WOO_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(120_000),
  WOO_CURRENCY: z.string().default(""),

  OPERATIONAL_CURRENCY: z.string().default("JMD").transform((v) => v.toUpperCase()),
  USD_TO_JMD_RATE: z.coerce
    .number()
    .positive()
    .default(155),

  PIN_LENGTH: z.coerce.number().int().min(4).max(10).default(4),
  TRACKING_LINK_TTL_HOURS: z.coerce.number().positive().default(72),
  LOCATION_RETENTION_HOURS: z.coerce.number().positive().default(24),

  WEB_DIST: z.string().default(""),
  MAX_UPLOAD_BYTES: z.coerce.number().int().positive().default(8_388_608),

  /** Global request-rate ceiling (per IP, per minute) — production default
   *  is deliberately generous rather than tight, since this is abuse
   *  protection, not throttling normal use. Overridden much higher for the
   *  e2e suite (see e2e/playwright.config.ts), where every test's traffic
   *  shares one IP (localhost) and a long serial run can otherwise exceed
   *  a production-sane ceiling on request count alone, not actual abuse. */
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(1000),
  /** Skips registering the rate-limit plugin at all — for the API vitest
   *  harness only (test-app.ts), never set in dev or production. Several
   *  routes set their own deliberately tight per-route limit (e.g. 10/min
   *  on merchant-portal login) that RATE_LIMIT_MAX above can't raise, since
   *  a route's own `config.rateLimit` fully replaces the plugin's global
   *  default rather than reading this value — as real test coverage of one
   *  such route grows, enough sequential calls in one file (which all
   *  share the harness's single in-process app, so they share one rate-
   *  limit bucket too) can trip that route's own limit even though nothing
   *  resembling abuse happened. Same underlying problem class as
   *  RATE_LIMIT_MAX's own e2e override, just needing the stronger fix. */
  DISABLE_RATE_LIMIT: z.string().default("").transform((v) => v === "1" || v === "true"),

  /** Web Push (VAPID). Dev default below when DEV_DB=1; required otherwise. */
  VAPID_PUBLIC_KEY: z.string().default(""),
  VAPID_PRIVATE_KEY: z.string().default(""),
  VAPID_SUBJECT: z.string().default("mailto:ops@ronmacraedistributions.com"),
});

export type AppConfig = z.infer<typeof EnvSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = { ...loadRootEnv(), ...process.env }): AppConfig {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid configuration:\n${issues}`);
  }
  const cfg = parsed.data;
  if (!cfg.SESSION_SECRET) {
    if (cfg.DEV_DB) {
      cfg.SESSION_SECRET = DEV_SESSION_SECRET;
    } else {
      throw new Error("Invalid configuration:\n  SESSION_SECRET: must be set when DEV_DB is not enabled");
    }
  }
  if (!cfg.DATABASE_URL) {
    if (!cfg.DEV_DB) {
      throw new Error("DATABASE_URL must be set when DEV_DB is not enabled");
    }
    // resolve a default local sqlite file
    cfg.DATABASE_URL = "";
  }
  if (!cfg.VAPID_PUBLIC_KEY || !cfg.VAPID_PRIVATE_KEY) {
    if (cfg.DEV_DB) {
      cfg.VAPID_PUBLIC_KEY = DEV_VAPID_PUBLIC_KEY;
      cfg.VAPID_PRIVATE_KEY = DEV_VAPID_PRIVATE_KEY;
    } else {
      throw new Error("Invalid configuration:\n  VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY: must be set when DEV_DB is not enabled (opt-in browser push)");
    }
  }
  // Fail fast (rather than booting and 502-ing on every send) when real email
  // is requested but its credentials are missing — this is the single most
  // common reason a "confirmation OTP never arrives" in production.
  if (cfg.EMAIL_PROVIDER === "resend") {
    if (!cfg.RESEND_API_KEY) throw new Error("Invalid configuration:\n  RESEND_API_KEY: must be set when EMAIL_PROVIDER=resend");
    if (!cfg.EMAIL_FROM) throw new Error("Invalid configuration:\n  EMAIL_FROM: must be set when EMAIL_PROVIDER=resend (an address on a domain verified with Resend)");
  }
  return cfg;
}

export function effectiveDatabaseUrl(cfg: AppConfig, apiRoot: string): string {
  // DEV_DB wins over a leftover postgres URL (mirrors scripts/prepare-db.mjs:
  // an explicit DEV_DB=1 always selects the zero-service sqlite file).
  if (!cfg.DEV_DB) return cfg.DATABASE_URL;
  if (cfg.DATABASE_URL && cfg.DATABASE_URL.startsWith("file:")) {
    const rel = cfg.DATABASE_URL.replace(/^file:\/?/, "");
    if (rel.startsWith("/")) return cfg.DATABASE_URL;
    return `file:${join(apiRoot, rel.replace(/^\.\//, ""))}`;
  }
  return `file:${join(apiRoot, "data", "dev.db")}`;
}
