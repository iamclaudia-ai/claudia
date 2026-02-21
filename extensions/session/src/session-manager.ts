/**
 * Session Manager (SDK only)
 *
 * Manages all active SDKSession instances.
 * Simplified from packages/runtime/src/manager.ts — no CLI engine, no dual-engine selection.
 *
 * Provides create/resume/prompt/interrupt/close/list operations.
 * Forwards all SSE events from sessions via callback for gateway event relay.
 */

import { EventEmitter } from "node:events";
import {
  SDKSession,
  createSDKSession,
  resumeSDKSession,
  type CreateSessionOptions,
  type ResumeSessionOptions,
  type StreamEvent,
} from "./sdk-session";
import { createLogger } from "@claudia/shared";
import type { ThinkingEffort } from "@claudia/shared";
import { join } from "node:path";
import { homedir } from "node:os";

const log = createLogger("SessionManager", join(homedir(), ".claudia", "logs", "session.log"));

// ── Types ────────────────────────────────────────────────────

export interface SessionCreateParams {
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

/** Session defaults from config */
export interface SessionDefaults {
  model?: string;
  thinking?: boolean;
  effort?: ThinkingEffort;
}

// ── Manager ──────────────────────────────────────────────────

export class SessionManager extends EventEmitter {
  private sessions = new Map<string, SDKSession>();
  private defaults: SessionDefaults = {};

  /**
   * Set session defaults for lazy-resume fallback.
   */
  setDefaults(defaults: SessionDefaults): void {
    this.defaults = defaults;
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

    const session = createSDKSession(options);
    await session.start();

    this.sessions.set(session.id, session);
    this.wireSession(session);

    log.info("Created session", { sessionId: session.id.slice(0, 8) });
    return { sessionId: session.id };
  }

  /**
   * Resume an existing Claude session.
   * SDK handles resume via `resume: sessionId` option — no custom lazy-resume logic.
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

    const session = resumeSDKSession(params.sessionId, options);
    await session.start();

    this.sessions.set(session.id, session);
    this.wireSession(session);

    log.info("Resumed session", { sessionId: session.id.slice(0, 8) });
    return { sessionId: session.id };
  }

  /**
   * Send a prompt to a session.
   * If the session isn't running, auto-resumes it first (lazy start).
   */
  async prompt(sessionId: string, content: string | unknown[], cwd?: string): Promise<void> {
    let session = this.sessions.get(sessionId);

    if (!session || !session.isActive) {
      // Lazy resume — session died or extension restarted
      if (!cwd) {
        throw new Error(`Session not found and no cwd provided for auto-resume: ${sessionId}`);
      }
      log.info("Auto-resuming session", {
        sessionId: sessionId.slice(0, 8),
        cwd,
        model: this.defaults.model || "default",
      });
      await this.resume({
        sessionId,
        cwd,
        model: this.defaults.model,
        thinking: this.defaults.thinking,
        effort: this.defaults.effort,
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
   * Close a session — kill process via query.close().
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
  list(): Array<ReturnType<SDKSession["getInfo"]>> {
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
   * Uses a single "session.event" internal event for manager → extension forwarding.
   * The eventName uses "stream.{sessionId}.{type}" prefix so streaming events
   * are cleanly separated from session request/response methods.
   */
  private wireSession(session: SDKSession): void {
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
