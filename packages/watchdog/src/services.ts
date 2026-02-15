/**
 * Service management — direct process supervision, health checks, auto-restart.
 *
 * Manages gateway and runtime as direct child processes (Bun.spawn).
 * No tmux — stdout/stderr pipe to log files, watchdog owns the process lifecycle.
 */

import {
  PROJECT_DIR,
  LOGS_DIR,
  HEALTH_HISTORY_SIZE,
  UNHEALTHY_RESTART_THRESHOLD,
} from "./constants";
import { log } from "./logger";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Subprocess } from "bun";

// ── Types ────────────────────────────────────────────────

export interface HealthSnapshot {
  timestamp: number;
  processAlive: boolean;
  healthy: boolean;
}

export interface ManagedService {
  name: string;
  id: string;
  command: string[];
  healthUrl: string;
  port: number;
  restartBackoff: number;
  lastRestart: number;
  consecutiveFailures: number;
  history: HealthSnapshot[];
  proc: Subprocess | null;
}

// ── Service Definitions ─────────────────────────────────

export const services: Record<string, ManagedService> = {
  gateway: {
    name: "Gateway",
    id: "gateway",
    command: ["bun", "run", "--watch", "packages/gateway/src/start.ts"],
    healthUrl: "http://localhost:30086/health",
    port: 30086,
    restartBackoff: 1000,
    lastRestart: 0,
    consecutiveFailures: 0,
    history: [],
    proc: null,
  },
  runtime: {
    name: "Runtime",
    id: "runtime",
    command: ["bun", "run", "--watch", "packages/runtime/src/index.ts"],
    healthUrl: "http://localhost:30087/health",
    port: 30087,
    restartBackoff: 1000,
    lastRestart: 0,
    consecutiveFailures: 0,
    history: [],
    proc: null,
  },
};

// ── Process Helpers ─────────────────────────────────────

export function isProcessAlive(service: ManagedService): boolean {
  if (!service.proc) return false;
  // Bun subprocess: exitCode is null while running
  return service.proc.exitCode === null;
}

async function killOrphanProcesses(port: number): Promise<void> {
  const proc = Bun.spawn(["lsof", "-ti", `tcp:${port}`], {
    stdout: "pipe",
    stderr: "ignore",
  });
  const output = await new Response(proc.stdout).text();
  await proc.exited;

  const pids = output
    .trim()
    .split("\n")
    .filter(Boolean)
    .map(Number)
    .filter((n) => !isNaN(n) && n !== process.pid);

  for (const pid of pids) {
    log("WARN", `Killing orphan process on port ${port}: PID ${pid}`);
    try {
      process.kill(pid, "SIGTERM");
    } catch {}
  }
  if (pids.length > 0) {
    await new Promise((r) => setTimeout(r, 1000));
  }
}

export async function startService(service: ManagedService): Promise<void> {
  // Kill existing process if still alive
  if (service.proc && service.proc.exitCode === null) {
    log("INFO", `Stopping ${service.name} (PID ${service.proc.pid})...`);
    service.proc.kill("SIGTERM");
    // Give it a moment to die
    await new Promise((r) => setTimeout(r, 1000));
    // Force kill if still alive
    if (service.proc.exitCode === null) {
      service.proc.kill("SIGKILL");
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  // Kill any orphan processes already bound to this port
  await killOrphanProcesses(service.port);

  // Ensure log dir exists
  if (!existsSync(LOGS_DIR)) mkdirSync(LOGS_DIR, { recursive: true });

  const logPath = join(LOGS_DIR, `${service.id}.log`);

  // Spawn as direct child process, pipe stdout+stderr to log file
  service.proc = Bun.spawn(service.command, {
    cwd: PROJECT_DIR,
    stdout: Bun.file(logPath),
    stderr: Bun.file(logPath),
    env: { ...process.env, FORCE_COLOR: "0" },
  });

  service.lastRestart = Date.now();
  service.consecutiveFailures = 0;
  log("INFO", `Started ${service.name} (PID ${service.proc.pid})`);

  // Monitor for unexpected exit
  service.proc.exited.then((code) => {
    log("WARN", `${service.name} exited with code ${code}`);
  });
}

export async function restartService(id: string): Promise<{ ok: boolean; message: string }> {
  const service = services[id];
  if (!service) {
    return { ok: false, message: `Unknown service: ${id}` };
  }

  log("INFO", `Restarting ${service.name}...`);
  await startService(service);
  return { ok: true, message: `${service.name} restarted (PID ${service.proc?.pid})` };
}

export async function checkHealth(service: ManagedService): Promise<boolean> {
  try {
    const res = await fetch(service.healthUrl, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}

// ── Health Monitor Loop ─────────────────────────────────

export async function monitorServices(): Promise<void> {
  for (const [_id, service] of Object.entries(services)) {
    const processAlive = isProcessAlive(service);
    const healthy = processAlive ? await checkHealth(service) : false;

    // Record snapshot
    service.history.push({ timestamp: Date.now(), processAlive, healthy });
    if (service.history.length > HEALTH_HISTORY_SIZE) {
      service.history = service.history.slice(-HEALTH_HISTORY_SIZE);
    }

    if (!processAlive) {
      // Process died — restart with backoff
      service.consecutiveFailures++;
      const timeSinceRestart = Date.now() - service.lastRestart;
      if (timeSinceRestart < service.restartBackoff) continue;

      log("WARN", `${service.name} process dead — restarting...`);
      await startService(service);
      service.restartBackoff = Math.min(service.restartBackoff * 2, 30000);
    } else if (!healthy) {
      // Process alive but health check failing
      service.consecutiveFailures++;
      if (service.consecutiveFailures >= UNHEALTHY_RESTART_THRESHOLD) {
        const timeSinceRestart = Date.now() - service.lastRestart;
        if (timeSinceRestart < service.restartBackoff) continue;

        log(
          "WARN",
          `${service.name} unhealthy for ${service.consecutiveFailures} checks — restarting...`,
        );
        await startService(service);
        service.restartBackoff = Math.min(service.restartBackoff * 2, 30000);
      }
    } else {
      // Healthy — reset counters
      service.consecutiveFailures = 0;
      if (Date.now() - service.lastRestart > 60000) {
        service.restartBackoff = 1000;
      }
    }
  }
}

// ── Graceful Shutdown ───────────────────────────────────

export function stopAllServices(): void {
  for (const [, service] of Object.entries(services)) {
    if (service.proc && service.proc.exitCode === null) {
      log("INFO", `Stopping ${service.name} (PID ${service.proc.pid})...`);
      service.proc.kill("SIGTERM");
    }
  }
}
