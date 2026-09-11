import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { defineConfig, devices } from "@playwright/test";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");
const webDist = join(repoRoot, "apps", "web", "dist");

export default defineConfig({
  testDir: join(here, "specs"),
  timeout: 45_000,
  expect: { timeout: 15_000 },
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: "http://localhost:3000",
  },
  webServer: {
    command: "npm run seed --workspace @ronmacrae/api && npm run dev --workspace @ronmacrae/api",
    cwd: repoRoot,
    url: "http://localhost:3000/api/health",
    timeout: 120_000,
    reuseExistingServer: !process.env.CI,
    env: {
      DEV_DB: "1",
      // Isolated from the manually-used apps/api/data/dev.db on purpose: e2e runs
      // must never grow or pollute the database a person is looking at in the
      // preview. Same disposable-sqlite convention, different file.
      DATABASE_URL: "file:./data/e2e-test.db",
      QUEUE_DRIVER: "memory",
      NOTIFICATION_PROVIDER: "memory",
      // self-sufficient: works whether or not the caller provides a secret
      SESSION_SECRET: process.env.SESSION_SECRET ?? "e2e-session-secret-0123456789",
      WEB_DIST: webDist,
      HOST: "127.0.0.1",
      PORT: "3000",
      LOG_LEVEL: "warn",
      // The whole suite's traffic — every test, every spec file, one long
      // serial run — shares a single IP (localhost), unlike real production
      // traffic spread across many users. The production-sane default
      // (1000/min) is real abuse protection there; here it's just an
      // accident of how e2e tests happen to be shaped, and a long run was
      // starting to trip it near the end (real finding, not a product bug —
      // see WORK_IN_PROGRESS.md's Stage 21 notes).
      RATE_LIMIT_MAX: "100000",
    },
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
