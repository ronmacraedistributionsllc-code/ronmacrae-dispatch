import { PrismaClient } from "@prisma/client";
import { effectiveDatabaseUrl, type AppConfig } from "./config.js";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const apiRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Resolve DATABASE_URL before the client is constructed (sqlite default in dev). */
export function applyDatabaseEnv(cfg: AppConfig): void {
  const current = process.env.DATABASE_URL ?? "";
  if (cfg.DEV_DB || !current || current.startsWith("file:")) {
    process.env.DATABASE_URL = effectiveDatabaseUrl(cfg, apiRoot);
  }
}

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export function getPrisma(cfg: AppConfig): PrismaClient {
  applyDatabaseEnv(cfg);
  if (!globalForPrisma.prisma) {
    globalForPrisma.prisma = new PrismaClient({
      log: cfg.LOG_LEVEL === "debug" ? ["query", "warn", "error"] : ["warn", "error"],
    });
  }
  return globalForPrisma.prisma;
}

export type { PrismaClient } from "@prisma/client";
