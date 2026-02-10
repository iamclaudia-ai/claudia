/**
 * Claudia Watchdog
 *
 * Lightweight process supervisor that manages gateway and runtime via tmux.
 * Exposes an HTTP endpoint so Claudia can restart services without killing herself.
 *
 * Usage:
 *   bun run watchdog          # Start everything
 *   curl localhost:30085/status          # Check status
 *   curl -X POST localhost:30085/restart/runtime   # Restart runtime
 *   curl -X POST localhost:30085/restart/gateway   # Restart gateway
 *
 * Tmux sessions:
 *   claudia-gateway  — gateway logs
 *   claudia-runtime  — runtime logs
 */

const WATCHDOG_PORT = 30085;
const PROJECT_DIR = import.meta.dir.replace("/scripts", "");

interface ManagedService {
  name: string;
  tmuxSession: string;
  command: string;
  healthUrl: string;
  restartBackoff: number;
  lastRestart: number;
}

const services: Record<string, ManagedService> = {
  gateway: {
    name: "Gateway",
    tmuxSession: "claudia-gateway",
    command: "bun run --watch packages/gateway/src/start.ts",
    healthUrl: "http://localhost:30086/health",
    restartBackoff: 1000,
    lastRestart: 0,
  },
  runtime: {
    name: "Runtime",
    tmuxSession: "claudia-runtime",
    command: "bun run --watch packages/runtime/src/index.ts",
    healthUrl: "http://localhost:30087/health",
    restartBackoff: 1000,
    lastRestart: 0,
  },
};

// ── Tmux Helpers ──────────────────────────────────────────

async function tmuxSessionExists(session: string): Promise<boolean> {
  const proc = Bun.spawn(["tmux", "has-session", "-t", session], {
    stdout: "ignore",
    stderr: "ignore",
  });
  const code = await proc.exited;
  return code === 0;
}

async function startService(service: ManagedService): Promise<void> {
  const exists = await tmuxSessionExists(service.tmuxSession);

  if (exists) {
    // Kill existing session first
    const kill = Bun.spawn(["tmux", "kill-session", "-t", service.tmuxSession], {
      stdout: "ignore",
      stderr: "ignore",
    });
    await kill.exited;
    // Brief pause to let port release
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
  console.log(`[Watchdog] Started ${service.name} in tmux session: ${service.tmuxSession}`);
}

async function restartService(id: string): Promise<{ ok: boolean; message: string }> {
  const service = services[id];
  if (!service) {
    return { ok: false, message: `Unknown service: ${id}` };
  }

  console.log(`[Watchdog] Restarting ${service.name}...`);
  await startService(service);
  return { ok: true, message: `${service.name} restarted` };
}

async function checkHealth(service: ManagedService): Promise<boolean> {
  try {
    const res = await fetch(service.healthUrl, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}

async function getStatus(): Promise<Record<string, unknown>> {
  const status: Record<string, unknown> = {};
  for (const [id, service] of Object.entries(services)) {
    const tmuxAlive = await tmuxSessionExists(service.tmuxSession);
    const healthy = tmuxAlive ? await checkHealth(service) : false;
    status[id] = {
      tmuxSession: service.tmuxSession,
      tmuxAlive,
      healthy,
      lastRestart: service.lastRestart ? new Date(service.lastRestart).toISOString() : null,
    };
  }
  return status;
}

// ── Health Monitor ────────────────────────────────────────

async function monitorServices(): Promise<void> {
  for (const [id, service] of Object.entries(services)) {
    const exists = await tmuxSessionExists(service.tmuxSession);
    if (!exists) {
      const timeSinceRestart = Date.now() - service.lastRestart;
      if (timeSinceRestart < service.restartBackoff) continue;

      console.log(`[Watchdog] ${service.name} tmux session gone — restarting...`);
      await startService(service);

      // Exponential backoff (max 30s), reset after 60s uptime
      service.restartBackoff = Math.min(service.restartBackoff * 2, 30000);
    } else {
      // Reset backoff after stable uptime
      if (Date.now() - service.lastRestart > 60000) {
        service.restartBackoff = 1000;
      }
    }
  }
}

// Check every 5 seconds
setInterval(monitorServices, 5000);

// ── HTTP Server ───────────────────────────────────────────

const server = Bun.serve({
  port: WATCHDOG_PORT,
  async fetch(req) {
    const url = new URL(req.url);

    if (url.pathname === "/status") {
      const status = await getStatus();
      return new Response(JSON.stringify(status, null, 2), {
        headers: { "Content-Type": "application/json" },
      });
    }

    if (req.method === "POST" && url.pathname.startsWith("/restart/")) {
      const serviceId = url.pathname.split("/restart/")[1];
      const result = await restartService(serviceId);
      return new Response(JSON.stringify(result), {
        status: result.ok ? 200 : 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    return new Response("Claudia Watchdog\n\nGET /status\nPOST /restart/gateway\nPOST /restart/runtime\n", {
      status: 200,
    });
  },
});

// ── Startup ───────────────────────────────────────────────

console.log(`
╔═══════════════════════════════════════════════════════════╗
║                                                           ║
║   🐕 Claudia Watchdog on http://localhost:${WATCHDOG_PORT}          ║
║                                                           ║
║   Status:   http://localhost:${WATCHDOG_PORT}/status                ║
║   Restart:  curl -X POST localhost:${WATCHDOG_PORT}/restart/runtime ║
║                                                           ║
╚═══════════════════════════════════════════════════════════╝
`);

// Start services that aren't already running
for (const [id, service] of Object.entries(services)) {
  const exists = await tmuxSessionExists(service.tmuxSession);
  if (!exists) {
    await startService(service);
  } else {
    console.log(`[Watchdog] ${service.name} already running in tmux: ${service.tmuxSession}`);
    service.lastRestart = Date.now();
  }
}

// Graceful shutdown — do NOT kill tmux sessions (they should survive watchdog restarts)
process.on("SIGINT", () => {
  console.log("\n[Watchdog] Shutting down (tmux sessions left running)...");
  server.stop();
  process.exit(0);
});
