#!/usr/bin/env node
/**
 * Uploads a signed .aab to a Play Console testing/production track via
 * the Google Play Developer API (androidpublisher v3) — no browser
 * login, no Play Console UI. Needs a service account JSON key with
 * Release Manager access on this app; see README.md's "Automated
 * uploads" section for the one-time Play Console/Cloud Console setup
 * only a human with account access can do.
 *
 * Usage:
 *   GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account.json \
 *     node upload-release.mjs [--track internal|alpha|beta|production] [--aab path/to/app-release.aab]
 *
 * Defaults: --track internal, --aab app/build/outputs/bundle/release/app-release.aab
 *
 * The service account key path is read from GOOGLE_APPLICATION_CREDENTIALS
 * only — never hardcoded, never logged, never committed (matches the
 * existing keystore-credentials.txt convention in this directory).
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { google } from "googleapis";

const PACKAGE_NAME = "com.login.dispatched";

function parseArgs(argv) {
  const args = { track: "internal", aab: "app/build/outputs/bundle/release/app-release.aab" };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--track") args.track = argv[++i];
    else if (argv[i] === "--aab") args.aab = argv[++i];
  }
  return args;
}

async function main() {
  const { track, aab } = parseArgs(process.argv.slice(2));
  const validTracks = ["internal", "alpha", "beta", "production"];
  if (!validTracks.includes(track)) {
    throw new Error(`--track must be one of ${validTracks.join(", ")} (got "${track}")`);
  }

  const keyPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (!keyPath) {
    throw new Error(
      "Set GOOGLE_APPLICATION_CREDENTIALS to the path of your Play Console service-account JSON key. See README.md's \"Automated uploads\" section.",
    );
  }
  if (!existsSync(keyPath)) {
    throw new Error(`GOOGLE_APPLICATION_CREDENTIALS points to a file that doesn't exist: ${keyPath}`);
  }

  const aabPath = resolve(aab);
  if (!existsSync(aabPath)) {
    throw new Error(`AAB not found at ${aabPath} — build it first (see README.md).`);
  }

  const auth = new google.auth.GoogleAuth({
    keyFile: keyPath,
    scopes: ["https://www.googleapis.com/auth/androidpublisher"],
  });
  const publisher = google.androidpublisher({ version: "v3", auth });

  console.log(`[upload-release] opening an edit for ${PACKAGE_NAME}...`);
  const edit = await publisher.edits.insert({ packageName: PACKAGE_NAME });
  const editId = edit.data.id;

  console.log(`[upload-release] uploading ${aabPath}...`);
  const bundle = await publisher.edits.bundles.upload({
    packageName: PACKAGE_NAME,
    editId,
    media: { mimeType: "application/octet-stream", body: readFileSync(aabPath) },
  });
  const versionCode = bundle.data.versionCode;
  console.log(`[upload-release] uploaded — versionCode ${versionCode}`);

  console.log(`[upload-release] assigning versionCode ${versionCode} to the "${track}" track...`);
  await publisher.edits.tracks.update({
    packageName: PACKAGE_NAME,
    editId,
    track,
    requestBody: {
      track,
      releases: [{ versionCodes: [String(versionCode)], status: "completed" }],
    },
  });

  console.log("[upload-release] committing edit...");
  await publisher.edits.commit({ packageName: PACKAGE_NAME, editId });

  console.log(`\n[upload-release] done — versionCode ${versionCode} is live on the "${track}" track for ${PACKAGE_NAME}.`);
}

main().catch((err) => {
  console.error(`[upload-release] FAILED: ${err.message}`);
  process.exitCode = 1;
});
