/**
 * Watchdog dashboard client — vanilla TypeScript, no React.
 * Fetches status from API and renders everything client-side.
 */

// ── Types ────────────────────────────────────────────────

interface ServiceStatus {
  name: string;
  tmuxSession: string;
  tmuxAlive: boolean;
  healthy: boolean;
  consecutiveFailures: number;
  lastRestart: string | null;
  history: { timestamp: number; tmuxAlive: boolean; healthy: boolean }[];
}

interface ClientStatus {
  name: string;
  healthy: boolean;
  recentErrors: number;
  lastHeartbeat: string | null;
  heartbeatAge: number | null;
  errors: { type: string; message: string; timestamp: string }[];
}

interface DiagnoseData {
  status: "idle" | "running" | "done" | "error";
  sessionId: string | null;
  currentOutput: string;
  history: { role: "user" | "claude"; text: string; timestamp: string }[];
  startedAt: number | null;
  finishedAt: number | null;
  exitCode: number | null;
}

interface ServerInfo {
  startedAt: number;
  port: number;
}

// ── Utilities ────────────────────────────────────────────

function escapeHtml(str: string): string {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return bytes + "B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + "KB";
  return (bytes / 1024 / 1024).toFixed(1) + "MB";
}

function $(id: string): HTMLElement | null {
  return document.getElementById(id);
}

// ── State ────────────────────────────────────────────────

let currentFile = "";
let offset = 0;
let lines: string[] = [];
let filter = "ALL";
let paused = false;
let autoScroll = true;
let diagnosePollTimer: ReturnType<typeof setTimeout> | null = null;
let serverStartedAt = 0;
let serverPort = 0;

const MAX_LINES = 2000;

// ── Init: Fetch server info ──────────────────────────────

async function init(): Promise<void> {
  try {
    const res = await fetch("/api/info");
    const info: ServerInfo = await res.json();
    serverStartedAt = info.startedAt;
    serverPort = info.port;
  } catch {
    // Fallback — we'll get it on next status poll
  }

  // Set up event listeners
  $("logFile")?.addEventListener("change", switchLogFile);
  $("filterAll")?.addEventListener("click", (e) => setFilter("ALL", e.target as HTMLElement));
  $("filterInfo")?.addEventListener("click", (e) => setFilter("INFO", e.target as HTMLElement));
  $("filterWarn")?.addEventListener("click", (e) => setFilter("WARN", e.target as HTMLElement));
  $("filterError")?.addEventListener("click", (e) => setFilter("ERROR", e.target as HTMLElement));
  $("pauseBtn")?.addEventListener("click", togglePause);

  // Detect manual scroll
  $("logOutput")?.addEventListener("scroll", function (this: HTMLElement) {
    const atBottom = this.scrollHeight - this.scrollTop - this.clientHeight < 50;
    autoScroll = atBottom;
  });

  // Start polling
  loadLogFiles();
  tailLog();
  refreshStatus();
  checkDiagnose();

  setInterval(tailLog, 2000);
  setInterval(refreshStatus, 5000);
  setInterval(loadLogFiles, 30000);
  setInterval(updateUptime, 1000);
}

// ── Uptime Counter ───────────────────────────────────────

function updateUptime(): void {
  if (!serverStartedAt) return;
  const uptimeSec = Math.floor((Date.now() - serverStartedAt) / 1000);
  const h = Math.floor(uptimeSec / 3600);
  const m = Math.floor((uptimeSec % 3600) / 60);
  const s = uptimeSec % 60;
  const str = h > 0 ? `${h}h ${m}m` : m > 0 ? `${m}m ${s}s` : `${s}s`;
  const el = $("uptime");
  if (el) el.textContent = `uptime ${str} \u00B7 port ${serverPort}`;
}

// ── Log Viewer ───────────────────────────────────────────

async function loadLogFiles(): Promise<void> {
  try {
    const res = await fetch("/api/logs");
    const data = await res.json();
    const select = $("logFile") as HTMLSelectElement | null;
    if (!select) return;
    select.innerHTML = data.files
      .map(
        (f: { name: string; size: number }) =>
          `<option value="${f.name}"${f.name === currentFile ? " selected" : ""}>${f.name} (${formatSize(f.size)})</option>`,
      )
      .join("");
    if (!currentFile && data.files.length > 0) {
      const preferred =
        data.files.find((f: { name: string }) => f.name === "gateway.log") || data.files[0];
      currentFile = preferred.name;
      select.value = currentFile;
    }
  } catch {
    // Silently retry next cycle
  }
}

function switchLogFile(): void {
  const select = $("logFile") as HTMLSelectElement | null;
  if (!select) return;
  currentFile = select.value;
  lines = [];
  offset = 0;
  renderLines();
  tailLog();
}

function setFilter(level: string, btn: HTMLElement): void {
  filter = level;
  document.querySelectorAll(".btn-filter").forEach((b) => b.classList.remove("active"));
  btn.classList.add("active");
  renderLines();
}

function togglePause(): void {
  paused = !paused;
  const btn = $("pauseBtn");
  if (btn) {
    btn.textContent = paused ? "Resume" : "Pause";
    btn.classList.toggle("paused", paused);
  }
}

async function tailLog(): Promise<void> {
  if (!currentFile || paused) return;
  try {
    const res = await fetch(
      `/api/logs/${encodeURIComponent(currentFile)}?lines=200&offset=${offset}`,
    );
    const data = await res.json();
    if (data.lines?.length > 0) {
      lines = lines.concat(data.lines);
      if (lines.length > MAX_LINES) lines = lines.slice(-MAX_LINES);
      renderLines();
    }
    offset = data.offset;
    const offsetEl = $("offsetInfo");
    if (offsetEl) offsetEl.textContent = `offset: ${offset.toLocaleString()} bytes`;
  } catch {
    // Silently retry next cycle
  }
}

function renderLines(): void {
  const output = $("logOutput");
  if (!output) return;

  const filtered = filter === "ALL" ? lines : lines.filter((l) => l.includes(`[${filter}]`));
  output.innerHTML = filtered
    .map((line) => {
      let cls = "log-line info";
      if (line.includes("[ERROR]")) cls = "log-line error";
      else if (line.includes("[WARN]")) cls = "log-line warn";

      const tsMatch = line.match(/^\[(\d{4}-\d{2}-\d{2}T[\d:.]+Z?)\]/);
      if (tsMatch) {
        return `<div class="${cls}"><span class="ts">[${tsMatch[1]}]</span>${escapeHtml(line.slice(tsMatch[0].length))}</div>`;
      }
      return `<div class="${cls}">${escapeHtml(line)}</div>`;
    })
    .join("");

  const lineCountEl = $("lineCount");
  if (lineCountEl) {
    lineCountEl.textContent =
      `${filtered.length} lines` + (filter !== "ALL" ? ` (filtered from ${lines.length})` : "");
  }

  if (autoScroll) output.scrollTop = output.scrollHeight;
}

// ── Service Status Polling ───────────────────────────────

async function restartService(id: string): Promise<void> {
  if (!confirm(`Restart ${id}?`)) return;
  try {
    const res = await fetch(`/restart/${id}`, { method: "POST" });
    const data = await res.json();
    alert(data.message);
  } catch (e) {
    alert(`Restart failed: ${e}`);
  }
}

async function refreshStatus(): Promise<void> {
  try {
    const res = await fetch("/status");
    const data: Record<string, ServiceStatus | ClientStatus> = await res.json();
    const container = $("serviceCards");
    if (!container) return;

    let html = "";

    // Render service cards (gateway, runtime)
    for (const [id, s] of Object.entries(data)) {
      if (id === "client") continue;
      const svc = s as ServiceStatus;
      const statusColor = svc.healthy ? "#22c55e" : svc.tmuxAlive ? "#eab308" : "#ef4444";
      const statusText = svc.healthy ? "Healthy" : svc.tmuxAlive ? "Unhealthy" : "Down";
      const sparkline = (svc.history || [])
        .slice(-30)
        .map((h) => {
          const c = h.healthy ? "#22c55e" : h.tmuxAlive ? "#eab308" : "#ef4444";
          return `<span style="display:inline-block;width:4px;height:12px;background:${c};margin-right:1px;border-radius:1px;"></span>`;
        })
        .join("");
      const lastRestart = svc.lastRestart
        ? new Date(svc.lastRestart).toLocaleTimeString()
        : "never";

      html +=
        `<div class="card">` +
        `<div class="card-header">` +
        `<span class="status-dot" style="background:${statusColor}"></span>` +
        `<span class="card-title">${svc.name}</span>` +
        `<span class="status-text" style="color:${statusColor}">${statusText}</span>` +
        `</div>` +
        `<div class="card-body">` +
        `<div class="metric"><span class="label">tmux</span><span>${svc.tmuxAlive ? "running" : "stopped"}</span></div>` +
        `<div class="metric"><span class="label">failures</span><span>${svc.consecutiveFailures}</span></div>` +
        `<div class="metric"><span class="label">last restart</span><span>${lastRestart}</span></div>` +
        `<div class="sparkline">${sparkline}</div>` +
        `</div>` +
        `<div class="card-actions">` +
        `<button class="btn-restart" data-service="${id}">Restart</button>` +
        `</div></div>`;
    }

    // Render client health card
    if (data.client) {
      const c = data.client as ClientStatus;
      const clientColor = c.healthy ? "#22c55e" : "#ef4444";
      const clientStatus = c.healthy
        ? "Healthy"
        : c.recentErrors > 0
          ? `${c.recentErrors} Error${c.recentErrors > 1 ? "s" : ""}`
          : "Stale";
      const heartbeatText = c.lastHeartbeat
        ? new Date(c.lastHeartbeat).toLocaleTimeString()
        : "never";
      const heartbeatAge = c.heartbeatAge ? `${Math.round(c.heartbeatAge / 1000)}s ago` : "n/a";
      const errorList = (c.errors || [])
        .slice(-3)
        .map(
          (e) =>
            `<div style="font-size:11px;color:#f87171;padding:2px 0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">[${e.type}] ${escapeHtml((e.message || "").slice(0, 80))}</div>`,
        )
        .join("");

      html +=
        `<div class="card">` +
        `<div class="card-header">` +
        `<span class="status-dot" style="background:${clientColor}"></span>` +
        `<span class="card-title">${c.name}</span>` +
        `<span class="status-text" style="color:${clientColor}">${clientStatus}</span>` +
        `</div>` +
        `<div class="card-body">` +
        `<div class="metric"><span class="label">heartbeat</span><span>${heartbeatAge}</span></div>` +
        `<div class="metric"><span class="label">last seen</span><span>${heartbeatText}</span></div>` +
        `<div class="metric"><span class="label">errors (5m)</span><span>${c.recentErrors}</span></div>` +
        (errorList
          ? `<div style="margin-top:8px;border-top:1px solid #3f3f46;padding-top:6px;">${errorList}</div>`
          : "") +
        `</div>` +
        (!c.healthy
          ? `<div class="card-actions"><button class="btn-diagnose" id="diagnoseBtn">🔧 Diagnose & Fix</button></div>`
          : "") +
        `</div>`;
    }

    container.innerHTML = html;

    // Bind restart buttons (using event delegation would be cleaner but this is fine)
    container.querySelectorAll<HTMLButtonElement>("[data-service]").forEach((btn) => {
      btn.addEventListener("click", () => restartService(btn.dataset.service!));
    });

    // Bind diagnose button
    $("diagnoseBtn")?.addEventListener("click", launchDiagnose);
  } catch {
    // Silently retry next cycle
  }
}

// ── Diagnose & Fix ───────────────────────────────────────

async function launchDiagnose(): Promise<void> {
  if (!confirm("Launch Claude to diagnose and fix the client error?")) return;
  const btn = $("diagnoseBtn") as HTMLButtonElement | null;
  if (btn) btn.disabled = true;

  try {
    const res = await fetch("/diagnose", { method: "POST" });
    const data = await res.json();
    if (!data.ok) {
      alert(data.message);
      if (btn) btn.disabled = false;
      return;
    }
    showDiagnosePanel();
    pollDiagnose();
  } catch (e) {
    alert(`Failed to start: ${e}`);
    if (btn) btn.disabled = false;
  }
}

async function sendDiagnoseMessage(): Promise<void> {
  const input = $("diagnoseInput") as HTMLInputElement | null;
  const prompt = input?.value.trim();
  if (!prompt || !input) return;
  input.value = "";

  try {
    const res = await fetch("/diagnose/continue", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt }),
    });
    const data = await res.json();
    if (!data.ok) {
      alert(data.message);
      return;
    }
    pollDiagnose();
  } catch (e) {
    alert(`Failed: ${e}`);
  }
}

async function clearDiagnose(): Promise<void> {
  try {
    await fetch("/diagnose/clear", { method: "POST" });
    const section = $("diagnoseSection");
    if (section) section.classList.remove("visible");
  } catch {
    // Ignore
  }
}

function showDiagnosePanel(): void {
  const section = $("diagnoseSection");
  if (section) section.classList.add("visible");
}

async function pollDiagnose(): Promise<void> {
  try {
    const res = await fetch("/diagnose");
    const data: DiagnoseData = await res.json();
    renderDiagnosePanel(data);

    if (data.status === "running") {
      if (diagnosePollTimer) clearTimeout(diagnosePollTimer);
      diagnosePollTimer = setTimeout(pollDiagnose, 2000);
    }
  } catch {
    // Silently retry
  }
}

function renderDiagnosePanel(data: DiagnoseData): void {
  showDiagnosePanel();
  const statusEl = $("diagnoseStatus");
  const outputEl = $("diagnoseOutput");
  const actionsEl = $("diagnoseActions");

  // Status badge
  if (statusEl) {
    statusEl.className = `diagnose-status ${data.status}`;
    if (data.status === "running") {
      const elapsed = data.startedAt ? Math.round((Date.now() - data.startedAt) / 1000) : 0;
      statusEl.innerHTML = `<span class="spinner"></span> Running (${elapsed}s)`;
    } else if (data.status === "done") {
      statusEl.textContent = `✅ Done (exit ${data.exitCode})`;
    } else if (data.status === "error") {
      statusEl.textContent = `❌ Error (exit ${data.exitCode})`;
    }
  }

  // Chat-style output
  if (outputEl) {
    let content = "";

    for (const turn of data.history || []) {
      if (turn.role === "user") {
        content += `<div style="color:#60a5fa;margin:8px 0 4px;font-weight:600;">🧑 You</div>`;
        content += `<div style="color:#94a3b8;margin-bottom:8px;padding:6px 10px;background:#1e293b;border-radius:6px;">${escapeHtml(turn.text)}</div>`;
      } else {
        content += `<div style="color:#a78bfa;margin:8px 0 4px;font-weight:600;">🤖 Claude</div>`;
        content += `<div style="margin-bottom:8px;">${escapeHtml(turn.text)}</div>`;
      }
    }

    // Show current output if running
    if (data.status === "running" && data.currentOutput) {
      content += `<div style="color:#a78bfa;margin:8px 0 4px;font-weight:600;">🤖 Claude <span class="spinner" style="vertical-align:middle;"></span></div>`;
      content += `<div>${escapeHtml(data.currentOutput)}</div>`;
    } else if (data.status === "running" && !data.currentOutput) {
      content += `<div style="color:#52525b;margin:8px 0;">🤖 Claude is thinking... <span class="spinner"></span></div>`;
    }

    outputEl.innerHTML =
      content || `<span style="color:#52525b">No diagnosis session active</span>`;
    outputEl.scrollTop = outputEl.scrollHeight;
  }

  // Actions
  if (actionsEl) {
    if (data.status === "running") {
      actionsEl.innerHTML = `<span class="spinner"></span> <span style="color:#71717a;font-size:12px;">Claude is working...</span>`;
    } else if (data.status === "done" || data.status === "error") {
      actionsEl.innerHTML =
        `<div style="display:flex;gap:8px;flex:1;align-items:center;">` +
        `<input id="diagnoseInput" type="text" placeholder="Tell Claude what to do next..." ` +
        `style="flex:1;background:#09090b;color:#e4e4e7;border:1px solid #3f3f46;padding:8px 12px;border-radius:6px;font-size:13px;font-family:inherit;" />` +
        `<button class="btn-continue" id="diagnoseSendBtn">Send</button>` +
        `</div>` +
        `<div style="display:flex;gap:8px;margin-top:8px;align-items:center;">` +
        `<button class="btn-diagnose" id="diagnoseNewBtn">New Diagnosis</button>` +
        `<button class="btn-restart" id="diagnoseClearBtn">Clear</button>` +
        `<span style="color:#52525b;font-size:11px;margin-left:auto;">Session: ${(data.sessionId || "").slice(0, 8)}</span>` +
        `</div>`;

      // Bind events
      $("diagnoseInput")?.addEventListener("keydown", (e) => {
        if ((e as KeyboardEvent).key === "Enter") sendDiagnoseMessage();
      });
      $("diagnoseSendBtn")?.addEventListener("click", sendDiagnoseMessage);
      $("diagnoseNewBtn")?.addEventListener("click", launchDiagnose);
      $("diagnoseClearBtn")?.addEventListener("click", clearDiagnose);
    }
  }
}

async function checkDiagnose(): Promise<void> {
  try {
    const res = await fetch("/diagnose");
    const data: DiagnoseData = await res.json();
    if (data.status !== "idle") {
      renderDiagnosePanel(data);
      if (data.status === "running") pollDiagnose();
    }
  } catch {
    // Ignore
  }
}

// ── Start ────────────────────────────────────────────────

init();
