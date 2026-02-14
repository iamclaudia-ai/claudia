/**
 * Service management — tmux helpers, health checks, auto-restart.
 */

import { PROJECT_DIR, HEALTH_HISTORY_SIZE, UNHEALTHY_RESTART_THRESHOLD } from "./constants";
import { log } from "./logger";

// ── Types ────────────────────────────────────────────────

export interface HealthSnapshot {
  timestamp: number;
  tmuxAlive: boolean;
  healthy: boolean;
}

export interface ManagedService {
  name: string;
  tmuxSession: string;
  command: string;
  healthUrl: string;
  restartBackoff: number;
  lastRestart: number;
  consecutiveFailures: number;
  history: HealthSnapshot[];
}

// ── Service Definitions ─────────────────────────────────

export const services: Record<string, ManagedService> = {
  gateway: {
    name: "Gateway",
    tmuxSession: "claudia-gateway",
    command: "bun run --watch packages/gateway/src/start.ts",
    healthUrl: "http://localhost:30086/health",
    restartBackoff: 1000,
    lastRestart: 0,
    consecutiveFailures: 0,
    history: [],
  },
  runtime: {
    name: "Runtime",
    tmuxSession: "claudia-runtime",
    command: "bun run --watch packages/runtime/src/index.ts",
    healthUrl: "http://localhost:30087/health",
    restartBackoff: 1000,
    lastRestart: 0,
    consecutiveFailures: 0,
    history: [],
  },
};

// ── Tmux Helpers ─────────────────────────────────────────

export async function tmuxSessionExists(session: string): Promise<boolean> {
  const proc = Bun.spawn(["tmux", "has-session", "-t", session], {
    stdout: "ignore",
    stderr: "ignore",
  });
  const code = await proc.exited;
  return code === 0;
}

export async function startService(service: ManagedService): Promise<void> {
  const exists = await tmuxSessionExists(service.tmuxSession);

  if (exists) {
    const kill = Bun.spawn(["tmux", "kill-session", "-t", service.tmuxSession], {
      stdout: "ignore",
      stderr: "ignore",
    });
    await kill.exited;
    await new Promise((r) => setTimeout(r, 500));
  }

  const proc = Bun.spawn(
    ["tmux", "new-session", "-d", "-s", service.tmuxSession, service.command],
    {
      cwd: PROJECT_DIR,
      stdout: "ignore",
      stderr: "inherit",
    },
  );
  await proc.exited;

  service.lastRestart = Date.now();
  service.consecutiveFailures = 0;
  log("INFO", `Started ${service.name} in tmux session: ${service.tmuxSession}`);
}

export async function restartService(id: string): Promise<{ ok: boolean; message: string }> {
  const service = services[id];
  if (!service) {
    return { ok: false, message: `Unknown service: ${id}` };
  }

  log("INFO", `Restarting ${service.name}...`);
  await startService(service);
  return { ok: true, message: `${service.name} restarted` };
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
    const tmuxAlive = await tmuxSessionExists(service.tmuxSession);
    const healthy = tmuxAlive ? await checkHealth(service) : false;

    // Record snapshot
    service.history.push({ timestamp: Date.now(), tmuxAlive, healthy });
    if (service.history.length > HEALTH_HISTORY_SIZE) {
      service.history = service.history.slice(-HEALTH_HISTORY_SIZE);
    }

    if (!tmuxAlive) {
      // Tmux session gone — restart with backoff
      service.consecutiveFailures++;
      const timeSinceRestart = Date.now() - service.lastRestart;
      if (timeSinceRestart < service.restartBackoff) continue;

      log("WARN", `${service.name} tmux session gone — restarting...`);
      await startService(service);
      service.restartBackoff = Math.min(service.restartBackoff * 2, 30000);
    } else if (!healthy) {
      // Tmux alive but health check failing
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
