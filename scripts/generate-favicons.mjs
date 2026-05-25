#!/usr/bin/env node
// Generate PNG favicon set from assets/logo-mark.svg.
// Outputs to dashboard/client/ where the dashboard server static-serves them.
//
// Run with:  node scripts/generate-favicons.mjs
//
// Re-run after editing assets/logo-mark.svg. The output PNGs are committed
// (they're a tiny build artifact — committing avoids needing a build step
// in CI for a personal-use tool with one developer).

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const MARK_SVG = resolve(ROOT, "assets", "logo-mark.svg");
const OUT_DIR = resolve(ROOT, "dashboard", "client");

const SIZES = [
  { size: 16,  name: "favicon-16.png" },
  { size: 32,  name: "favicon-32.png" },
  { size: 48,  name: "favicon-48.png" },
  { size: 180, name: "apple-touch-icon.png" },
  { size: 192, name: "icon-192.png" },
  { size: 512, name: "icon-512.png" },
];

const svg = readFileSync(MARK_SVG);
console.log(`Rasterizing ${MARK_SVG} (${svg.length} bytes) → ${OUT_DIR}`);

for (const { size, name } of SIZES) {
  const out = resolve(OUT_DIR, name);
  // density 384 = 4096x4096 intermediate raster from the 1024 viewBox; plenty
  // for any output size up to 512. Beyond that we'd hit sharp's pixel limit.
  await sharp(svg, { density: 384 })
    .resize(size, size, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png({ compressionLevel: 9 })
    .toFile(out);
  console.log(`  ${name.padEnd(24)} ${size}×${size}`);
}

console.log("Done.");
