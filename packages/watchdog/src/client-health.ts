/**
 * Client health tracking — monitors the web UI via the gateway's /health endpoint.
 */

import { log } from "./logger";

// ── Types ────────────────────────────────────────────────

export interface ClientHealthStatus {
  healthy: boolean;
  lastHeartbeat: string | null;
  heartbeatAge: number | null;
  recentErrors: number;
  errors: { type: string; message: string; timestamp: string }[];
}

// ── State ────────────────────────────────────────────────

export let lastClientHealth: ClientHealthStatus | null = null;
let clientErrorAlerted = false;

// ── Health Check ─────────────────────────────────────────

export async function checkClientHealth(): Promise<void> {
  try {
    const res = await fetch("http://localhost:30086/health", { signal: AbortSignal.timeout(2000) });
    if (!res.ok) return;

    const data = (await res.json()) as { client?: ClientHealthStatus };
    if (!data.client) return;

    const prev = lastClientHealth;
    lastClientHealth = data.client;

    // Log client errors when they appear
    if (data.client.recentErrors > 0 && !clientErrorAlerted) {
      clientErrorAlerted = true;
      const latestError = data.client.errors[data.client.errors.length - 1];
      log(
        "ERROR",
        `Client-side error detected: [${latestError?.type}] ${latestError?.message?.slice(0, 200)} (${data.client.recentErrors} recent errors)`,
      );
    } else if (data.client.recentErrors === 0 && clientErrorAlerted) {
      clientErrorAlerted = false;
      log("INFO", "Client errors cleared — app healthy again");
    }

    // Warn if heartbeat is stale (client hasn't reported healthy in 2+ minutes)
    if (
      data.client.heartbeatAge !== null &&
      data.client.heartbeatAge > 120_000 &&
      (prev === null || (prev.heartbeatAge !== null && prev.heartbeatAge <= 120_000))
    ) {
      log("WARN", `Client heartbeat stale (${Math.round(data.client.heartbeatAge / 1000)}s ago)`);
    }
  } catch {
    // Gateway unreachable — already handled by service health checks
  }
}
