/**
 * Runtime Session
 *
 * Manages a single Claude Code CLI session: proxy + process + stdin.
 * Extracted from @claudia/sdk, adapted for the session runtime service.
 *
 * Each session has:
 * - An HTTP proxy that intercepts Anthropic API calls
 * - A Claude CLI process spawned with Bun.spawn
 * - A stdin pipe for sending prompts
 * - Event forwarding via EventEmitter
 */

import { spawn, type Subprocess, type FileSink } from "bun";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { AnthropicProxy, type StreamEvent } from "./proxy";

// ── Types ────────────────────────────────────────────────────

export type ThinkingEffort = 'low' | 'medium' | 'high' | 'max';

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
  /** Base port for proxy (will find available port) */
  basePort?: number;
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
  /** Base port for proxy */
  basePort?: number;
}

// ── Constants ────────────────────────────────────────────────

const DEFAULT_MODEL = "claude-sonnet-4-20250514"; // Fallback only — prefer config via manager
const DEFAULT_BASE_PORT = 9000;

// ── RuntimeSession ───────────────────────────────────────────

export class RuntimeSession extends EventEmitter {
  readonly id: string;

  private proxy: AnthropicProxy;
  private proc: Subprocess | null = null;
  private stdin: FileSink | null = null;
  private isFirstPrompt: boolean;
  private _isStarted = false;
  private _isClosed = false;

  // Abort tracking — emit synthetic stops on interrupt
  private messageOpen = false;
  private openBlockIndices = new Set<number>();

  // Session options (stored for process spawning)
  private cwd: string;
  private model: string;
  private systemPrompt?: string;
  private basePort: number;

  constructor(id: string, options: CreateSessionOptions | ResumeSessionOptions, isResume: boolean) {
    super();
    this.id = id;
    this.cwd = options.cwd;
    this.model = options.model || DEFAULT_MODEL;
    this.systemPrompt = "systemPrompt" in options ? options.systemPrompt : undefined;
    this.basePort = options.basePort || DEFAULT_BASE_PORT;
    this.isFirstPrompt = !isResume;

    // Set up proxy with thinking config
    const logDir = join(homedir(), ".claudia", "sessions", this.id);
    if (!existsSync(logDir)) {
      mkdirSync(logDir, { recursive: true });
    }

    this.proxy = new AnthropicProxy({
      thinking: options.thinking,
      effort: options.effort,
      logFile: join(logDir, "events.jsonl"),
    });

    // Forward proxy SSE events
    this.proxy.on("sse", (event: StreamEvent) => {
      this.trackEventState(event);
      this.emit("sse", event);
    });
  }

  // ── Lifecycle ──────────────────────────────────────────────

  /**
   * Start the session — spins up the proxy server.
   * The Claude process is spawned lazily on first prompt.
   */
  async start(): Promise<void> {
    if (this._isStarted) throw new Error("Session already started");

    const targetPort = this.derivePort(this.id);
    const port = await this.proxy.start(targetPort);

    this._isStarted = true;
    this._isClosed = false;

    console.log(`[Session ${this.id.slice(0, 8)}] Started (proxy: ${port})`);
    this.emit("ready", { sessionId: this.id, proxyPort: port });
  }

  /**
   * Send a prompt to Claude.
   * Spawns the Claude process if not already running.
   */
  prompt(content: string | unknown[]): void {
    if (!this._isStarted) throw new Error("Session not started");

    this.ensureProcess();

    const message = {
      type: "user",
      message: {
        role: "user",
        content,
      },
    };

    this.stdin!.write(JSON.stringify(message) + "\n");
    this.isFirstPrompt = false;
    this.emit("prompt_sent", { content });
  }

  /**
   * Interrupt the current response.
   * Kills the Claude process and emits synthetic stop events.
   */
  interrupt(): void {
    if (!this.proc) return;

    // Emit synthetic content_block_stop for each open block
    for (const index of this.openBlockIndices) {
      this.emit("sse", { type: "content_block_stop", index });
    }
    this.openBlockIndices.clear();

    // Emit message_delta with abort and message_stop
    if (this.messageOpen) {
      this.emit("sse", {
        type: "message_delta",
        delta: { stop_reason: "abort" },
        usage: { output_tokens: 0 },
      });
      this.emit("sse", { type: "message_stop" });
      this.messageOpen = false;
    }

    // Emit synthetic turn_stop and reset proxy turn state
    this.emit("sse", {
      type: "turn_stop",
      timestamp: new Date().toISOString(),
      stop_reason: "abort",
    });
    this.proxy.resetTurn();

    this.proc.kill("SIGTERM");
    this.proc = null;
    this.stdin = null;
    this.emit("interrupted");
  }

  /**
   * Close the session — kill process and stop proxy.
   */
  async close(): Promise<void> {
    if (!this._isStarted) return;

    this._isClosed = true;

    if (this.proc) {
      this.proc.kill("SIGTERM");
      this.proc = null;
      this.stdin = null;
    }

    await this.proxy.stop();

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

  get proxyPort(): number {
    return this.proxy.port;
  }

  /**
   * Get session info for health/status reporting.
   */
  getInfo() {
    return {
      id: this.id,
      cwd: this.cwd,
      model: this.model,
      proxyPort: this.proxy.port,
      isActive: this.isActive,
      isProcessRunning: this.isProcessRunning,
    };
  }

  // ── Private ────────────────────────────────────────────────

  /**
   * Derive a deterministic port from session ID.
   */
  private derivePort(sessionId: string): number {
    const hash = sessionId.split("").reduce((acc, c) => acc + c.charCodeAt(0), 0);
    return this.basePort + (hash % 1000);
  }

  /**
   * Ensure the Claude CLI process is running, spawn if needed.
   */
  private ensureProcess(): void {
    if (this.proc && this.stdin) return;

    if (this._isClosed) {
      this._isClosed = false;
    }

    const systemPrompt = this.systemPrompt
      ? this.systemPrompt +
        "\n\nIMPORTANT: You are running in headless/non-interactive mode. Do NOT use the AskUserQuestion tool - make reasonable decisions autonomously instead."
      : undefined;

    const args = [
      "-p",
      "--dangerously-skip-permissions",
      "--model",
      this.model,
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--verbose",
    ];

    if (systemPrompt && this.isFirstPrompt) {
      args.push("--system-prompt", systemPrompt);
    }

    if (this.isFirstPrompt) {
      args.push("--session-id", this.id);
    } else {
      args.push("--resume", this.id);
    }

    const cmd = ["claude", ...args];
    console.log(`[Session ${this.id.slice(0, 8)}] Spawning: claude ${args.slice(0, 4).join(" ")}...`);
    console.log(`[Session ${this.id.slice(0, 8)}]   cwd: ${this.cwd}`);
    console.log(`[Session ${this.id.slice(0, 8)}]   proxy: http://localhost:${this.proxy.port}`);

    const proc = spawn({
      cmd,
      stdin: "pipe",
      stdout: "ignore",
      stderr: "inherit",
      cwd: this.cwd,
      env: {
        ...process.env,
        ANTHROPIC_BASE_URL: `http://localhost:${this.proxy.port}`,
      },
    });

    this.proc = proc;
    this.stdin = proc.stdin as FileSink;

    proc.exited.then(() => {
      this.proc = null;
      this.stdin = null;
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
    if (event.type === "content_block_start" && typeof event.index === "number") {
      this.openBlockIndices.add(event.index);
    }
    if (event.type === "content_block_stop" && typeof event.index === "number") {
      this.openBlockIndices.delete(event.index);
    }
    if (event.type === "message_stop") {
      this.messageOpen = false;
      this.openBlockIndices.clear();
    }
  }
}

// ── Factory Functions ────────────────────────────────────────

export function createRuntimeSession(options: CreateSessionOptions): RuntimeSession {
  const id = randomUUID();
  return new RuntimeSession(id, options, false);
}

export function resumeRuntimeSession(sessionId: string, options: ResumeSessionOptions): RuntimeSession {
  return new RuntimeSession(sessionId, options, true);
}
