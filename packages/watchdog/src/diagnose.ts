/**
 * Diagnose & Fix — spawns claude -p to autonomously fix client errors.
 */

import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { spawn, type Subprocess } from "bun";
import {
  PROJECT_DIR,
  CLAUDE_PATH,
  DIAGNOSE_TIMEOUT,
  DIAGNOSE_COOLDOWN,
  DIAGNOSE_LOG_DIR,
} from "./constants";
import { log } from "./logger";
import { lastClientHealth } from "./client-health";

// ── Types ────────────────────────────────────────────────

export interface DiagnoseTurn {
  role: "user" | "claude";
  text: string;
  timestamp: string;
}

export interface DiagnoseState {
  status: "idle" | "running" | "done" | "error";
  sessionId: string | null;
  currentOutput: string;
  history: DiagnoseTurn[];
  startedAt: number | null;
  finishedAt: number | null;
  exitCode: number | null;
}

// ── State ────────────────────────────────────────────────

export const diagnose: DiagnoseState = {
  status: "idle",
  sessionId: null,
  currentOutput: "",
  history: [],
  startedAt: null,
  finishedAt: null,
  exitCode: null,
};

let diagnoseProc: Subprocess | null = null;
let diagnoseTimer: ReturnType<typeof setTimeout> | null = null;

// ── Helpers ──────────────────────────────────────────────

function writeDiagnoseLog(): void {
  if (!diagnose.sessionId || diagnose.history.length === 0) return;
  try {
    if (!existsSync(DIAGNOSE_LOG_DIR)) mkdirSync(DIAGNOSE_LOG_DIR, { recursive: true });
    const logPath = join(DIAGNOSE_LOG_DIR, `${diagnose.sessionId.slice(0, 8)}.md`);
    let content = `# Diagnose Session ${diagnose.sessionId.slice(0, 8)}\n`;
    content += `Started: ${new Date(diagnose.startedAt || 0).toISOString()}\n\n`;
    for (const turn of diagnose.history) {
      const label = turn.role === "user" ? "## 🧑 Michael" : "## 🤖 Claude";
      content += `${label}\n_${turn.timestamp}_\n\n${turn.text}\n\n---\n\n`;
    }
    Bun.write(logPath, content);
  } catch (e) {
    log("WARN", `Failed to write diagnose log: ${e}`);
  }
}

async function collectStream(
  stream: ReadableStream<Uint8Array> | number | null | undefined,
  onText: (text: string) => void,
): Promise<void> {
  if (!stream || typeof stream === "number") return;
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      onText(decoder.decode(value, { stream: true }));
    }
  } catch {
    // Stream closed
  }
}

// ── Main Function ────────────────────────────────────────

export async function startDiagnose(
  customPrompt?: string,
): Promise<{ ok: boolean; message: string }> {
  // Guard: already running
  if (diagnose.status === "running") {
    return { ok: false, message: "Already diagnosing — wait for current run to finish" };
  }

  // Guard: cooldown
  if (diagnose.finishedAt && Date.now() - diagnose.finishedAt < DIAGNOSE_COOLDOWN) {
    const wait = Math.ceil((DIAGNOSE_COOLDOWN - (Date.now() - diagnose.finishedAt)) / 1000);
    return { ok: false, message: `Cooldown — wait ${wait}s before retrying` };
  }

  // Determine if this is a new session or a resume
  const isResume = !!customPrompt && !!diagnose.sessionId;
  const sessionId = isResume ? diagnose.sessionId! : randomUUID();

  // Build the prompt
  let prompt: string;
  if (customPrompt) {
    prompt = customPrompt;
  } else {
    // Fetch current error details from gateway
    let errorDetails = "Unknown error";
    try {
      const res = await fetch("http://localhost:30086/health", {
        signal: AbortSignal.timeout(2000),
      });
      if (res.ok) {
        const data = (await res.json()) as {
          client?: { errors: { type: string; message: string }[]; healthy: boolean };
        };
        if (data.client?.errors?.length) {
          errorDetails = data.client.errors.map((e) => `[${e.type}] ${e.message}`).join("\n");
        }
      }
    } catch {
      if (lastClientHealth?.errors?.length) {
        errorDetails = lastClientHealth.errors.map((e) => `[${e.type}] ${e.message}`).join("\n");
      }
    }

    prompt = `The Claudia web client has a build/render error. Here are the details:

Error:
${errorDetails}

The project is at ${PROJECT_DIR}.
Find the broken file, understand the error, and fix it.
The fix should be minimal — just fix what's broken, don't refactor.
After fixing, verify by reading the file to confirm the fix looks correct.`;
  }

  // Build command
  const cmd = [CLAUDE_PATH, "-p", "--dangerously-skip-permissions", "--model", "sonnet"];
  if (isResume) {
    cmd.push("--resume", sessionId);
  } else {
    cmd.push("--session-id", sessionId);
  }
  cmd.push(prompt);

  log(
    "INFO",
    `Starting diagnose (${isResume ? "resume" : "new"} session: ${sessionId.slice(0, 8)})`,
  );

  // Update state
  diagnose.status = "running";
  diagnose.sessionId = sessionId;
  diagnose.currentOutput = "";
  diagnose.startedAt = diagnose.startedAt || Date.now();
  diagnose.finishedAt = null;
  diagnose.exitCode = null;
  if (!isResume) {
    diagnose.history = [];
  }

  // Record the user's prompt in history
  diagnose.history.push({
    role: "user",
    text: prompt,
    timestamp: new Date().toISOString(),
  });

  try {
    diagnoseProc = spawn({
      cmd,
      cwd: PROJECT_DIR,
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        CLAUDECODE: "", // Bypass nested session guard
      },
    });

    // Collect stdout
    collectStream(diagnoseProc.stdout, (text) => {
      diagnose.currentOutput += text;
    });

    // Collect stderr (for debugging)
    collectStream(diagnoseProc.stderr, (text) => {
      diagnose.currentOutput += text;
    });

    // Timeout guard
    diagnoseTimer = setTimeout(() => {
      if (diagnoseProc) {
        log("WARN", "Diagnose process timed out — killing");
        diagnoseProc.kill("SIGTERM");
      }
    }, DIAGNOSE_TIMEOUT);

    // Wait for exit
    diagnoseProc.exited.then((exitCode) => {
      if (diagnoseTimer) {
        clearTimeout(diagnoseTimer);
        diagnoseTimer = null;
      }
      diagnose.exitCode = exitCode ?? -1;
      diagnose.status = exitCode === 0 ? "done" : "error";
      diagnose.finishedAt = Date.now();

      // Record Claude's response in history
      diagnose.history.push({
        role: "claude",
        text: diagnose.currentOutput,
        timestamp: new Date().toISOString(),
      });
      diagnoseProc = null;

      // Write to log file
      writeDiagnoseLog();

      const duration = Date.now() - (diagnose.startedAt || 0);
      log(
        exitCode === 0 ? "INFO" : "WARN",
        `Diagnose finished (exit=${exitCode}, ${Math.round(duration / 1000)}s, ${diagnose.currentOutput.length} chars)`,
      );
    });

    return { ok: true, message: "Diagnosis started" };
  } catch (error) {
    diagnose.status = "error";
    diagnose.currentOutput = `Failed to spawn claude: ${error}`;
    diagnose.finishedAt = Date.now();
    log("ERROR", `Failed to spawn diagnose: ${error}`);
    return { ok: false, message: `Failed to start: ${error}` };
  }
}

export function clearDiagnose(): { ok: boolean; message?: string } {
  if (diagnose.status === "running") {
    return { ok: false, message: "Can't clear while running" };
  }
  diagnose.status = "idle";
  diagnose.sessionId = null;
  diagnose.currentOutput = "";
  diagnose.history = [];
  diagnose.startedAt = null;
  diagnose.finishedAt = null;
  diagnose.exitCode = null;
  return { ok: true };
}

export function getDiagnoseStatus() {
  return {
    status: diagnose.status,
    sessionId: diagnose.sessionId,
    currentOutput: diagnose.currentOutput.slice(-10000),
    history: diagnose.history.map((h) => ({
      role: h.role,
      text: h.text.slice(-5000),
      timestamp: h.timestamp,
    })),
    startedAt: diagnose.startedAt,
    finishedAt: diagnose.finishedAt,
    exitCode: diagnose.exitCode,
  };
}
