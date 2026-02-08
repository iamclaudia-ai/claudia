/**
 * Build script for the VS Code webview.
 * Uses bun-plugin-tailwind to process Tailwind CSS v4.
 */

import tailwind from "bun-plugin-tailwind";

const result = await Bun.build({
  entrypoints: ["src/webview/index.tsx"],
  outdir: "dist/webview",
  plugins: [tailwind],
  bundle: true,
  minify: true,
});

if (!result.success) {
  console.error("Build failed:");
  for (const log of result.logs) {
    console.error(log);
  }
  process.exit(1);
}

console.log("Webview build complete!");
