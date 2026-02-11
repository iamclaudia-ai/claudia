/**
 * Runtime Session Manager
 *
 * Manages all active RuntimeSession instances.
 * Provides create/resume/prompt/interrupt/close/list operations.
 * Forwards all SSE events from sessions to a callback for WS relay.
 * Routes CLI WebSocket connections to the appropriate session's bridge.
 *
 * Sessions are lazily resumed: if a prompt arrives for a session that
 * isn't running, the manager auto-resumes it (spawns CLI process).
 * This means the runtime is self-healing after restarts — no persistence needed.
 */

import { EventEmitter } from "node:events";
import type { ServerWebSocket } from "bun";
import {
  RuntimeSession,
  createRuntimeSession,
  resumeRuntimeSession,
  type CreateSessionOptions,
  type ResumeSessionOptions,
  type StreamEvent,
} from "./session";
import type { ClaudiaConfig } from "@claudia/shared";

// ── Types ────────────────────────────────────────────────────

export type ThinkingEffort = "low" | "medium" | "high" | "max";

export interface SessionCreateParams {
  /** Claude Code session UUID (if pre-assigned by gateway) */
  sessionId?: string;
  /** Working directory */
  cwd: string;
  /** Model to use */
  model?: string;
  /** System prompt */
  systemPrompt?: string;
  /** Enable adaptive thinking */
  thinking?: boolean;
  /** Thinking effort level */
  effort?: ThinkingEffort;
}

export interface SessionResumeParams {
  /** Claude Code session UUID to resume */
  sessionId: string;
  /** Working directory */
  cwd: string;
  /** Model to use */
  model?: string;
  /** Enable adaptive thinking */
  thinking?: boolean;
  /** Thinking effort level */
  effort?: ThinkingEffort;
}

// ── Manager ──────────────────────────────────────────────────

export class RuntimeSessionManager extends EventEmitter {
  private sessions = new Map<string, RuntimeSession>();
  private config?: ClaudiaConfig;
  private lastPromptedSessionId: string | null = null;

  /**
   * Set config for session defaults (model, thinking, etc.)
   * Used as fallback when lazy-resuming sessions.
   */
  setConfig(config: ClaudiaConfig): void {
    this.config = config;
  }

  /**
   * Create a new Claude session.
   * Session is ready for prompts immediately.
   */
  async create(
    params: SessionCreateParams,
  ): Promise<{ sessionId: string }> {
    const options: CreateSessionOptions = {
      cwd: params.cwd,
      model: params.model,
      systemPrompt: params.systemPrompt,
      thinking: params.thinking,
      effort: params.effort,
    };

    const session = createRuntimeSession(options);
    await session.start();

    this.sessions.set(session.id, session);
    this.wireSession(session);

    console.log(`[Manager] Created session: ${session.id.slice(0, 8)}`);
    return { sessionId: session.id };
  }

  /**
   * Resume an existing Claude session.
   * Session is ready for prompts immediately.
   */
  async resume(
    params: SessionResumeParams,
  ): Promise<{ sessionId: string }> {
    // Check if already active
    const existing = this.sessions.get(params.sessionId);
    if (existing?.isActive) {
      console.log(
        `[Manager] Session already active: ${params.sessionId.slice(0, 8)}`,
      );
      return { sessionId: existing.id };
    }

    const options: ResumeSessionOptions = {
      cwd: params.cwd,
      model: params.model,
      thinking: params.thinking,
      effort: params.effort,
    };

    const session = resumeRuntimeSession(params.sessionId, options);
    await session.start();

    this.sessions.set(session.id, session);
    this.wireSession(session);

    console.log(`[Manager] Resumed session: ${session.id.slice(0, 8)}`);
    return { sessionId: session.id };
  }

  /**
   * Send a prompt to a session.
   * If the session isn't running, auto-resumes it first (lazy start).
   */
  async prompt(
    sessionId: string,
    content: string | unknown[],
    cwd?: string,
  ): Promise<void> {
    let session = this.sessions.get(sessionId);

    if (!session || !session.isActive) {
      // Lazy resume — session died or runtime restarted
      if (!cwd) {
        throw new Error(
          `Session not found and no cwd provided for auto-resume: ${sessionId}`,
        );
      }
      const sessionConfig = this.config?.session;
      console.log(
        `[Manager] Auto-resuming session: ${sessionId.slice(0, 8)} (cwd: ${cwd}, model: ${sessionConfig?.model || "default"})`,
      );
      await this.resume({
        sessionId,
        cwd,
        model: sessionConfig?.model,
        thinking: sessionConfig?.thinking,
        effort: sessionConfig?.effort,
      });
      session = this.sessions.get(sessionId)!;
    }

    this.lastPromptedSessionId = sessionId;
    session.prompt(content);
  }

  /**
   * Get the session ID that most recently received a prompt.
   * Used to tag thinking proxy events with the correct session.
   */
  getActiveStreamingSession(): string | null {
    return this.lastPromptedSessionId;
  }

  /**
   * Interrupt a session's current response.
   */
  interrupt(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    session.interrupt();
    return true;
  }

  /**
   * Close a session — kill process.
   */
  async close(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    await session.close();
    this.sessions.delete(sessionId);
    console.log(`[Manager] Closed session: ${sessionId.slice(0, 8)}`);
  }

  /**
   * List all active sessions.
   */
  list(): Array<{
    id: string;
    cwd: string;
    model: string;
    isActive: boolean;
    isProcessRunning: boolean;
  }> {
    return Array.from(this.sessions.values()).map((s) => s.getInfo());
  }

  /**
   * Close all sessions — for graceful shutdown.
   */
  async closeAll(): Promise<void> {
    const promises = Array.from(this.sessions.keys()).map((id) =>
      this.close(id),
    );
    await Promise.all(promises);
  }

  // ── CLI WebSocket Routing ────────────────────────────────────

  /**
   * Route a CLI WebSocket connection to the appropriate session's bridge.
   * Called when Claude Code CLI connects via --sdk-url.
   */
  handleCliConnection(sessionId: string, ws: ServerWebSocket<unknown>): void {
    const session = this.sessions.get(sessionId);
    if (!session) {
      console.warn(
        `[Manager] CLI connected for unknown session: ${sessionId.slice(0, 8)}`,
      );
      return;
    }
    session.bridge.handleConnection(ws);
  }

  /**
   * Route a CLI WebSocket message to the appropriate session's bridge.
   */
  handleCliMessage(
    sessionId: string,
    message: string | Buffer,
  ): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.bridge.handleMessage(message);
  }

  /**
   * Handle CLI WebSocket disconnect.
   */
  handleCliClose(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.bridge.handleClose();
  }

  // ── Private ────────────────────────────────────────────────

  /**
   * Wire a session's events to this manager's EventEmitter.
   *
   * Uses a single "session.event" internal event for manager → WS server forwarding.
   * The eventName uses "stream.{sessionId}.{type}" prefix so streaming events
   * are cleanly separated from session request/response methods.
   */
  private wireSession(session: RuntimeSession): void {
    const sessionId = session.id;

    session.on("sse", (event: StreamEvent) => {
      this.emit("session.event", {
        eventName: `stream.${sessionId}.${event.type}`,
        sessionId,
        ...event,
      });
    });

    session.on("process_started", () => {
      this.emit("session.event", {
        eventName: `stream.${sessionId}.process_started`,
        sessionId,
        type: "process_started",
      });
    });

    session.on("process_ended", () => {
      this.emit("session.event", {
        eventName: `stream.${sessionId}.process_ended`,
        sessionId,
        type: "process_ended",
      });
    });

    session.on("closed", () => {
      this.sessions.delete(sessionId);
    });
  }
}
