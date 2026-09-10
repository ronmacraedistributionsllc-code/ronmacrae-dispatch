#!/usr/bin/env node
/**
 * Generates the PWA icons (dependency-free SVG) into public/icons/.
 * Runs on prebuild; safe to run repeatedly.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "..", "public", "icons");
mkdirSync(out, { recursive: true });

const icon = (maskable) => `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <rect width="512" height="512" rx="${maskable ? 0 : 96}" fill="#123f2e"/>
  <g transform="translate(256 256) scale(${maskable ? 0.72 : 1}) translate(-256 -256)">
    <rect x="146" y="146" width="220" height="220" rx="36" fill="#f2b705"/>
    <text x="256" y="292" font-family="Arial, Helvetica, sans-serif" font-size="128" font-weight="700" text-anchor="middle" fill="#123f2e">RM</text>
  </g>
</svg>`;

writeFileSync(join(out, "icon.svg"), icon(false));
writeFileSync(join(out, "icon-maskable.svg"), icon(true));
console.log("[gen-icons] wrote public/icons/icon.svg + icon-maskable.svg");
