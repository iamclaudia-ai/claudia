#!/usr/bin/env bun
/**
 * Dev server wrapper — runs the gateway with `--watch` AND watches
 * additional source directories that Bun's import-graph watcher misses
 * (UI package, extensions, web client).
 *
 * Bun's --watch only follows the server entry's import graph, so changes
 * to packages/ui/ or extensions/ (loaded via HTML import) don't trigger
 * a restart. This script fills that gap with fs.watch().
 */

import { spawn, type Subprocess } from "bun";
import { watch, type FSWatcher } from "fs";
import { resolve } from "path";

const ROOT = resolve(import.meta.dir, "..");

// Directories to watch beyond the gateway's own source
const EXTRA_WATCH_DIRS = [
  "packages/ui/src",
  "clients/web/src",
  "extensions/chat/src",
  "extensions/voice/src",
  "extensions/imessage/src",
];

const GATEWAY_DIR = resolve(ROOT, "packages/gateway");
const GATEWAY_ENTRY = "src/start.ts";

let proc: Subprocess | null = null;
let restarting = false;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;
const DEBOUNCE_MS = 300;

function startGateway(): Subprocess {
  console.log("\x1b[36m[dev]\x1b[0m Starting gateway...");
  return spawn({
    cmd: ["bun", "run", "--watch", GATEWAY_ENTRY],
    cwd: GATEWAY_DIR,
    stdio: ["inherit", "inherit", "inherit"],
    env: { ...process.env },
  });
}

async function killAndWait(): Promise<void> {
  if (!proc) return;
  const p = proc;
  proc = null;
  p.kill();
  // Wait for process to fully exit (port + DB released)
  await p.exited;
}

function restart(reason: string) {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(async () => {
    if (restarting) return;
    restarting = true;
    console.log(`\x1b[36m[dev]\x1b[0m Restarting — ${reason}`);
    await killAndWait();
    proc = startGateway();
    restarting = false;
  }, DEBOUNCE_MS);
}

// Start gateway
proc = startGateway();

// Watch extra directories
const watchers: FSWatcher[] = [];

for (const dir of EXTRA_WATCH_DIRS) {
  const abs = resolve(ROOT, dir);
  try {
    const w = watch(abs, { recursive: true }, (_event, filename) => {
      if (!filename) return;
      // Ignore non-source files
      if (!/\.(ts|tsx|css|html)$/.test(filename)) return;
      restart(`${dir}/${filename}`);
    });
    watchers.push(w);
    console.log(`\x1b[36m[dev]\x1b[0m Watching ${dir}/`);
  } catch {
    // Directory might not exist (e.g. optional extensions)
  }
}

// Clean up on exit
async function cleanup() {
  watchers.forEach((w) => w.close());
  await killAndWait();
  process.exit(0);
}

process.on("SIGINT", cleanup);
process.on("SIGTERM", cleanup);
