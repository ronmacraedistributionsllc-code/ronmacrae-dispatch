/**
 * Captures Play-Store-size phone screenshots from the SEEDED DEMO DATABASE only.
 *   npm run build --workspace @ronmacrae/web   # once
 *   node store/capture-screenshots.mjs
 * Starts its own throw-away API on :3901 with a disposable sqlite file, so it
 * never touches dev.db or production, and removes the file afterwards.
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { chromium } = createRequire(join(root, "e2e", "package.json"))("@playwright/test");
const out = join(root, "store", "screenshots");
const dbFile = "data/store-shots.db";
const PORT = "3901";
const base = `http://127.0.0.1:${PORT}`;
const env = {
  ...process.env, DEV_DB: "1", DATABASE_URL: `file:./${dbFile}`, QUEUE_DRIVER: "memory", NOTIFICATION_PROVIDER: "memory",
  SESSION_SECRET: "store-shots-secret-0123456789", WEB_DIST: join(root, "apps", "web", "dist"),
  HOST: "127.0.0.1", PORT, LOG_LEVEL: "warn", RATE_LIMIT_MAX: "100000",
};

rmSync(join(root, "apps", "api", dbFile), { force: true });
mkdirSync(out, { recursive: true });
const seed = spawnSync("npm", ["run", "seed", "--workspace", "@ronmacrae/api"], { cwd: root, env, stdio: "inherit" });
if (seed.status !== 0) process.exit(1);
const server = spawn("npm", ["run", "dev", "--workspace", "@ronmacrae/api"], { cwd: root, env, stdio: "ignore", detached: true });

async function waitUp() {
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(`${base}/api/health`)).ok) return; } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error("API did not start");
}

async function shot(browser, name, identifier, password, path, prepare) {
  const ctx = await browser.newContext({ viewport: { width: 360, height: 640 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  if (identifier) {
    await page.goto(`${base}/login`);
    await page.getByLabel("Email or phone").fill(identifier);
    await page.getByLabel("Password").fill(password);
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.waitForURL((u) => !u.pathname.startsWith("/login"));
  }
  await page.goto(`${base}${path}`);
  await page.waitForLoadState("networkidle");
  await page.addStyleTag({ content: '[aria-label="Change theme"] { display: none !important; }' });
  if (prepare) await prepare(page);
  await page.screenshot({ path: join(out, `${name}.png`) });
  await ctx.close();
  console.log("captured", name);
}

/** A few realistic demo orders so the screens aren't empty (demo database only). */
async function seedDemoOrders() {
  const api = async (path, init, token) => {
    const res = await fetch(`${base}/api${path}`, { ...init, headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) } });
    if (!res.ok) throw new Error(`${path} -> ${res.status} ${await res.text()}`);
    return res.json();
  };
  const { accessToken } = await api("/auth/login", { method: "POST", body: JSON.stringify({ identifier: "dispatcher@ronmacrae.example", password: "dispatch1234" }) });
  const { customers } = await api("/customers", {}, accessToken);
  const { riders } = await api("/riders", {}, accessToken);
  const items = ["2x jerk chicken meal", "1x grocery bag, J$4,200 COD", "Birthday cake, fragile", "3x pharmacy items"];
  for (const [i, itemSummary] of items.entries()) {
    const { job } = await api("/jobs", { method: "POST", body: JSON.stringify({ customerId: customers[i % customers.length].id, itemSummary }) }, accessToken);
    if (i < 3 && riders[0]) await api(`/jobs/${job.id}/assignments`, { method: "POST", body: JSON.stringify({ riderId: riders[0].id }) }, accessToken);
  }
}

try {
  await waitUp();
  await seedDemoOrders();
  const browser = await chromium.launch();
  await shot(browser, "01-sign-in", null, null, "/login");
  await shot(browser, "02-dispatch-ops-board", "dispatcher@ronmacrae.example", "dispatch1234", "/ops");
  await shot(browser, "03-new-order", "dispatcher@ronmacrae.example", "dispatch1234", "/jobs/new");
  await shot(browser, "04-courier-deliveries", "+8765550001", "rider1234", "/");
  await shot(browser, "05-cash-reconciliation", "accountant@ronmacrae.example", "account1234", "/cod");
  await shot(browser, "06-my-account", "dispatcher@ronmacrae.example", "dispatch1234", "/account");
  // Play feature graphic, 1024x500: brand name and the one-line promise, nothing invented.
  const gctx = await browser.newContext({ viewport: { width: 1024, height: 500 } });
  const g = await gctx.newPage();
  await g.setContent(`<body style="margin:0;width:1024px;height:500px;background:#0b0b0d;color:#fff;font-family:Inter,Helvetica,Arial,sans-serif;display:flex;flex-direction:column;justify-content:center;padding:0 80px;box-sizing:border-box">
    <div style="color:#f2b705;font-size:84px;font-weight:700;letter-spacing:-1px">Ronmacrae</div>
    <div style="font-size:30px;letter-spacing:14px;color:#a1a1aa;margin:6px 0 34px">DISPATCH</div>
    <div style="font-size:34px;color:#e4e4e7">Dispatch, couriers and delivery tracking.</div></body>`);
  await g.screenshot({ path: join(out, "feature-graphic-1024x500.png") });
  await gctx.close();
  await browser.close();
} finally {
  try { process.kill(-server.pid); } catch { /* already gone */ }
  rmSync(join(root, "apps", "api", dbFile), { force: true });
}
