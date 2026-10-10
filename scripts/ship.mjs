#!/usr/bin/env node
/**
 * `npm run ship -- "message"` — update EVERYWHERE in one command.
 *
 * Local dev servers hot-reload on save, so "both" really means local +
 * production: this script runs the fast gates, commits everything on the
 * current branch, forwards it to `master` if needed, and pushes — and the
 * push is what Render auto-deploys (verify once in the Render dashboard:
 * service → Settings → Auto-Deploy = Yes, branch = master).
 *
 * The full e2e suite runs in CI on every push to master (see
 * .github/workflows/ci.yml); locally we run the fast gates only so
 * shipping stays a one-minute affair. Pass --e2e to run it here too.
 *
 * Aborts (before committing anything) on: failing gates, merge
 * conflicts, or a push rejection. Never force-pushes.
 */
import { execSync } from "node:child_process";

const DRY = process.argv.includes("--dry-run");
const WITH_E2E = process.argv.includes("--e2e");
const message =
  process.argv.slice(2).find((a) => !a.startsWith("-")) ??
  `Ship ${new Date().toISOString().slice(0, 16).replace("T", " ")}`;

/** readOnly commands still execute in --dry-run (they change nothing). */
function sh(cmd, opts = {}) {
  const readOnly = opts.readOnly === true;
  console.log(`$ ${cmd}${DRY && !readOnly ? "   (dry-run: skipped)" : ""}`);
  if (DRY && !readOnly) return "";
  return execSync(cmd, { stdio: ["ignore", "pipe", "inherit"], encoding: "utf8" }).trim();
}

function fail(msg) {
  console.error(`\nship: ABORTED — ${msg}`);
  process.exit(1);
}

const repoRoot = new URL("..", import.meta.url).pathname;
process.chdir(repoRoot);

// 1. Fast gates (same ones CI runs, minus e2e unless asked).
for (const gate of ["npm run typecheck", "npm run lint", "npm run test:unit", "npm run build"]) {
  try {
    sh(gate);
  } catch {
    fail(`gate failed: ${gate} — fix it, then ship again. Nothing was committed.`);
  }
}
if (WITH_E2E) {
  try {
    sh("rm -f apps/api/data/e2e-test.db && npm run e2e");
  } catch {
    fail("e2e failed — fix it, then ship again. Nothing was committed.");
  }
}

// 2. Commit whatever is dirty (nothing to do is fine — push still runs,
//    so a gates-only re-ship redeploys).
const dirty = sh("git status --porcelain", { readOnly: true });
if (dirty) {
  sh("git add -A");
  try {
    sh(`git commit -m ${JSON.stringify(message)}`);
  } catch {
    fail("commit failed.");
  }
} else {
  console.log("ship: working tree clean, nothing to commit.");
}

// 3. Land on master. If we're on a feature branch, merge it in
//    (no-ff keeps the batch visible); conflicts abort before any push.
const branch = sh("git branch --show-current", { readOnly: true });
if (branch !== "master") {
  console.log(`ship: merging ${branch} into master…`);
  sh("git switch master");
  try {
    sh(`git merge --no-ff ${branch} -m "Merge ${branch}: ${message}"`);
  } catch {
    sh(`git merge --abort 2>/dev/null; git switch ${branch}`);
    fail(`merge conflict merging ${branch} into master — resolved nothing, left you on ${branch}.`);
  }
}

// 4. Push = deploy (Render auto-deploys master).
try {
  sh("git push origin master");
} catch {
  fail("push rejected — run `git pull --rebase` (or check GitHub auth) and ship again. Local master kept your merge.");
}

console.log("\nship: done. Watch CI (Actions tab) go green, then Render redeploys");
console.log("in a few minutes — verify with: curl https://orders.ronmacraedistributions.com/api/health");
