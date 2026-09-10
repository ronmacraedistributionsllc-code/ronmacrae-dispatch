#!/usr/bin/env node
/**
 * Selects the Prisma provider based on the environment, materializes
 * `prisma/schema.generated.prisma` from the canonical `prisma/schema.prisma`,
 * then runs `prisma generate` + `prisma db push`.
 *
 *   DEV_DB=1 (or DATABASE_URL starting with "file:")  -> sqlite (zero-service)
 *   otherwise                                         -> postgresql
 *
 * No external dependencies: minimal .env parser + child_process.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const apiRoot = resolve(here, "..");
const repoRoot = resolve(apiRoot, "../..");

// --- load root .env (does not override already-set vars) ---
const envPath = join(repoRoot, ".env");
if (existsSync(envPath)) {
  const lines = readFileSync(envPath, "utf8").split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

// Honor an explicit DEV_DB; otherwise infer from the DB URL so a production
// .env (postgres URL) never silently switches to a local sqlite file.
const explicitDev = process.env.DEV_DB;
const hasPgUrl = (process.env.DATABASE_URL ?? "").startsWith("postgres");
const devDb = explicitDev ? explicitDev === "1" : !hasPgUrl;
const provider = devDb ? "sqlite" : "postgresql";

// --- resolve database url ---
let databaseUrl = process.env.DATABASE_URL ?? "";
if (devDb) {
  if (!databaseUrl || !databaseUrl.startsWith("file:")) {
    databaseUrl = `file:${join(apiRoot, "data", "dev.db")}`;
  } else if (databaseUrl.startsWith("file:./") || databaseUrl.startsWith("file:")) {
    const rel = databaseUrl.replace(/^file:\/?/, "");
    if (!rel.startsWith("/")) {
      // relative -> resolve against the api package root
      databaseUrl = `file:${join(apiRoot, rel.replace(/^\.\//, ""))}`;
    }
  }
} else if (!databaseUrl) {
  console.error("[db:prepare] DATABASE_URL is required when DEV_DB is not 1");
  process.exit(1);
}

// --- materialize the provider-specific schema ---
const canonical = join(apiRoot, "prisma", "schema.prisma");
const generated = join(apiRoot, "prisma", "schema.generated.prisma");
let schema = readFileSync(canonical, "utf8");
schema = schema.replace(
  /(datasource\s+db\s*\{[^}]*provider\s*=\s*)"[a-z]+"/,
  `$1"${provider}"`,
);
schema = schema.replace(/url\s*=\s*env\("DATABASE_URL"\)/, 'url = env("DATABASE_URL")');
writeFileSync(generated, schema);
mkdirSync(join(apiRoot, "data"), { recursive: true });
if (devDb) {
  const file = databaseUrl.replace(/^file:/, "");
  mkdirSync(dirname(file), { recursive: true });
}

// --- run prisma ---
const childEnv = { ...process.env, DATABASE_URL: databaseUrl };
function run(args) {
  const res = spawnSync("npx", ["--no-install", "prisma", ...args, `--schema=${generated}`], {
    cwd: apiRoot,
    env: childEnv,
    stdio: "inherit",
  });
  if (res.status !== 0) process.exit(res.status ?? 1);
}

console.log(`[db:prepare] provider=${provider} url=${databaseUrl.replace(/:[^:@/]+@/, ":***@")}`);
run(["generate", "--no-hints"]);
// sqlite dev DB is disposable; never auto-accept data loss against real databases
run(["db", "push", "--skip-generate", ...(provider === "sqlite" ? ["--accept-data-loss"] : [])]);
console.log("[db:prepare] done");
