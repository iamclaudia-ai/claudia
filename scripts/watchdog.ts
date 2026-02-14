/**
 * Claudia Watchdog
 *
 * Standalone process supervisor + dashboard that manages gateway and runtime via tmux.
 * Provides health monitoring, log viewing, and restart capabilities independent of the gateway.
 *
 * ZERO monorepo imports — this file is completely self-contained so it keeps running
 * even when the gateway or shared packages have build errors.
 *
 * Usage:
 *   bun run scripts/watchdog.ts              # Start watchdog
 *   open http://localhost:30085              # Dashboard with log viewer
 *   curl localhost:30085/status              # JSON status
 *   curl localhost:30085/api/logs            # List log files
 *   curl localhost:30085/api/logs/gateway.log?lines=50  # Tail logs
 *   curl -X POST localhost:30085/restart/gateway        # Restart gateway
 *   curl -X POST localhost:30085/restart/runtime        # Restart runtime
 *
 * Tmux sessions:
 *   claudia-gateway  — gateway process
 *   claudia-runtime  — runtime process
 */

import {
  existsSync,
  mkdirSync,
  appendFileSync,
  statSync,
  renameSync,
  readdirSync,
  readFileSync,
} from "node:fs";
import { join, basename } from "node:path";
import { homedir } from "node:os";

// ── Constants ────────────────────────────────────────────

const WATCHDOG_PORT = 30085;
const PROJECT_DIR = import.meta.dir.replace("/scripts", "");
const LOGS_DIR = join(homedir(), ".claudia", "logs");
const LOG_FILE = join(LOGS_DIR, "watchdog.log");
const MAX_LOG_SIZE = 10 * 1024 * 1024; // 10MB
const MAX_LOG_FILES = 2;
const HEALTH_CHECK_INTERVAL = 5000; // 5s
const HEALTH_HISTORY_SIZE = 60; // 5-minute window at 5s intervals
const UNHEALTHY_RESTART_THRESHOLD = 6; // 6 consecutive failures = 30s
const STARTED_AT = Date.now();

// ── Inline Logger (no imports from @claudia/shared) ──────

function rotateIfNeeded(filePath: string): void {
  try {
    if (!existsSync(filePath)) return;
    const { size } = statSync(filePath);
    if (size < MAX_LOG_SIZE) return;

    for (let i = MAX_LOG_FILES; i >= 1; i--) {
      const from = i === 1 ? filePath : `${filePath}.${i - 1}`;
      const to = `${filePath}.${i}`;
      if (existsSync(from)) {
        if (i === MAX_LOG_FILES) {
          Bun.write(to, ""); // truncate oldest
        }
        renameSync(from, to);
      }
    }
  } catch {
    // Rotation failure shouldn't break the watchdog
  }
}

function log(level: "INFO" | "WARN" | "ERROR", msg: string): void {
  const tag = "[Watchdog]";
  if (level === "ERROR") console.error(`${tag} ${msg}`);
  else if (level === "WARN") console.warn(`${tag} ${msg}`);
  else console.log(`${tag} ${msg}`);

  try {
    if (!existsSync(LOGS_DIR)) mkdirSync(LOGS_DIR, { recursive: true });
    rotateIfNeeded(LOG_FILE);
    const ts = new Date().toISOString();
    appendFileSync(LOG_FILE, `[${ts}] [${level}] [Watchdog] ${msg}\n`);
  } catch {
    // Never let file logging break the watchdog
  }
}

// ── Types ────────────────────────────────────────────────

interface HealthSnapshot {
  timestamp: number;
  tmuxAlive: boolean;
  healthy: boolean;
}

interface ManagedService {
  name: string;
  tmuxSession: string;
  command: string;
  healthUrl: string;
  restartBackoff: number;
  lastRestart: number;
  consecutiveFailures: number;
  history: HealthSnapshot[];
}

// ── Services ─────────────────────────────────────────────

const services: Record<string, ManagedService> = {
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

async function restartService(id: string): Promise<{ ok: boolean; message: string }> {
  const service = services[id];
  if (!service) {
    return { ok: false, message: `Unknown service: ${id}` };
  }

  log("INFO", `Restarting ${service.name}...`);
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

// ── Client Health Tracking ──────────────────────────────────

interface ClientHealthStatus {
  healthy: boolean;
  lastHeartbeat: string | null;
  heartbeatAge: number | null;
  recentErrors: number;
  errors: { type: string; message: string; timestamp: string }[];
}

let lastClientHealth: ClientHealthStatus | null = null;
let clientErrorAlerted = false;

async function checkClientHealth(): Promise<void> {
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

// ── Status ───────────────────────────────────────────────

async function getStatus(): Promise<Record<string, unknown>> {
  const status: Record<string, unknown> = {};
  for (const [id, service] of Object.entries(services)) {
    const tmuxAlive = await tmuxSessionExists(service.tmuxSession);
    const healthy = tmuxAlive ? await checkHealth(service) : false;
    status[id] = {
      name: service.name,
      tmuxSession: service.tmuxSession,
      tmuxAlive,
      healthy,
      consecutiveFailures: service.consecutiveFailures,
      lastRestart: service.lastRestart ? new Date(service.lastRestart).toISOString() : null,
      history: service.history.slice(-HEALTH_HISTORY_SIZE),
    };
  }
  // Include client health in status
  if (lastClientHealth) {
    status.client = {
      name: "Web Client",
      healthy: lastClientHealth.healthy,
      recentErrors: lastClientHealth.recentErrors,
      lastHeartbeat: lastClientHealth.lastHeartbeat,
      heartbeatAge: lastClientHealth.heartbeatAge,
      errors: lastClientHealth.errors,
    };
  }
  return status;
}

// ── Health Monitor ───────────────────────────────────────

async function monitorServices(): Promise<void> {
  for (const [id, service] of Object.entries(services)) {
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

setInterval(monitorServices, HEALTH_CHECK_INTERVAL);
setInterval(checkClientHealth, HEALTH_CHECK_INTERVAL);

// ── Log File API ─────────────────────────────────────────

function listLogFiles(): { name: string; size: number; modified: string }[] {
  try {
    if (!existsSync(LOGS_DIR)) return [];
    return readdirSync(LOGS_DIR)
      .filter((f) => f.endsWith(".log"))
      .map((f) => {
        const stat = statSync(join(LOGS_DIR, f));
        return { name: f, size: stat.size, modified: stat.mtime.toISOString() };
      })
      .sort((a, b) => b.modified.localeCompare(a.modified));
  } catch {
    return [];
  }
}

function tailLogFile(
  fileName: string,
  maxLines: number,
  byteOffset: number,
): { lines: string[]; offset: number; fileSize: number } {
  const sanitized = basename(fileName);
  if (!sanitized.endsWith(".log")) {
    throw new Error("Invalid log file name");
  }

  const filePath = join(LOGS_DIR, sanitized);
  const stat = statSync(filePath);
  const fileSize = stat.size;

  if (byteOffset >= fileSize) {
    return { lines: [], offset: fileSize, fileSize };
  }

  const content = readFileSync(filePath, "utf-8");
  const newContent = byteOffset > 0 ? content.slice(byteOffset) : content;
  const allLines = newContent.split("\n").filter((l) => l.length > 0);
  const resultLines = byteOffset > 0 ? allLines : allLines.slice(-maxLines);

  return { lines: resultLines, offset: fileSize, fileSize };
}

// ── Web Dashboard HTML ───────────────────────────────────

function buildDashboardHtml(statusData: Record<string, unknown>): string {
  const uptime = Math.floor((Date.now() - STARTED_AT) / 1000);
  const uptimeStr =
    uptime < 60
      ? `${uptime}s`
      : uptime < 3600
        ? `${Math.floor(uptime / 60)}m ${uptime % 60}s`
        : `${Math.floor(uptime / 3600)}h ${Math.floor((uptime % 3600) / 60)}m`;

  const serviceCards = Object.entries(statusData)
    .filter(([id]) => id !== "client")
    .map(([id, data]) => {
      const s = data as {
        name: string;
        tmuxAlive: boolean;
        healthy: boolean;
        consecutiveFailures: number;
        lastRestart: string | null;
        history: HealthSnapshot[];
      };

      const statusColor = s.healthy ? "#22c55e" : s.tmuxAlive ? "#eab308" : "#ef4444";
      const statusText = s.healthy ? "Healthy" : s.tmuxAlive ? "Unhealthy" : "Down";

      // Build sparkline from history
      const sparkline = s.history
        .slice(-30)
        .map((h) => {
          const color = h.healthy ? "#22c55e" : h.tmuxAlive ? "#eab308" : "#ef4444";
          return `<span style="display:inline-block;width:4px;height:12px;background:${color};margin-right:1px;border-radius:1px;"></span>`;
        })
        .join("");

      const lastRestart = s.lastRestart ? new Date(s.lastRestart).toLocaleTimeString() : "never";

      return `
        <div class="card">
          <div class="card-header">
            <span class="status-dot" style="background:${statusColor}"></span>
            <span class="card-title">${s.name}</span>
            <span class="status-text" style="color:${statusColor}">${statusText}</span>
          </div>
          <div class="card-body">
            <div class="metric"><span class="label">tmux</span><span>${s.tmuxAlive ? "running" : "stopped"}</span></div>
            <div class="metric"><span class="label">failures</span><span>${s.consecutiveFailures}</span></div>
            <div class="metric"><span class="label">last restart</span><span>${lastRestart}</span></div>
            <div class="sparkline">${sparkline}</div>
          </div>
          <div class="card-actions">
            <button onclick="restartService('${id}')" class="btn-restart">Restart</button>
          </div>
        </div>`;
    })
    .join("\n");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Claudia Watchdog</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { background: #18181b; color: #e4e4e7; font-family: -apple-system, system-ui, sans-serif; }
    .header { border-bottom: 1px solid #27272a; padding: 16px 24px; display: flex; justify-content: space-between; align-items: center; }
    .header h1 { font-size: 18px; font-weight: 600; }
    .header .uptime { color: #71717a; font-size: 13px; }
    .services { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 16px; padding: 24px; }
    .card { background: #27272a; border-radius: 8px; border: 1px solid #3f3f46; overflow: hidden; }
    .card-header { padding: 12px 16px; display: flex; align-items: center; gap: 8px; border-bottom: 1px solid #3f3f46; }
    .status-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
    .card-title { font-weight: 600; font-size: 14px; flex: 1; }
    .status-text { font-size: 12px; font-weight: 500; }
    .card-body { padding: 12px 16px; }
    .metric { display: flex; justify-content: space-between; font-size: 13px; padding: 3px 0; }
    .metric .label { color: #71717a; }
    .sparkline { margin-top: 8px; display: flex; align-items: flex-end; height: 16px; }
    .card-actions { padding: 8px 16px; border-top: 1px solid #3f3f46; }
    .btn-restart { background: #3f3f46; color: #e4e4e7; border: none; padding: 6px 14px; border-radius: 6px; cursor: pointer; font-size: 12px; }
    .btn-restart:hover { background: #52525b; }

    .log-section { padding: 0 24px 24px; }
    .log-header { display: flex; align-items: center; gap: 12px; margin-bottom: 12px; flex-wrap: wrap; }
    .log-header h2 { font-size: 15px; font-weight: 600; }
    select, .btn-filter { background: #27272a; color: #e4e4e7; border: 1px solid #3f3f46; padding: 5px 10px; border-radius: 6px; font-size: 12px; cursor: pointer; }
    select:focus { outline: none; border-color: #52525b; }
    .btn-filter { border: none; }
    .btn-filter.active { background: #3f3f46; color: #fff; }
    .btn-filter.error.active { background: #7f1d1d; color: #fca5a5; }
    .btn-filter.warn.active { background: #713f12; color: #fde047; }
    .btn-pause { background: #27272a; color: #71717a; border: 1px solid #3f3f46; padding: 5px 12px; border-radius: 6px; font-size: 12px; cursor: pointer; }
    .btn-pause.paused { background: #064e3b; color: #6ee7b7; border-color: #065f46; }

    .log-output { background: #09090b; border: 1px solid #27272a; border-radius: 8px; height: 500px; overflow-y: auto; padding: 12px; font-family: "SF Mono", "Fira Code", monospace; font-size: 12px; line-height: 1.6; }
    .log-line { white-space: pre-wrap; word-break: break-all; }
    .log-line .ts { color: #52525b; }
    .log-line.error { color: #f87171; }
    .log-line.warn { color: #facc15; }
    .log-line.info { color: #a1a1aa; }

    .log-footer { display: flex; justify-content: space-between; margin-top: 8px; font-size: 11px; color: #52525b; }
  </style>
</head>
<body>
  <div class="header">
    <h1>Claudia Watchdog</h1>
    <span class="uptime" id="uptime">uptime ${uptimeStr} &middot; port ${WATCHDOG_PORT}</span>
  </div>

  <div class="services" id="serviceCards">
    ${serviceCards}
  </div>

  <div class="log-section">
    <div class="log-header">
      <h2>Logs</h2>
      <select id="logFile" onchange="switchLogFile()"></select>
      <button class="btn-filter active" data-level="ALL" onclick="setFilter('ALL', this)">ALL</button>
      <button class="btn-filter" data-level="INFO" onclick="setFilter('INFO', this)">INFO</button>
      <button class="btn-filter warn" data-level="WARN" onclick="setFilter('WARN', this)">WARN</button>
      <button class="btn-filter error" data-level="ERROR" onclick="setFilter('ERROR', this)">ERROR</button>
      <button class="btn-pause" id="pauseBtn" onclick="togglePause()">Pause</button>
    </div>
    <div class="log-output" id="logOutput"></div>
    <div class="log-footer">
      <span id="lineCount">0 lines</span>
      <span id="offsetInfo"></span>
    </div>
  </div>

  <script>
    let currentFile = '';
    let offset = 0;
    let lines = [];
    let filter = 'ALL';
    let paused = false;
    let autoScroll = true;
    const MAX_LINES = 2000;

    async function loadLogFiles() {
      try {
        const res = await fetch('/api/logs');
        const data = await res.json();
        const select = document.getElementById('logFile');
        select.innerHTML = data.files.map(f =>
          '<option value="' + f.name + '"' + (f.name === currentFile ? ' selected' : '') + '>' +
          f.name + ' (' + formatSize(f.size) + ')' + '</option>'
        ).join('');
        if (!currentFile && data.files.length > 0) {
          const preferred = data.files.find(f => f.name === 'gateway.log') || data.files[0];
          currentFile = preferred.name;
          select.value = currentFile;
        }
      } catch {}
    }

    function formatSize(bytes) {
      if (bytes < 1024) return bytes + 'B';
      if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + 'KB';
      return (bytes / 1024 / 1024).toFixed(1) + 'MB';
    }

    function switchLogFile() {
      currentFile = document.getElementById('logFile').value;
      lines = [];
      offset = 0;
      renderLines();
      tailLog();
    }

    function setFilter(level, btn) {
      filter = level;
      document.querySelectorAll('.btn-filter').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      renderLines();
    }

    function togglePause() {
      paused = !paused;
      const btn = document.getElementById('pauseBtn');
      btn.textContent = paused ? 'Resume' : 'Pause';
      btn.classList.toggle('paused', paused);
    }

    async function tailLog() {
      if (!currentFile || paused) return;
      try {
        const res = await fetch('/api/logs/' + encodeURIComponent(currentFile) + '?lines=200&offset=' + offset);
        const data = await res.json();
        if (data.lines && data.lines.length > 0) {
          lines = lines.concat(data.lines);
          if (lines.length > MAX_LINES) lines = lines.slice(-MAX_LINES);
          renderLines();
        }
        offset = data.offset;
        document.getElementById('offsetInfo').textContent = 'offset: ' + offset.toLocaleString() + ' bytes';
      } catch {}
    }

    function renderLines() {
      const output = document.getElementById('logOutput');
      const filtered = filter === 'ALL' ? lines : lines.filter(l => l.includes('[' + filter + ']'));
      output.innerHTML = filtered.map(line => {
        let cls = 'log-line info';
        if (line.includes('[ERROR]')) cls = 'log-line error';
        else if (line.includes('[WARN]')) cls = 'log-line warn';

        const tsMatch = line.match(/^\\[(\\d{4}-\\d{2}-\\d{2}T[\\d:.]+Z?)\\]/);
        if (tsMatch) {
          return '<div class="' + cls + '"><span class="ts">[' + tsMatch[1] + ']</span>' + escapeHtml(line.slice(tsMatch[0].length)) + '</div>';
        }
        return '<div class="' + cls + '">' + escapeHtml(line) + '</div>';
      }).join('');

      document.getElementById('lineCount').textContent = filtered.length + ' lines' +
        (filter !== 'ALL' ? ' (filtered from ' + lines.length + ')' : '');

      if (autoScroll) output.scrollTop = output.scrollHeight;
    }

    function escapeHtml(str) {
      return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    // Detect manual scroll
    document.getElementById('logOutput').addEventListener('scroll', function() {
      const el = this;
      const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 50;
      autoScroll = atBottom;
    });

    async function restartService(id) {
      if (!confirm('Restart ' + id + '?')) return;
      try {
        const res = await fetch('/restart/' + id, { method: 'POST' });
        const data = await res.json();
        alert(data.message);
      } catch (e) {
        alert('Restart failed: ' + e.message);
      }
    }

    // Poll service status and update cards
    async function refreshStatus() {
      try {
        const res = await fetch('/status');
        const data = await res.json();
        const container = document.getElementById('serviceCards');
        if (!container) return;

        let html = '';

        // Render service cards (gateway, runtime)
        for (const [id, s] of Object.entries(data)) {
          if (id === 'client') continue; // handled separately
          const statusColor = s.healthy ? '#22c55e' : s.tmuxAlive ? '#eab308' : '#ef4444';
          const statusText = s.healthy ? 'Healthy' : s.tmuxAlive ? 'Unhealthy' : 'Down';
          const sparkline = (s.history || []).slice(-30).map(h => {
            const c = h.healthy ? '#22c55e' : h.tmuxAlive ? '#eab308' : '#ef4444';
            return '<span style="display:inline-block;width:4px;height:12px;background:' + c + ';margin-right:1px;border-radius:1px;"></span>';
          }).join('');
          const lastRestart = s.lastRestart ? new Date(s.lastRestart).toLocaleTimeString() : 'never';
          html += '<div class="card">' +
            '<div class="card-header">' +
              '<span class="status-dot" style="background:' + statusColor + '"></span>' +
              '<span class="card-title">' + s.name + '</span>' +
              '<span class="status-text" style="color:' + statusColor + '">' + statusText + '</span>' +
            '</div>' +
            '<div class="card-body">' +
              '<div class="metric"><span class="label">tmux</span><span>' + (s.tmuxAlive ? 'running' : 'stopped') + '</span></div>' +
              '<div class="metric"><span class="label">failures</span><span>' + s.consecutiveFailures + '</span></div>' +
              '<div class="metric"><span class="label">last restart</span><span>' + lastRestart + '</span></div>' +
              '<div class="sparkline">' + sparkline + '</div>' +
            '</div>' +
            '<div class="card-actions">' +
              '<button onclick="restartService(\\'' + id + '\\')" class="btn-restart">Restart</button>' +
            '</div></div>';
        }

        // Render client health card
        if (data.client) {
          const c = data.client;
          const clientColor = c.healthy ? '#22c55e' : '#ef4444';
          const clientStatus = c.healthy ? 'Healthy' : c.recentErrors > 0 ? c.recentErrors + ' Error' + (c.recentErrors > 1 ? 's' : '') : 'Stale';
          const heartbeatText = c.lastHeartbeat ? new Date(c.lastHeartbeat).toLocaleTimeString() : 'never';
          const heartbeatAge = c.heartbeatAge ? Math.round(c.heartbeatAge / 1000) + 's ago' : 'n/a';
          const errorList = (c.errors || []).slice(-3).map(e =>
            '<div style="font-size:11px;color:#f87171;padding:2px 0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">[' + e.type + '] ' + escapeHtml((e.message || '').slice(0, 80)) + '</div>'
          ).join('');

          html += '<div class="card">' +
            '<div class="card-header">' +
              '<span class="status-dot" style="background:' + clientColor + '"></span>' +
              '<span class="card-title">' + c.name + '</span>' +
              '<span class="status-text" style="color:' + clientColor + '">' + clientStatus + '</span>' +
            '</div>' +
            '<div class="card-body">' +
              '<div class="metric"><span class="label">heartbeat</span><span>' + heartbeatAge + '</span></div>' +
              '<div class="metric"><span class="label">last seen</span><span>' + heartbeatText + '</span></div>' +
              '<div class="metric"><span class="label">errors (5m)</span><span>' + c.recentErrors + '</span></div>' +
              (errorList ? '<div style="margin-top:8px;border-top:1px solid #3f3f46;padding-top:6px;">' + errorList + '</div>' : '') +
            '</div></div>';
        }

        container.innerHTML = html;
      } catch {}
    }

    // Live uptime counter
    let uptimeSec = ${uptime};
    function updateUptime() {
      uptimeSec++;
      const h = Math.floor(uptimeSec / 3600);
      const m = Math.floor((uptimeSec % 3600) / 60);
      const s = uptimeSec % 60;
      const str = h > 0 ? h + 'h ' + m + 'm' : m > 0 ? m + 'm ' + s + 's' : s + 's';
      const el = document.getElementById('uptime');
      if (el) el.textContent = 'uptime ' + str + ' \\u00B7 port ${WATCHDOG_PORT}';
    }
    setInterval(updateUptime, 1000);

    // Initialize
    loadLogFiles();
    tailLog();
    refreshStatus();
    // Poll logs every 2s, status every 5s, file list every 30s
    setInterval(tailLog, 2000);
    setInterval(refreshStatus, 5000);
    setInterval(loadLogFiles, 30000);
  </script>
</body>
</html>`;
}

// ── HTTP Server ──────────────────────────────────────────

const JSON_HEADERS = { "Content-Type": "application/json" };

const server = Bun.serve({
  port: WATCHDOG_PORT,
  async fetch(req) {
    const url = new URL(req.url);

    // Dashboard
    if (url.pathname === "/" && req.method === "GET") {
      const status = await getStatus();
      const html = buildDashboardHtml(status);
      return new Response(html, { headers: { "Content-Type": "text/html" } });
    }

    // JSON status
    if (url.pathname === "/status" && req.method === "GET") {
      const status = await getStatus();
      return new Response(JSON.stringify(status, null, 2), { headers: JSON_HEADERS });
    }

    // List log files
    if (url.pathname === "/api/logs" && req.method === "GET") {
      const files = listLogFiles();
      return new Response(JSON.stringify({ files }), { headers: JSON_HEADERS });
    }

    // Tail a log file
    if (url.pathname.startsWith("/api/logs/") && req.method === "GET") {
      const fileName = decodeURIComponent(url.pathname.slice("/api/logs/".length));
      const lines = parseInt(url.searchParams.get("lines") || "200", 10);
      const offset = parseInt(url.searchParams.get("offset") || "0", 10);

      try {
        const result = tailLogFile(fileName, Math.min(lines, 1000), Math.max(offset, 0));
        return new Response(JSON.stringify(result), { headers: JSON_HEADERS });
      } catch (err) {
        return new Response(
          JSON.stringify({ error: err instanceof Error ? err.message : "Unknown error" }),
          { status: 400, headers: JSON_HEADERS },
        );
      }
    }

    // Restart service
    if (req.method === "POST" && url.pathname.startsWith("/restart/")) {
      const serviceId = url.pathname.split("/restart/")[1];
      const result = await restartService(serviceId);
      return new Response(JSON.stringify(result), {
        status: result.ok ? 200 : 400,
        headers: JSON_HEADERS,
      });
    }

    // Fallback — redirect to dashboard
    return Response.redirect(`http://localhost:${WATCHDOG_PORT}/`, 302);
  },
});

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

// Start services that aren't already running
for (const [id, service] of Object.entries(services)) {
  const exists = await tmuxSessionExists(service.tmuxSession);
  if (!exists) {
    await startService(service);
  } else {
    log("INFO", `${service.name} already running in tmux: ${service.tmuxSession}`);
    service.lastRestart = Date.now();
  }
}

// Graceful shutdown — do NOT kill tmux sessions (they should survive watchdog restarts)
process.on("SIGINT", () => {
  log("INFO", "Shutting down (tmux sessions left running)...");
  server.stop();
  process.exit(0);
});
