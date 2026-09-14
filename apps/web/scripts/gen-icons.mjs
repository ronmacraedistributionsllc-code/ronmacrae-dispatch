#!/usr/bin/env node
/**
 * Generates the PWA icons into public/icons/. Runs on prebuild; safe to
 * run repeatedly.
 *
 * SVG (the original, dependency-free source) plus real PNG renders —
 * added for the Android/TWA app-store wrapper (Bubblewrap) and any
 * future iOS wrapper: neither platform's icon pipeline accepts an SVG
 * (Android's adaptive-icon and Play Store listing both require PNG;
 * Bubblewrap's own manifest fetch expects a raster `image/png` entry),
 * and a browser installing this as a PWA is happier with a raster icon
 * too — Chrome's install prompt has been known to render an SVG-only
 * manifest icon incorrectly on some platforms. The SVG stays as the
 * source of truth; every PNG below is rendered from it via sharp.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

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

const svgAny = icon(false);
const svgMaskable = icon(true);
writeFileSync(join(out, "icon.svg"), svgAny);
writeFileSync(join(out, "icon-maskable.svg"), svgMaskable);

// Sizes actually consumed somewhere: 192/512 (PWA manifest + Android
// adaptive-icon/Play-Store-listing "any" purpose), 512 maskable (Android
// adaptive-icon foreground layer), 180 (iOS home-screen touch icon, for
// the future Apple wrapper), 1024 (Play Console's separate high-res
// store-listing icon upload, which is never read from the manifest).
const renders = [
  { file: "icon-192.png", svg: svgAny, size: 192 },
  { file: "icon-512.png", svg: svgAny, size: 512 },
  { file: "icon-512-maskable.png", svg: svgMaskable, size: 512 },
  { file: "apple-touch-icon.png", svg: svgAny, size: 180 },
  { file: "icon-1024.png", svg: svgAny, size: 1024 },
];

await Promise.all(
  renders.map(({ file, svg, size }) =>
    sharp(Buffer.from(svg), { density: 384 })
      .resize(size, size)
      .png()
      .toFile(join(out, file)),
  ),
);

console.log(`[gen-icons] wrote public/icons/{icon.svg, icon-maskable.svg, ${renders.map((r) => r.file).join(", ")}}`);
