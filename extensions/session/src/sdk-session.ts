/**
 * SDK Session
 *
 * Manages a single Claude Code session using the Agent SDK's query() function.
 * SDK-only engine — no CLI subprocess, no stdin/stdout, no NDJSON parsing.
 *
 * Uses query() with AsyncIterable<SDKUserMessage> for multi-turn conversations.
 * The SDK handles process lifecycle, message parsing, and resume internally.
 *
 * Key features:
 * - disallowedTools instead of SYSTEM_PROMPT.md addendum
 * - SDK resume via `resume: sessionId` option
 * - Interrupt via query.interrupt()
 * - Permission mode via query.setPermissionMode()
 * - Tool results pushed through message channel
 */

import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, appendFileSync } from "node:fs";
import { createLogger } from "@claudia/shared";
import { join } from "node:path";
import { homedir } from "node:os";
import { query } from "@anthropic-ai/claude-agent-sdk";
import type {
  Query,
  SDKMessage,
  SDKUserMessage,
  SDKResultMessage,
  SDKPartialAssistantMessage,
  PermissionMode,
} from "@anthropic-ai/claude-agent-sdk";
import type { ThinkingEffort } from "@claudia/shared";

// ── Types ────────────────────────────────────────────────────

/** Emitted SSE event — the unwrapped inner Anthropic event */
export interface StreamEvent {
  type: string;
  [key: string]: unknown;
}

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

/** Tools that require a tool_result sent back (not auto-executed by CLI) */
const INTERACTIVE_TOOLS = new Set(["ExitPlanMode", "EnterPlanMode", "AskUserQuestion"]);

/** Tools to disallow in headless mode — replaces SYSTEM_PROMPT.md */
const DISALLOWED_TOOLS = ["AskUserQuestion", "EnterPlanMode", "ExitPlanMode"];

/** Map effort levels to max_thinking_tokens */
const THINKING_TOKENS: Record<ThinkingEffort, number> = {
  low: 4000,
  medium: 8000,
  high: 16000,
  max: 32000,
};

// ── MessageChannel ───────────────────────────────────────────

/**
 * Push-based async iterable for feeding user messages to query().
 *
 * The SDK's query() accepts `AsyncIterable<SDKUserMessage>` as its prompt source.
 * This channel lets us push messages from prompt()/sendToolResult() calls and
 * have them consumed by the query's internal loop.
 *
 * The channel stays open for the session's lifetime, enabling multi-turn
 * conversations over a single query() call.
 */
class MessageChannel implements AsyncIterable<SDKUserMessage> {
  private queue: SDKUserMessage[] = [];
  private waiting: {
    resolve: (result: IteratorResult<SDKUserMessage>) => void;
  } | null = null;
  private closed = false;

  /** Enqueue a user message. Resolves any waiting consumer immediately. */
  push(msg: SDKUserMessage): void {
    if (this.closed) throw new Error("MessageChannel closed");
    if (this.waiting) {
      const { resolve } = this.waiting;
      this.waiting = null;
      resolve({ value: msg, done: false });
    } else {
      this.queue.push(msg);
    }
  }

  /** Signal end of conversation. Any waiting consumer gets done:true. */
  close(): void {
    this.closed = true;
    if (this.waiting) {
      const { resolve } = this.waiting;
      this.waiting = null;
      resolve({ value: undefined as unknown as SDKUserMessage, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: (): Promise<IteratorResult<SDKUserMessage>> => {
        // Drain queued messages first
        if (this.queue.length > 0) {
          return Promise.resolve({ value: this.queue.shift()!, done: false });
        }
        // Channel closed — signal end
        if (this.closed) {
          return Promise.resolve({ value: undefined as unknown as SDKUserMessage, done: true });
        }
        // Wait for next push
        return new Promise((resolve) => {
          this.waiting = { resolve };
        });
      },
    };
  }
}

// ── SDKSession ───────────────────────────────────────────────

export class SDKSession extends EventEmitter {
  readonly id: string;

  // SDK state
  private queryInstance: Query | null = null;
  private messageChannel: MessageChannel | null = null;
  private abortController: AbortController | null = null;

  // Lifecycle
  private _isStarted = false;
  private _isClosed = false;

  // Abort tracking — emit synthetic stops on interrupt
  private messageOpen = false;
  private openBlockIndices = new Set<number>();

  // Interactive tool tracking (ExitPlanMode, EnterPlanMode, AskUserQuestion)
  // These tools need a tool_result sent back to unblock the CLI
  private pendingInteractiveTools = new Map<string, { name: string; input: string }>();
  private currentToolUseId: string | null = null;
  private currentToolUseName: string | null = null;

  // Session options
  private cwd: string;
  private model: string;
  private systemPrompt?: string;
  private effort?: ThinkingEffort;
  private isFirstPrompt: boolean;

  // Timestamps for health reporting
  private createdAt = Date.now();
  private lastActivityTime = Date.now();

  // Logging
  private logFile?: string;
  private logger;
  private queryFactory: typeof query;

  constructor(
    id: string,
    options: CreateSessionOptions | ResumeSessionOptions,
    isResume: boolean,
    deps?: { queryFactory?: typeof query },
  ) {
    super();
    this.queryFactory = deps?.queryFactory || query;
    this.id = id;
    this.logger = createLogger(
      `SDKSession:${id.slice(0, 8)}`,
      join(homedir(), ".claudia", "logs", "session.log"),
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
   * The SDK query is created lazily on first prompt.
   */
  async start(): Promise<void> {
    if (this._isStarted) throw new Error("Session already started");

    this._isStarted = true;
    this._isClosed = false;

    this.logger.info("Started (SDK engine)");
    this.emit("ready", { sessionId: this.id });
  }

  /**
   * Send a prompt to Claude.
   * Creates the SDK query if not already running.
   * Pushes the message into the message channel for query() to consume.
   */
  prompt(content: string | unknown[]): void {
    if (!this._isStarted) throw new Error("Session not started");

    this.ensureQuery();

    const msg = {
      type: "user" as const,
      message: { role: "user" as const, content: typeof content === "string" ? content : content },
      parent_tool_use_id: null,
      session_id: this.id,
    } as SDKUserMessage;
    this.messageChannel!.push(msg);

    this.isFirstPrompt = false;
    this.emit("prompt_sent", { content });
  }

  /**
   * Interrupt the current response.
   * Uses SDK's interrupt() method, then emits synthetic stops for immediate UI feedback.
   */
  interrupt(): void {
    if (!this.queryInstance) return;

    this.logger.info("Sending SDK interrupt");
    this.queryInstance.interrupt().catch((err) => {
      this.logger.warn("Interrupt failed", { error: String(err) });
    });

    // Emit synthetic stops so the UI updates immediately
    this.emitSyntheticStops();
    this.emit("interrupted");
  }

  /**
   * Close the session — terminate query and clean up.
   */
  async close(): Promise<void> {
    if (!this._isStarted) return;

    this._isClosed = true;
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
    return this.queryInstance !== null;
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
      healthy: this.queryInstance !== null && !this._isClosed,
      stale: this.isStale(),
    };
  }

  /**
   * Check if the session has had no activity for a while (idle but not broken).
   */
  private isStale(): boolean {
    const staleThreshold = 5 * 60 * 1000; // 5 minutes
    return Date.now() - this.lastActivityTime >= staleThreshold;
  }

  // ── Control Methods ────────────────────────────────────────

  /**
   * Set the permission mode via SDK query method.
   */
  setPermissionMode(mode: string): void {
    if (!this.queryInstance) return;

    this.logger.info("Setting permission mode", { mode });
    this.queryInstance.setPermissionMode(mode as PermissionMode).catch((err) => {
      this.logger.warn("setPermissionMode failed", { error: String(err) });
    });
  }

  /**
   * Send a tool_result for an interactive tool (ExitPlanMode, EnterPlanMode, AskUserQuestion).
   * Pushes a user message with tool_result content block into the message channel.
   */
  sendToolResult(toolUseId: string, content: string, isError = false): void {
    if (!this.messageChannel) {
      this.logger.warn("Cannot send tool_result: no message channel");
      return;
    }

    this.logger.info("Sending tool_result", { toolUseId: toolUseId.slice(0, 12), isError });

    const msg = {
      type: "user" as const,
      message: {
        role: "user" as const,
        content: [
          {
            type: "tool_result" as const,
            tool_use_id: toolUseId,
            content,
            ...(isError ? { is_error: true } : {}),
          },
        ],
      },
      parent_tool_use_id: null,
      session_id: this.id,
    } as SDKUserMessage;
    this.messageChannel.push(msg);

    // Clean up tracking
    this.pendingInteractiveTools.delete(toolUseId);
  }

  /**
   * Get pending interactive tools awaiting a tool_result.
   */
  getPendingInteractiveTools(): Array<{ toolUseId: string; name: string; input: string }> {
    return Array.from(this.pendingInteractiveTools.entries()).map(([id, info]) => ({
      toolUseId: id,
      ...info,
    }));
  }

  // ── SDK Query Management ───────────────────────────────────

  /**
   * Ensure the SDK query is running, create if needed.
   */
  private ensureQuery(): void {
    if (this.queryInstance) return;

    if (this._isClosed) {
      this._isClosed = false;
    }

    this.messageChannel = new MessageChannel();
    this.abortController = new AbortController();

    const options = this.buildQueryOptions();

    this.logger.info("Creating SDK query", {
      cwd: this.cwd,
      model: this.model,
      isResume: !this.isFirstPrompt,
    });

    this.queryInstance = this.queryFactory({
      prompt: this.messageChannel,
      options,
    });

    // Start background reader loop
    this.readQueryMessages();

    this.emit("process_started");
  }

  /**
   * Build SDK query options from session configuration.
   */
  private buildQueryOptions(): Record<string, unknown> {
    return {
      // Session identity — SDK handles resume via `resume` option
      ...(this.isFirstPrompt ? { sessionId: this.id } : { resume: this.id }),

      // Working directory and model
      cwd: this.cwd,
      model: this.model,

      // System prompt (first prompt only)
      ...(this.systemPrompt ? { systemPrompt: this.systemPrompt } : {}),

      // Disallow interactive tools instead of SYSTEM_PROMPT.md addendum
      disallowedTools: DISALLOWED_TOOLS,

      // Thinking configuration
      ...(this.effort
        ? {
            thinking: { type: "enabled", budgetTokens: THINKING_TOKENS[this.effort] },
            effort: this.effort,
          }
        : {}),

      // Permissions — bypass everything (headless mode)
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,

      // Enable streaming events (critical — gives us stream_event messages)
      includePartialMessages: true,

      // Abort support
      abortController: this.abortController,

      // Auto-approve all tool calls (same as bypassPermissions)
      canUseTool: async () => ({ behavior: "allow" as const }),

      // Environment — clear nesting detection vars
      env: {
        ...process.env,
        CLAUDECODE: "",
        CLAUDE_CODE_ENTRYPOINT: "",
      },
    };
  }

  /**
   * Background loop: iterate the SDK query generator and route each message.
   * Runs concurrently with the message channel that feeds prompts in.
   */
  private async readQueryMessages(): Promise<void> {
    if (!this.queryInstance) return;

    try {
      for await (const msg of this.queryInstance) {
        this.routeMessage(msg);
      }
    } catch (err) {
      // AbortError is expected on close/interrupt
      const errorName = (err as Error)?.name;
      if (errorName !== "AbortError") {
        this.logger.error("Query reader error", { error: String(err) });
        this.emit("sse", {
          type: "process_died",
          timestamp: new Date().toISOString(),
          reason: String(err),
        });
      }
    }

    // Query ended — clean up
    this.queryInstance = null;
    this.emit("process_ended");
  }

  // ── Message Routing ────────────────────────────────────────

  /**
   * Route a message from the SDK query generator.
   */
  private routeMessage(msg: SDKMessage): void {
    // Update activity tracking
    this.lastActivityTime = Date.now();

    switch (msg.type) {
      case "stream_event":
        this.handleStreamEvent(msg as SDKPartialAssistantMessage);
        break;

      case "assistant":
        // With includePartialMessages, stream_events arrive before this.
        this.log({
          type: "assistant",
          blocks: (msg as { message: { content: unknown[] } }).message.content.length,
        });
        break;

      case "user":
        this.handleUserMessage(msg as SDKUserMessage);
        break;

      case "result":
        this.handleResultMessage(msg as SDKResultMessage);
        break;

      case "system":
        this.handleSystemMessage(msg as unknown as Record<string, unknown>);
        break;

      default: {
        const anyMsg = msg as Record<string, unknown>;
        if (anyMsg.type === "tool_progress") {
          this.emit("sse", {
            type: "tool_progress",
            tool_use_id: anyMsg.tool_use_id,
            tool_name: anyMsg.tool_name,
            elapsed_time_seconds: anyMsg.elapsed_time_seconds,
          });
        } else {
          this.log({
            type: "unknown_message",
            messageType: msg.type,
            raw: msg as unknown as Record<string, unknown>,
          });
        }
        break;
      }
    }
  }

  /**
   * stream_event — unwrap the inner Anthropic SSE event and emit it.
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
   */
  private handleUserMessage(msg: SDKUserMessage): void {
    const content = msg.message.content;
    if (!content || typeof content === "string") return;

    const toolResults = (
      content as Array<{
        type: string;
        tool_use_id?: string;
        content?: unknown;
        is_error?: boolean;
      }>
    ).filter((c) => c.type === "tool_result");
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

  // ── Event State Tracking ──────────────────────────────────

  /**
   * Track SSE event state for interrupt cleanup and interactive tool detection.
   */
  private trackEventState(event: StreamEvent): void {
    if (event.type === "message_start") {
      this.messageOpen = true;
      this.openBlockIndices.clear();
      this.pendingInteractiveTools.clear();
      this.currentToolUseId = null;
      this.currentToolUseName = null;
    }
    if (event.type === "content_block_start" && typeof event.index === "number") {
      this.openBlockIndices.add(event.index);

      // Detect interactive tool calls
      const block = event.content_block as
        | { type?: string; id?: string; name?: string }
        | undefined;
      if (block?.type === "tool_use" && block.name && INTERACTIVE_TOOLS.has(block.name)) {
        this.currentToolUseId = block.id || null;
        this.currentToolUseName = block.name;
        if (this.currentToolUseId) {
          this.pendingInteractiveTools.set(this.currentToolUseId, {
            name: block.name,
            input: "",
          });
        }
        this.logger.info("Detected interactive tool", {
          name: block.name,
          id: block.id?.slice(0, 12),
        });
      } else {
        this.currentToolUseId = null;
        this.currentToolUseName = null;
      }
    }
    if (event.type === "content_block_delta") {
      // Accumulate input JSON for tracked interactive tools
      if (this.currentToolUseId) {
        const delta = event.delta as { type?: string; partial_json?: string } | undefined;
        if (delta?.type === "input_json_delta" && delta.partial_json) {
          const existing = this.pendingInteractiveTools.get(this.currentToolUseId);
          if (existing) {
            existing.input += delta.partial_json;
          }
        }
      }
    }
    if (event.type === "content_block_stop" && typeof event.index === "number") {
      this.openBlockIndices.delete(event.index);
      this.currentToolUseId = null;
      this.currentToolUseName = null;
    }
    if (event.type === "message_stop") {
      this.messageOpen = false;
      this.openBlockIndices.clear();

      // Auto-approve interactive tools after message completes
      if (this.pendingInteractiveTools.size > 0) {
        this.autoApproveInteractiveTools();
      }
    }
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
   * Auto-approve pending ExitPlanMode/EnterPlanMode tool calls.
   */
  private autoApproveInteractiveTools(): void {
    for (const [toolUseId, { name }] of this.pendingInteractiveTools) {
      if (name === "ExitPlanMode") {
        this.logger.info("Auto-approving ExitPlanMode", { toolUseId: toolUseId.slice(0, 12) });
        this.sendToolResult(
          toolUseId,
          "User has approved your plan. You can now start coding. Start with updating your todo list if applicable",
        );
      } else if (name === "EnterPlanMode") {
        this.logger.info("Auto-approving EnterPlanMode", { toolUseId: toolUseId.slice(0, 12) });
        this.sendToolResult(
          toolUseId,
          "Plan mode activated. Explore the codebase and design an approach.",
        );
      }
      // AskUserQuestion is NOT auto-approved — forwarded to UI
    }
  }

  // ── Cleanup ────────────────────────────────────────────────

  /**
   * Clean up query and channel state.
   */
  private cleanup(): void {
    if (this.messageChannel) {
      this.messageChannel.close();
      this.messageChannel = null;
    }

    if (this.queryInstance) {
      this.queryInstance.close();
      this.queryInstance = null;
    }

    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
  }

  // ── Logging ────────────────────────────────────────────────

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

export function createSDKSession(options: CreateSessionOptions): SDKSession {
  const id = randomUUID();
  return new SDKSession(id, options, false);
}

export function resumeSDKSession(sessionId: string, options: ResumeSessionOptions): SDKSession {
  return new SDKSession(sessionId, options, true);
}
