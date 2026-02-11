/**
 * Runtime Session
 *
 * Manages a single Claude Code CLI session using the --sdk-url WebSocket bridge.
 * The CLI connects TO our WebSocket server, giving us native access to all events.
 *
 * Each session has:
 * - A CliBridge that handles the CLI WebSocket connection
 * - A Claude CLI process spawned with Bun.spawn
 * - Event forwarding via EventEmitter
 */

import { spawn, type Subprocess } from "bun";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { CliBridge, type StreamEvent } from "./cli-bridge";

// Re-export StreamEvent for consumers
export type { StreamEvent };

// ── Types ────────────────────────────────────────────────────

export type ThinkingEffort = "low" | "medium" | "high" | "max";

export interface CreateSessionOptions {
  /** Working directory for Claude CLI */
  cwd: string;
  /** Model to use */
  model?: string;
  /** System prompt (first prompt only) */
  systemPrompt?: string;
  /** Enable adaptive thinking */
  thinking?: boolean;
  /** Thinking effort level */
  effort?: ThinkingEffort;
}

export interface ResumeSessionOptions {
  /** Working directory for Claude CLI */
  cwd: string;
  /** Model to use */
  model?: string;
  /** Enable adaptive thinking */
  thinking?: boolean;
  /** Thinking effort level */
  effort?: ThinkingEffort;
}

// ── Constants ────────────────────────────────────────────────

const DEFAULT_MODEL = "claude-sonnet-4-20250514";

// ── RuntimeSession ───────────────────────────────────────────

export class RuntimeSession extends EventEmitter {
  readonly id: string;
  readonly bridge: CliBridge;

  private proc: Subprocess | null = null;
  private isFirstPrompt: boolean;
  private _isStarted = false;
  private _isClosed = false;

  // Abort tracking — emit synthetic stops on interrupt
  private messageOpen = false;
  private openBlockIndices = new Set<number>();

  // Session options
  private cwd: string;
  private model: string;
  private systemPrompt?: string;

  /** Runtime server port — needed for --sdk-url */
  static runtimePort = 30087;

  constructor(
    id: string,
    options: CreateSessionOptions | ResumeSessionOptions,
    isResume: boolean,
  ) {
    super();
    this.id = id;
    this.cwd = options.cwd;
    this.model = options.model || DEFAULT_MODEL;
    this.systemPrompt =
      "systemPrompt" in options ? options.systemPrompt : undefined;
    this.isFirstPrompt = !isResume;

    // Set up log directory
    const logDir = join(homedir(), ".claudia", "sessions", this.id);
    if (!existsSync(logDir)) {
      mkdirSync(logDir, { recursive: true });
    }

    // Create CLI bridge (replaces AnthropicProxy)
    this.bridge = new CliBridge({
      logFile: join(logDir, "events.jsonl"),
    });

    // Forward bridge SSE events
    this.bridge.on("sse", (event: StreamEvent) => {
      this.trackEventState(event);
      this.emit("sse", event);
    });
  }

  // ── Lifecycle ──────────────────────────────────────────────

  /**
   * Start the session — marks it ready for prompts.
   * The CLI process is spawned lazily on first prompt.
   */
  async start(): Promise<void> {
    if (this._isStarted) throw new Error("Session already started");

    this._isStarted = true;
    this._isClosed = false;

    console.log(`[Session ${this.id.slice(0, 8)}] Started`);
    this.emit("ready", { sessionId: this.id });
  }

  /**
   * Send a prompt to Claude.
   * Spawns the CLI process if not already running.
   * Uses the bridge to send — queues if CLI hasn't connected yet.
   */
  prompt(content: string | unknown[]): void {
    if (!this._isStarted) throw new Error("Session not started");

    this.ensureProcess();

    // Send via WebSocket bridge — with --sdk-url, CLI reads prompts from WS, not stdin
    this.bridge.sendUserMessage(content);

    this.isFirstPrompt = false;
    this.emit("prompt_sent", { content });
  }

  /**
   * Interrupt the current response.
   * Sends a graceful interrupt via WebSocket, then emits synthetic stop
   * events to immediately update the UI. The CLI may also send its own
   * stop events, but the UI handles duplicates gracefully.
   */
  interrupt(): void {
    if (!this.proc) return;

    // Try graceful interrupt over WebSocket first
    if (this.bridge.connected) {
      console.log(`[Session ${this.id.slice(0, 8)}] Sending graceful interrupt`);
      this.bridge.sendInterrupt();
    }

    // Always emit synthetic stops so the UI updates immediately
    this.emitSyntheticStops();
    this.emit("interrupted");
  }

  /**
   * Emit synthetic stop events for any open blocks/messages.
   * Used when killing the process directly (no graceful shutdown).
   */
  private emitSyntheticStops(): void {
    for (const index of this.openBlockIndices) {
      this.emit("sse", { type: "content_block_stop", index });
    }
    this.openBlockIndices.clear();

    if (this.messageOpen) {
      this.emit("sse", {
        type: "message_delta",
        delta: { stop_reason: "abort" },
        usage: { output_tokens: 0 },
      });
      this.emit("sse", { type: "message_stop" });
      this.messageOpen = false;
    }

    this.emit("sse", {
      type: "turn_stop",
      timestamp: new Date().toISOString(),
      stop_reason: "abort",
    });
  }

  /**
   * Close the session — kill process.
   */
  async close(): Promise<void> {
    if (!this._isStarted) return;

    this._isClosed = true;

    if (this.proc) {
      this.proc.kill("SIGTERM");
      this.proc = null;
    }

    this._isStarted = false;
    this.emit("closed");
    console.log(`[Session ${this.id.slice(0, 8)}] Closed`);
  }

  // ── Getters ────────────────────────────────────────────────

  get isActive(): boolean {
    return this._isStarted && !this._isClosed;
  }

  get isProcessRunning(): boolean {
    return this.proc !== null;
  }

  /**
   * Get session info for health/status reporting.
   */
  getInfo() {
    return {
      id: this.id,
      cwd: this.cwd,
      model: this.model,
      isActive: this.isActive,
      isProcessRunning: this.isProcessRunning,
    };
  }

  // ── Private ────────────────────────────────────────────────

  /**
   * Ensure the Claude CLI process is running, spawn if needed.
   * Uses --sdk-url to connect the CLI back to our WebSocket server.
   */
  private ensureProcess(): void {
    if (this.proc) return;

    if (this._isClosed) {
      this._isClosed = false;
    }

    const systemPrompt = this.systemPrompt
      ? this.systemPrompt +
        "\n\nIMPORTANT: You are running in headless/non-interactive mode. Do NOT use the AskUserQuestion tool - make reasonable decisions autonomously instead."
      : undefined;

    const sdkUrl = `ws://localhost:${RuntimeSession.runtimePort}/ws/cli/${this.id}`;

    const args = [
      "--sdk-url",
      sdkUrl,
      "--print",
      "--output-format",
      "stream-json",
      "--input-format",
      "stream-json",
      "--include-partial-messages",
      "--verbose",
      "--model",
      this.model,
      "--permission-mode",
      "bypassPermissions",
    ];

    if (systemPrompt && this.isFirstPrompt) {
      args.push("--system-prompt", systemPrompt);
    }

    if (this.isFirstPrompt) {
      args.push("--session-id", this.id);
    } else {
      args.push("--resume", this.id);
    }

    args.push("-p", "");

    const cmd = ["claude", ...args];
    console.log(
      `[Session ${this.id.slice(0, 8)}] Spawning: claude --sdk-url ${sdkUrl.slice(0, 40)}...`,
    );
    console.log(`[Session ${this.id.slice(0, 8)}]   cwd: ${this.cwd}`);

    const proc = spawn({
      cmd,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      cwd: this.cwd,
      env: {
        ...process.env,
        CLAUDECODE: "1",
      },
    });

    this.proc = proc;

    // Pipe stdout for debugging (CLI may log info there)
    if (proc.stdout) {
      const reader = proc.stdout.getReader();
      const pump = async () => {
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            const text = new TextDecoder().decode(value);
            if (text.trim()) {
              console.log(`[Session ${this.id.slice(0, 8)}] stdout: ${text.trim().substring(0, 200)}`);
            }
          }
        } catch {
          // Stream closed
        }
      };
      pump();
    }

    proc.exited.then((exitCode) => {
      console.log(
        `[Session ${this.id.slice(0, 8)}] Process exited (code: ${exitCode})`,
      );
      this.proc = null;
      this.emit("process_ended");
    });

    this.emit("process_started");
  }

  /**
   * Track SSE event state for interrupt cleanup.
   */
  private trackEventState(event: StreamEvent): void {
    if (event.type === "message_start") {
      this.messageOpen = true;
      this.openBlockIndices.clear();
    }
    if (
      event.type === "content_block_start" &&
      typeof event.index === "number"
    ) {
      this.openBlockIndices.add(event.index);
    }
    if (
      event.type === "content_block_stop" &&
      typeof event.index === "number"
    ) {
      this.openBlockIndices.delete(event.index);
    }
    if (event.type === "message_stop") {
      this.messageOpen = false;
      this.openBlockIndices.clear();
    }
  }
}

// ── Factory Functions ────────────────────────────────────────

export function createRuntimeSession(
  options: CreateSessionOptions,
): RuntimeSession {
  const id = randomUUID();
  return new RuntimeSession(id, options, false);
}

export function resumeRuntimeSession(
  sessionId: string,
  options: ResumeSessionOptions,
): RuntimeSession {
  return new RuntimeSession(sessionId, options, true);
}
