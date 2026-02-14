/**
 * Runtime Session
 *
 * Manages a single Claude Code CLI session using stdio pipes.
 * Communicates via stdin (NDJSON prompts, control requests) and
 * stdout (NDJSON streaming events, tool results, completions).
 *
 * Each session has:
 * - A Claude CLI process spawned with Bun.spawn (stdin/stdout pipes)
 * - NDJSON message routing from stdout
 * - Event forwarding via EventEmitter
 *
 * Thinking is enabled via control_request (set_max_thinking_tokens)
 * sent on stdin after process spawn — no HTTP proxy needed.
 */

import { spawn, type Subprocess } from "bun";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, appendFileSync } from "node:fs";
import { createLogger } from "@claudia/shared";
import { join } from "node:path";
import { homedir } from "node:os";
import type {
  SDKMessage,
  SDKUserMessage,
  SDKResultMessage,
  SDKPartialAssistantMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { ThinkingEffort } from "@claudia/shared";

// ── Types ────────────────────────────────────────────────────

/** Emitted SSE event — the unwrapped inner Anthropic event */
export interface StreamEvent {
  type: string;
  [key: string]: unknown;
}

/**
 * What actually arrives on CLI stdout.
 * SDKMessage covers the main types (stream_event, assistant, user, result, system, etc.)
 * control_response and keep_alive are internal transport types not exported by the SDK.
 */
type CliStdoutMessage =
  | SDKMessage
  | {
      type: "control_response";
      response: { subtype: string; request_id: string; [key: string]: unknown };
    }
  | { type: "keep_alive" };

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

/** Map effort levels to max_thinking_tokens for control_request */
const THINKING_TOKENS: Record<ThinkingEffort, number> = {
  low: 4000,
  medium: 8000,
  high: 16000,
  max: 32000,
};

// ── RuntimeSession ───────────────────────────────────────────

export class RuntimeSession extends EventEmitter {
  readonly id: string;

  private proc: Subprocess | null = null;
  private isFirstPrompt: boolean;
  private _isStarted = false;
  private _isClosed = false;

  // Stdout NDJSON buffering
  private stdoutBuffer = "";

  // Abort tracking — emit synthetic stops on interrupt
  private messageOpen = false;
  private openBlockIndices = new Set<number>();

  // Process health monitoring
  private healthCheckInterval?: Timer;
  private createdAt = Date.now();
  private lastActivityTime = Date.now();

  // Session options
  private cwd: string;
  private model: string;
  private systemPrompt?: string;
  private effort?: ThinkingEffort;
  private stdioLogFile?: string;

  // Logging
  private logFile?: string;
  private logger;

  constructor(id: string, options: CreateSessionOptions | ResumeSessionOptions, isResume: boolean) {
    super();
    this.id = id;
    this.logger = createLogger(
      `Session:${id.slice(0, 8)}`,
      join(homedir(), ".claudia", "logs", "runtime.log"),
    );
    this.cwd = options.cwd;
    this.model = options.model || DEFAULT_MODEL;
    this.systemPrompt = "systemPrompt" in options ? options.systemPrompt : undefined;
    this.effort = options.effort;
    this.isFirstPrompt = !isResume;

    // Set up log directory
    const logDir = join(homedir(), ".claudia", "sessions", this.id);
    if (!existsSync(logDir)) {
      mkdirSync(logDir, { recursive: true });
    }
    this.logFile = join(logDir, "events.jsonl");
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

    this.logger.info("Started");
    this.emit("ready", { sessionId: this.id });
  }

  /**
   * Send a prompt to Claude.
   * Spawns the CLI process if not already running.
   * Writes directly to stdin as NDJSON.
   */
  prompt(content: string | unknown[]): void {
    if (!this._isStarted) throw new Error("Session not started");

    this.ensureProcess();

    const message = JSON.stringify({
      type: "user",
      message: { role: "user", content },
    });
    this.sendToStdin(message);

    this.isFirstPrompt = false;
    this.emit("prompt_sent", { content });
  }

  /**
   * Interrupt the current response.
   * Sends a graceful interrupt via stdin control_request, then emits
   * synthetic stop events to immediately update the UI.
   */
  interrupt(): void {
    if (!this.proc) return;

    this.logger.info("Sending graceful interrupt");

    const message = JSON.stringify({
      type: "control_request",
      request_id: randomUUID(),
      request: { subtype: "interrupt" },
    });
    this.sendToStdin(message);

    // Emit synthetic stops so the UI updates immediately
    this.emitSyntheticStops();
    this.emit("interrupted");
  }

  /**
   * Emit synthetic stop events for any open blocks/messages.
   * Ensures immediate UI feedback on interrupt.
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
   * Close the session — kill process and clean up.
   */
  async close(): Promise<void> {
    if (!this._isStarted) return;

    this._isClosed = true;
    this.stopHealthCheck();
    this.cleanup();
    this._isStarted = false;
    this.emit("closed");
    this.logger.info("Closed");
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
      createdAt: new Date(this.createdAt).toISOString(),
      lastActivity: new Date(this.lastActivityTime).toISOString(),
      healthy: this.isHealthy(),
      stale: this.isStale(),
    };
  }

  /**
   * Check if the session process is alive.
   */
  private isHealthy(): boolean {
    if (!this.proc) return false;
    return this.proc.exitCode === null;
  }

  /**
   * Check if the session has had no activity for a while (idle but not broken).
   */
  private isStale(): boolean {
    const staleThreshold = 5 * 60 * 1000; // 5 minutes
    return Date.now() - this.lastActivityTime >= staleThreshold;
  }

  // ── Process Management ────────────────────────────────────

  /**
   * Ensure the Claude CLI process is running, spawn if needed.
   * Uses stdio pipes for all communication — no WebSocket, no proxy.
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

    const args = [
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

    // Create a stdio log file for debugging visibility
    const stdioLogDir = join(homedir(), ".claudia", "logs");
    if (!existsSync(stdioLogDir)) mkdirSync(stdioLogDir, { recursive: true });
    const stdioLogFile = join(stdioLogDir, `stdio-${this.id.slice(0, 8)}.log`);
    this.stdioLogFile = stdioLogFile;

    this.logger.info("Spawning: claude (stdio mode)", { cwd: this.cwd, log: stdioLogFile });

    const proc = spawn({
      cmd,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      cwd: this.cwd,
      env: {
        ...(process.env as Record<string, string>),
        // Remove nesting detection vars so spawned Claude doesn't think it's nested
        CLAUDECODE: "",
        CLAUDE_CODE_ENTRYPOINT: "",
      },
    });

    this.proc = proc;
    this.stdoutBuffer = "";

    // Read stdout NDJSON — this is where all CLI messages come from
    if (proc.stdout) {
      this.readStdout(proc.stdout);
    }

    // Read stderr for debugging
    if (proc.stderr) {
      this.readStderr(proc.stderr);
    }

    // Configure thinking via control_request if enabled
    if (this.effort) {
      this.sendThinkingConfig(this.effort);
    }

    proc.exited.then((exitCode) => {
      this.logger.info("Process exited", { exitCode });
      this.stopHealthCheck();
      this.proc = null;
      this.emit("process_ended");
    });

    this.emit("process_started");
    this.startHealthCheck();
  }

  /**
   * Clean up process and reset state.
   */
  private cleanup(): void {
    if (this.proc) {
      this.proc.kill("SIGTERM");
      this.proc = null;
    }

    this.stdoutBuffer = "";
  }

  /**
   * Start health monitoring for the current process.
   */
  private startHealthCheck(): void {
    this.stopHealthCheck(); // Clear any existing timer

    this.healthCheckInterval = setInterval(() => {
      if (!this.proc) return;

      // Check if process has died
      if (this.proc.exitCode !== null) {
        this.logger.error("Process died unexpectedly", { exitCode: this.proc.exitCode });
        this.emit("sse", {
          type: "process_died",
          timestamp: new Date().toISOString(),
          exitCode: this.proc.exitCode,
          reason: "Process exited unexpectedly",
        });
        this.cleanup();
        return;
      }

      // Check for stale sessions (no activity for a while)
      if (this.isStale()) {
        const minutesSinceActivity = Math.round((Date.now() - this.lastActivityTime) / 60000);
        this.logger.warn("Session appears stale", { minutesSinceActivity });
        this.emit("sse", {
          type: "session_stale",
          timestamp: new Date().toISOString(),
          minutesSinceActivity,
        });
      }
    }, 10000); // Check every 10 seconds
  }

  /**
   * Stop health monitoring.
   */
  private stopHealthCheck(): void {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = undefined;
    }
  }

  // ── Stdout Reading ────────────────────────────────────────

  /**
   * Read stdout as an NDJSON stream.
   * Each line is a complete JSON message from the CLI.
   */
  private async readStdout(stdout: ReadableStream<Uint8Array>): Promise<void> {
    const reader = stdout.getReader();
    const decoder = new TextDecoder();

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        this.stdoutBuffer += decoder.decode(value, { stream: true });

        // Process complete lines
        let newlineIndex: number;
        while ((newlineIndex = this.stdoutBuffer.indexOf("\n")) !== -1) {
          const line = this.stdoutBuffer.slice(0, newlineIndex).trim();
          this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1);

          if (line.length > 0) {
            this.handleCliLine(line);
          }
        }
      }
    } catch {
      // Stream closed — process exited
    }
  }

  /**
   * Read stderr for debugging output.
   */
  private async readStderr(stderr: ReadableStream<Uint8Array>): Promise<void> {
    const reader = stderr.getReader();
    const decoder = new TextDecoder();

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const text = decoder.decode(value, { stream: true });
        if (text.trim()) {
          this.logger.warn("stderr", { text: text.trim().substring(0, 200) });
        }
      }
    } catch {
      // Stream closed
    }
  }

  // ── CLI Message Routing ───────────────────────────────────

  /**
   * Parse and route a single NDJSON line from stdout.
   */
  private handleCliLine(line: string): void {
    // Log raw stdio for debugging (tail -f ~/.claudia/logs/stdio-{id}.log)
    if (this.stdioLogFile) {
      try {
        appendFileSync(this.stdioLogFile, line + "\n");
      } catch {
        // Ignore log write errors
      }
    }

    try {
      const msg = JSON.parse(line);
      this.routeMessage(msg);
    } catch {
      this.logger.warn("Failed to parse NDJSON line", { line: line.substring(0, 200) });
    }
  }

  /**
   * Route a parsed CLI message by type.
   * Uses official Agent SDK types (SDKMessage) for type-safe narrowing.
   * control_response and keep_alive are transport-internal, handled separately.
   */
  private routeMessage(msg: CliStdoutMessage): void {
    // Update activity tracking for health monitoring
    this.lastActivityTime = Date.now();
    switch (msg.type) {
      case "stream_event":
        this.handleStreamEvent(msg);
        break;

      case "assistant":
        // With --include-partial-messages, stream_events arrive before this.
        // Just log for debugging — streaming already handled the UI updates.
        this.log({ type: "assistant", blocks: msg.message.content.length });
        break;

      case "user":
        this.handleUserMessage(msg);
        break;

      case "result":
        this.handleResultMessage(msg);
        break;

      case "control_response":
        this.logger.info("control_response", { subtype: msg.response.subtype });
        break;

      case "system":
        this.handleSystemMessage(msg as Record<string, unknown>);
        break;

      case "keep_alive":
        break;

      default:
        this.log({
          type: "unknown_message",
          messageType: (msg as SDKMessage).type,
          raw: msg as Record<string, unknown>,
        });
        break;
    }
  }

  /**
   * stream_event — unwrap the inner Anthropic SSE event and emit it.
   * CLI sends:  { type: "stream_event", event: { type: "content_block_delta", ... } }
   * We emit:    { type: "content_block_delta", ... }
   */
  private handleStreamEvent(msg: SDKPartialAssistantMessage): void {
    const event = msg.event as unknown as StreamEvent;
    if (!event) return;

    this.trackEventState(event);
    this.log(event);
    this.emit("sse", event);
  }

  /**
   * user — extract tool_result blocks and emit as request_tool_results.
   * After Claude calls tools, the CLI executes them and sends results
   * back as a user message containing tool_result content blocks.
   */
  private handleUserMessage(msg: SDKUserMessage): void {
    const content = msg.message.content;
    if (!content || typeof content === "string") return;

    const toolResults = content.filter((c) => c.type === "tool_result");
    if (toolResults.length > 0) {
      const event = {
        type: "request_tool_results",
        timestamp: new Date().toISOString(),
        tool_results: toolResults.map((c) => ({
          tool_use_id: c.tool_use_id,
          content: c.content,
          is_error: c.is_error,
        })),
      };
      this.log(event);
      this.emit("sse", event);
    }
  }

  /**
   * result — query completion with usage/cost data.
   * SDKResultMessage is a discriminated union: SDKResultSuccess | SDKResultError
   */
  private handleResultMessage(msg: SDKResultMessage): void {
    const stopReason = msg.stop_reason || msg.subtype || "end_turn";

    this.emit("sse", {
      type: "turn_stop",
      timestamp: new Date().toISOString(),
      stop_reason: stopReason,
      duration_ms: msg.duration_ms,
      num_turns: msg.num_turns,
      usage: msg.usage,
      cost_usd: msg.total_cost_usd,
    });

    this.log({ ...(msg as unknown as Record<string, unknown>), logged_as: "result" });
  }

  /**
   * system — handle compaction events and other system messages.
   *
   * Compaction sequence from Claude Code CLI:
   *   1. { type: "system", subtype: "status", status: "compacting" }  → start
   *   2. { type: "system", subtype: "status", status: null }          → end
   *   3. { type: "system", subtype: "compact_boundary", compact_metadata: { trigger, pre_tokens } }
   *   4. { type: "user", isSynthetic: true, message: { content: "summary..." } }
   *
   * We forward compaction-related events as SSE so the UI can show indicators.
   */
  private handleSystemMessage(msg: Record<string, unknown>): void {
    const subtype = msg.subtype as string | undefined;

    this.logger.info("system message", { subtype, raw: JSON.stringify(msg).substring(0, 200) });
    this.log({ ...msg, logged_as: "system" });

    if (subtype === "status") {
      const status = msg.status as string | null;
      if (status === "compacting") {
        this.logger.info("Compaction started");
        this.emit("sse", {
          type: "compaction_start",
          timestamp: new Date().toISOString(),
        });
      } else if (status === null) {
        // status: null means compaction finished (or other status cleared)
        this.logger.info("Compaction status cleared");
      }
    } else if (subtype === "compact_boundary") {
      const metadata = msg.compact_metadata as
        | { trigger?: string; pre_tokens?: number }
        | undefined;
      this.logger.info("Compaction boundary", {
        trigger: metadata?.trigger,
        pre_tokens: metadata?.pre_tokens,
      });
      this.emit("sse", {
        type: "compaction_end",
        timestamp: new Date().toISOString(),
        trigger: metadata?.trigger || "auto",
        pre_tokens: metadata?.pre_tokens || 0,
      });
    }
  }

  // ── Stdin Writing ─────────────────────────────────────────

  /**
   * Write an NDJSON message to the CLI's stdin.
   */
  private sendToStdin(message: string): void {
    const stdin = this.proc?.stdin;
    if (!stdin || typeof stdin === "number") {
      this.logger.warn("Cannot write to stdin: no process");
      return;
    }

    // Log stdin for debugging (tail -f ~/.claudia/logs/stdio-{id}.log)
    if (this.stdioLogFile) {
      try {
        appendFileSync(this.stdioLogFile, `>>> STDIN: ${message}\n`);
      } catch {
        // Ignore log write errors
      }
    }

    try {
      stdin.write(message + "\n");
    } catch (error) {
      this.logger.error("Failed to write to stdin", { error: String(error) });
    }
  }

  /**
   * Set the permission mode via control_request.
   * Used to toggle between bypassPermissions, plan, acceptEdits, etc.
   */
  setPermissionMode(mode: string): void {
    if (!this.proc) return;

    this.logger.info("Setting permission mode", { mode });

    const message = JSON.stringify({
      type: "control_request",
      request_id: randomUUID(),
      request: {
        subtype: "set_permission_mode",
        permission_mode: mode,
      },
    });
    this.sendToStdin(message);
  }

  /**
   * Send thinking configuration via control_request.
   * Maps effort level to max_thinking_tokens.
   */
  private sendThinkingConfig(effort: ThinkingEffort): void {
    const maxTokens = THINKING_TOKENS[effort];
    this.logger.info("Configuring thinking", { effort, maxTokens });

    const message = JSON.stringify({
      type: "control_request",
      request_id: randomUUID(),
      request: {
        subtype: "set_max_thinking_tokens",
        max_thinking_tokens: maxTokens,
      },
    });
    this.sendToStdin(message);
  }

  // ── Event State Tracking ──────────────────────────────────

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

  // ── Logging ───────────────────────────────────────────────

  private log(event: Record<string, unknown>): void {
    if (!this.logFile) return;
    try {
      appendFileSync(this.logFile, JSON.stringify(event) + "\n");
    } catch {
      // Ignore log errors
    }
  }
}

// ── Factory Functions ────────────────────────────────────────

export function createRuntimeSession(options: CreateSessionOptions): RuntimeSession {
  const id = randomUUID();
  return new RuntimeSession(id, options, false);
}

export function resumeRuntimeSession(
  sessionId: string,
  options: ResumeSessionOptions,
): RuntimeSession {
  return new RuntimeSession(sessionId, options, true);
}
