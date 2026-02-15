/**
 * Build script for DOMINATRIX Chrome extension.
 * Bundles TypeScript sources, copies static assets to dist/.
 */

import { existsSync, mkdirSync, copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const distDir = join(__dirname, "dist");
const srcDir = join(__dirname, "src");
const iconsDir = join(__dirname, "icons");

// Read version from package.json
const pkg = JSON.parse(readFileSync(join(__dirname, "package.json"), "utf8"));

console.log("Bundling DOMINATRIX Chrome extension...");

// Clean & create dist
if (!existsSync(distDir)) mkdirSync(distDir, { recursive: true });

// Bundle background worker (ESM — service workers support modules)
await Bun.build({
  entrypoints: [join(srcDir, "background.ts")],
  outdir: distDir,
  target: "browser",
  format: "esm",
  sourcemap: "external",
});

// Bundle content script (IIFE — content scripts cannot use ES modules)
await Bun.build({
  entrypoints: [join(srcDir, "content-script.ts")],
  outdir: distDir,
  target: "browser",
  format: "iife",
  sourcemap: "external",
});

// Bundle main world bridge (IIFE — injected into page's MAIN world)
await Bun.build({
  entrypoints: [join(srcDir, "main-world-bridge.ts")],
  outdir: distDir,
  target: "browser",
  format: "iife",
  sourcemap: "external",
});

// Bundle side panel script (IIFE — loaded via <script src>)
await Bun.build({
  entrypoints: [join(srcDir, "sidepanel.ts")],
  outdir: distDir,
  target: "browser",
  format: "iife",
  sourcemap: "external",
});

// Copy manifest.json with version interpolation
let manifest = readFileSync(join(__dirname, "manifest.json"), "utf8");
manifest = manifest.replace(/{VERSION}/g, pkg.version);
writeFileSync(join(distDir, "manifest.json"), manifest);

// Copy side panel HTML
copyFileSync(join(srcDir, "sidepanel.html"), join(distDir, "sidepanel.html"));

// Copy icons (if they exist)
const iconDir = join(distDir, "icons");
if (!existsSync(iconDir)) mkdirSync(iconDir, { recursive: true });
for (const size of [16, 32, 48, 128]) {
  const src = join(iconsDir, `icon${size}.png`);
  if (existsSync(src)) {
    copyFileSync(src, join(iconDir, `icon${size}.png`));
  }
}

console.log(`DOMINATRIX extension built → dist/ (v${pkg.version})`);
console.log("");
console.log("To load in Chrome:");
console.log("  1. Go to chrome://extensions/");
console.log('  2. Enable "Developer mode"');
console.log('  3. Click "Load unpacked"');
console.log("  4. Select clients/dominatrix/dist/");
