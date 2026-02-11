/**
 * CLI WebSocket Bridge
 *
 * Handles the WebSocket connection from Claude Code CLI via --sdk-url.
 * Replaces the HTTP proxy approach — no more man-in-the-middle API interception.
 *
 * The CLI connects TO us, sends NDJSON messages, and we:
 * - Unwrap stream_event messages → emit as standard SSE events
 * - Auto-approve control_request messages (safety net for permissions)
 * - Track tool results from assistant messages
 * - Queue outgoing messages until CLI connects
 */

import { EventEmitter } from "node:events";
import type { ServerWebSocket } from "bun";
import fs from "node:fs";

// ── Types ────────────────────────────────────────────────────

export interface StreamEvent {
  type: string;
  [key: string]: unknown;
}

interface CliMessage {
  type: string;
  [key: string]: unknown;
}

// ── CliBridge ────────────────────────────────────────────────

export class CliBridge extends EventEmitter {
  private cliSocket: ServerWebSocket<unknown> | null = null;
  private pendingMessages: string[] = [];
  private _connected = false;
  private logFile?: string;

  constructor(options?: { logFile?: string }) {
    super();
    this.logFile = options?.logFile;
  }

  get connected(): boolean {
    return this._connected;
  }

  // ── WebSocket Handlers ──────────────────────────────────────

  /**
   * Called when Claude CLI connects via --sdk-url.
   */
  handleConnection(ws: ServerWebSocket<unknown>): void {
    this.cliSocket = ws;
    this._connected = true;
    console.log("[CliBridge] CLI connected");

    // Flush any queued messages (user prompts sent before CLI connected)
    if (this.pendingMessages.length > 0) {
      console.log(`[CliBridge] Flushing ${this.pendingMessages.length} queued message(s)`);
      for (const msg of this.pendingMessages) {
        this.sendRaw(msg);
      }
      this.pendingMessages = [];
    }
  }

  /**
   * Called when CLI sends a message (NDJSON — may contain multiple lines).
   */
  handleMessage(raw: string | Buffer): void {
    const data = typeof raw === "string" ? raw : raw.toString("utf-8");
    const lines = data.split("\n").filter((l) => l.trim());

    for (const line of lines) {
      try {
        const msg: CliMessage = JSON.parse(line);
        this.routeMessage(msg);
      } catch {
        console.warn("[CliBridge] Failed to parse CLI message:", line.substring(0, 200));
      }
    }
  }

  /**
   * Called when CLI disconnects.
   */
  handleClose(): void {
    this.cliSocket = null;
    this._connected = false;
    console.log("[CliBridge] CLI disconnected");
  }

  // ── Outgoing Messages ───────────────────────────────────────

  /**
   * Send a user message to the CLI.
   * Queues if CLI hasn't connected yet.
   */
  sendUserMessage(content: string | unknown[]): void {
    const message = JSON.stringify({
      type: "user",
      message: {
        role: "user",
        content,
      },
    });
    this.send(message);
  }

  /**
   * Send an interrupt request to the CLI.
   * Gracefully aborts the current agent turn via the WebSocket protocol
   * instead of killing the process.
   */
  sendInterrupt(): void {
    if (!this.cliSocket) return;

    const message = JSON.stringify({
      type: "control_request",
      request_id: crypto.randomUUID(),
      request: { subtype: "interrupt" },
    });
    this.sendRaw(message);
  }

  // ── Message Routing ─────────────────────────────────────────

  private routeMessage(msg: CliMessage): void {
    switch (msg.type) {
      case "stream_event":
        this.handleStreamEvent(msg);
        break;

      case "assistant":
        this.handleAssistantMessage(msg);
        break;

      case "user":
        this.handleUserMessage(msg);
        break;

      case "result":
        this.handleResultMessage(msg);
        break;

      case "control_request":
        this.handleControlRequest(msg);
        break;

      case "system":
        this.handleSystemMessage(msg);
        break;

      case "keep_alive":
        // Silently consume
        break;

      default:
        // Log unknown message types for debugging
        this.log({ type: "unknown_cli_message", messageType: msg.type, raw: msg });
        break;
    }
  }

  /**
   * stream_event — unwrap the inner Anthropic SSE event and emit it.
   * This preserves the exact format the gateway expects.
   *
   * CLI sends:  { type: "stream_event", event: { type: "content_block_delta", ... } }
   * We emit:    { type: "content_block_delta", ... }
   */
  private handleStreamEvent(msg: CliMessage): void {
    const event = msg.event as StreamEvent | undefined;
    if (!event) return;

    this.log(event);
    this.emit("sse", event);
  }

  /**
   * assistant — complete assistant message with content blocks.
   *
   * With --include-partial-messages, real stream_event messages arrive BEFORE
   * this assistant message, so we DON'T need to synthesize SSE events.
   * Logged for debugging but no events emitted (streaming handles it).
   */
  private handleAssistantMessage(msg: CliMessage): void {
    const message = msg.message as Record<string, unknown> | undefined;
    if (!message) return;

    const content = message.content as Array<Record<string, unknown>> | undefined;
    if (!content) return;

    this.log({ type: "assistant", blocks: content.length });
  }

  /**
   * user — user message with tool_result blocks.
   *
   * After Claude calls tools, the CLI executes them and sends the results
   * back as a user message containing tool_result content blocks.
   * We extract these and emit as request_tool_results events so the UI
   * can display tool output in the tool call badges.
   */
  private handleUserMessage(msg: CliMessage): void {
    const message = msg.message as Record<string, unknown> | undefined;
    if (!message) return;

    const content = message.content as Array<Record<string, unknown>> | undefined;
    if (!content) return;

    // Extract tool results
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
   * Emitted when the CLI finishes processing a prompt.
   */
  private handleResultMessage(msg: CliMessage): void {
    const stopReason = (msg.stop_reason as string) || (msg.subtype as string) || "end_turn";

    // Emit turn_stop (matches what proxy emitted)
    this.emit("sse", {
      type: "turn_stop",
      timestamp: new Date().toISOString(),
      stop_reason: stopReason,
      duration_ms: msg.duration_ms,
      num_turns: msg.num_turns,
      usage: msg.usage,
      cost_usd: msg.total_cost_usd,
    });

    this.log({ ...msg, logged_as: "result" });
  }

  /**
   * control_request — permission request from CLI.
   * With --permission-mode bypassPermissions these shouldn't appear,
   * but auto-approve as a safety net.
   */
  private handleControlRequest(msg: CliMessage): void {
    const requestId = msg.request_id as string;
    const request = msg.request as Record<string, unknown> | undefined;

    if (!requestId || !request) return;

    console.log(`[CliBridge] Control request: ${request.subtype} (auto-approving)`);

    // Auto-approve with original input
    const response = JSON.stringify({
      type: "control_response",
      response: {
        subtype: "success",
        request_id: requestId,
        response: {
          behavior: "allow",
          updatedInput: request.input || {},
        },
      },
    });

    this.send(response);
  }

  /**
   * system — initialization message from CLI with capabilities.
   */
  private handleSystemMessage(msg: CliMessage): void {
    console.log("[CliBridge] System message:", JSON.stringify(msg).substring(0, 200));
    this.log({ ...msg, logged_as: "system" });
  }

  // ── Transport ───────────────────────────────────────────────

  private send(data: string): void {
    if (!this.cliSocket) {
      this.pendingMessages.push(data);
      return;
    }
    this.sendRaw(data);
  }

  private sendRaw(data: string): void {
    try {
      // NDJSON: append newline delimiter
      this.cliSocket!.send(data + "\n");
    } catch (err) {
      console.error("[CliBridge] Failed to send to CLI:", err);
    }
  }

  // ── Logging ─────────────────────────────────────────────────

  private log(event: Record<string, unknown>): void {
    if (!this.logFile) return;
    try {
      fs.appendFileSync(this.logFile, JSON.stringify(event) + "\n");
    } catch {
      // Ignore log errors
    }
  }
}
