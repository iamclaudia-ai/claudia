/**
 * Claudia Watchdog
 *
 * Standalone process supervisor + dashboard that manages gateway and runtime
 * as direct child processes. Provides health monitoring, log viewing, and
 * restart capabilities independent of the gateway.
 *
 * ZERO monorepo imports — this file is completely self-contained so it keeps running
 * even when the gateway or shared packages have build errors.
 *
 * Usage:
 *   bun run watchdog                           # Start watchdog (from root)
 *   open http://localhost:30085                # Dashboard with log viewer
 *   curl localhost:30085/status                # JSON status
 *   curl localhost:30085/api/logs              # List log files
 *   curl localhost:30085/api/logs/gateway.log?lines=50  # Tail logs
 *   curl -X POST localhost:30085/restart/gateway        # Restart gateway
 *   curl -X POST localhost:30085/restart/runtime        # Restart runtime
 */

import { WATCHDOG_PORT, STARTED_AT, HEALTH_CHECK_INTERVAL } from "./constants";
import { log } from "./logger";
import {
  services,
  isProcessAlive,
  startService,
  restartService,
  monitorServices,
  stopAllServices,
} from "./services";
import { checkClientHealth } from "./client-health";
import { startDiagnose, clearDiagnose, getDiagnoseStatus } from "./diagnose";
import { listLogFiles, tailLogFile } from "./logs";
import { getStatus } from "./status";
import dashboard from "./dashboard/index.html";

// ── HTTP Server ──────────────────────────────────────────

const server = Bun.serve({
  port: WATCHDOG_PORT,
  routes: {
    // JSON status
    "/status": async () => Response.json(await getStatus()),

    // Server info for client-side uptime/port
    "/api/info": () => Response.json({ startedAt: STARTED_AT, port: WATCHDOG_PORT }),

    // List log files
    "/api/logs": () => Response.json({ files: listLogFiles() }),

    // Tail a log file: /api/logs/:filename
    "/api/logs/*": (req) => {
      const url = new URL(req.url);
      const fileName = decodeURIComponent(url.pathname.slice("/api/logs/".length));
      const maxLines = parseInt(url.searchParams.get("lines") || "200", 10);
      const byteOffset = parseInt(url.searchParams.get("offset") || "0", 10);

      try {
        const result = tailLogFile(fileName, Math.min(maxLines, 1000), Math.max(byteOffset, 0));
        return Response.json(result);
      } catch (err) {
        return Response.json(
          { error: err instanceof Error ? err.message : "Unknown error" },
          { status: 400 },
        );
      }
    },

    // Restart service: POST /restart/:id
    "/restart/*": async (req) => {
      if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
      const url = new URL(req.url);
      const serviceId = url.pathname.split("/restart/")[1];
      const result = await restartService(serviceId);
      return Response.json(result, { status: result.ok ? 200 : 400 });
    },

    // Diagnose — GET status or POST to start
    "/diagnose": async (req) => {
      if (req.method === "POST") {
        const result = await startDiagnose();
        return Response.json(result, { status: result.ok ? 200 : 400 });
      }
      return Response.json(getDiagnoseStatus());
    },

    // Diagnose — continue with follow-up prompt
    "/diagnose/continue": async (req) => {
      if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
      let prompt = "Continue fixing the error. Check if it's resolved now.";
      try {
        const body = (await req.json()) as { prompt?: string };
        if (body.prompt) prompt = body.prompt;
      } catch {}
      const result = await startDiagnose(prompt);
      return Response.json(result, { status: result.ok ? 200 : 400 });
    },

    // Diagnose — clear UI state
    "/diagnose/clear": (req) => {
      if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
      const result = clearDiagnose();
      return Response.json(result, { status: result.ok ? 200 : 400 });
    },

    // Dashboard — SPA fallback
    "/*": dashboard,
  },
});

// ── Health Monitor ───────────────────────────────────────

setInterval(monitorServices, HEALTH_CHECK_INTERVAL);
setInterval(checkClientHealth, HEALTH_CHECK_INTERVAL);

// ── Startup ──────────────────────────────────────────────

log("INFO", `Watchdog starting on http://localhost:${WATCHDOG_PORT}`);

console.log(`
╔═══════════════════════════════════════════════════════════════╗
║                                                               ║
║   Claudia Watchdog on http://localhost:${WATCHDOG_PORT}                ║
║                                                               ║
║   Dashboard:  http://localhost:${WATCHDOG_PORT}                        ║
║   Status:     http://localhost:${WATCHDOG_PORT}/status                 ║
║   Logs:       http://localhost:${WATCHDOG_PORT}/api/logs               ║
║   Restart:    curl -X POST localhost:${WATCHDOG_PORT}/restart/gateway  ║
║                                                               ║
╚═══════════════════════════════════════════════════════════════╝
`);

// Start services — spawn as direct child processes
for (const [_id, service] of Object.entries(services)) {
  await startService(service);
}

// Graceful shutdown — kill child processes
process.on("SIGINT", () => {
  log("INFO", "Shutting down — stopping all services...");
  stopAllServices();
  server.stop();
  process.exit(0);
});

process.on("SIGTERM", () => {
  log("INFO", "Received SIGTERM — stopping all services...");
  stopAllServices();
  server.stop();
  process.exit(0);
});
