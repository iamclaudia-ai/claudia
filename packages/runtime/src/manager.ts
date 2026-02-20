/**
 * Runtime Session Manager
 *
 * Manages all active RuntimeSession instances.
 * Provides create/resume/prompt/interrupt/close/list operations.
 * Forwards all SSE events from sessions to a callback for WS relay.
 *
 * Sessions are lazily resumed: if a prompt arrives for a session that
 * isn't running, the manager auto-resumes it (spawns CLI process).
 * This means the runtime is self-healing after restarts — no persistence needed.
 */

import { EventEmitter } from "node:events";
import {
  RuntimeSession,
  createRuntimeSession,
  resumeRuntimeSession,
  type CreateSessionOptions,
  type ResumeSessionOptions,
  type StreamEvent,
} from "./session";
import { SDKSession, createSDKSession, resumeSDKSession } from "./sdk-session";
import { createLogger } from "@claudia/shared";
import type { ClaudiaConfig, ThinkingEffort } from "@claudia/shared";

/** Union of both session engine types — same public interface */
type SessionInstance = RuntimeSession | SDKSession;
import { join } from "node:path";
import { homedir } from "node:os";

const log = createLogger("Manager", join(homedir(), ".claudia", "logs", "runtime.log"));

// ── Types ────────────────────────────────────────────────────

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
  private sessions = new Map<string, SessionInstance>();
  private config?: ClaudiaConfig;

  /**
   * Set config for session defaults (model, thinking, etc.)
   * Used as fallback when lazy-resuming sessions.
   */
  setConfig(config: ClaudiaConfig): void {
    this.config = config;
  }

  /**
   * Get the session engine type from config.
   * Defaults to "cli" (RuntimeSession) for backwards compatibility.
   */
  private get engine(): "cli" | "sdk" {
    return (this.config?.runtime as { engine?: "cli" | "sdk" })?.engine || "cli";
  }

  /**
   * Create a new Claude session.
   * Session is ready for prompts immediately.
   */
  async create(params: SessionCreateParams): Promise<{ sessionId: string }> {
    const options: CreateSessionOptions = {
      cwd: params.cwd,
      model: params.model,
      systemPrompt: params.systemPrompt,
      thinking: params.thinking,
      effort: params.effort,
    };

    const session =
      this.engine === "sdk" ? createSDKSession(options) : createRuntimeSession(options);
    await session.start();

    this.sessions.set(session.id, session);
    this.wireSession(session);

    log.info("Created session", { sessionId: session.id.slice(0, 8), engine: this.engine });
    return { sessionId: session.id };
  }

  /**
   * Resume an existing Claude session.
   * Session is ready for prompts immediately.
   */
  async resume(params: SessionResumeParams): Promise<{ sessionId: string }> {
    // Check if already active
    const existing = this.sessions.get(params.sessionId);
    if (existing?.isActive) {
      log.info("Session already active", { sessionId: params.sessionId.slice(0, 8) });
      return { sessionId: existing.id };
    }

    const options: ResumeSessionOptions = {
      cwd: params.cwd,
      model: params.model,
      thinking: params.thinking,
      effort: params.effort,
    };

    const session =
      this.engine === "sdk"
        ? resumeSDKSession(params.sessionId, options)
        : resumeRuntimeSession(params.sessionId, options);
    await session.start();

    this.sessions.set(session.id, session);
    this.wireSession(session);

    log.info("Resumed session", { sessionId: session.id.slice(0, 8), engine: this.engine });
    return { sessionId: session.id };
  }

  /**
   * Send a prompt to a session.
   * If the session isn't running, auto-resumes it first (lazy start).
   */
  async prompt(sessionId: string, content: string | unknown[], cwd?: string): Promise<void> {
    let session = this.sessions.get(sessionId);

    if (!session || !session.isActive) {
      // Lazy resume — session died or runtime restarted
      if (!cwd) {
        throw new Error(`Session not found and no cwd provided for auto-resume: ${sessionId}`);
      }
      const sessionConfig = this.config?.session;
      log.info("Auto-resuming session", {
        sessionId: sessionId.slice(0, 8),
        cwd,
        model: sessionConfig?.model || "default",
      });
      await this.resume({
        sessionId,
        cwd,
        model: sessionConfig?.model,
        thinking: sessionConfig?.thinking,
        effort: sessionConfig?.effort,
      });
      session = this.sessions.get(sessionId)!;
    }

    session.prompt(content);
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
   * Set the permission mode for a session's CLI process.
   */
  setPermissionMode(sessionId: string, mode: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    session.setPermissionMode(mode);
    return true;
  }

  /**
   * Send a tool_result for an interactive tool (ExitPlanMode, etc.).
   */
  sendToolResult(sessionId: string, toolUseId: string, content: string, isError = false): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    session.sendToolResult(toolUseId, content, isError);
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
    log.info("Closed session", { sessionId: sessionId.slice(0, 8) });
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
    const promises = Array.from(this.sessions.keys()).map((id) => this.close(id));
    await Promise.all(promises);
  }

  // ── Private ────────────────────────────────────────────────

  /**
   * Wire a session's events to this manager's EventEmitter.
   *
   * Uses a single "session.event" internal event for manager → WS server forwarding.
   * The eventName uses "stream.{sessionId}.{type}" prefix so streaming events
   * are cleanly separated from session request/response methods.
   */
  private wireSession(session: SessionInstance): void {
    const sessionId = session.id;
    // Cast to EventEmitter for .on() — both session types extend EventEmitter
    // with identical event signatures, but TS can't unify the union's .on() overloads.
    const emitter = session as EventEmitter;

    emitter.on("sse", (event: StreamEvent) => {
      this.emit("session.event", {
        eventName: `stream.${sessionId}.${event.type}`,
        sessionId,
        ...event,
      });
    });

    emitter.on("process_started", () => {
      this.emit("session.event", {
        eventName: `stream.${sessionId}.process_started`,
        sessionId,
        type: "process_started",
      });
    });

    emitter.on("process_ended", () => {
      this.emit("session.event", {
        eventName: `stream.${sessionId}.process_ended`,
        sessionId,
        type: "process_ended",
      });
    });

    emitter.on("closed", () => {
      this.sessions.delete(sessionId);
    });
  }
}
