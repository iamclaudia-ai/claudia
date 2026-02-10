/**
 * Runtime Session Manager
 *
 * Manages all active RuntimeSession instances.
 * Provides create/resume/prompt/interrupt/close/list operations.
 * Forwards all SSE events from sessions to a callback for WS relay.
 *
 * Sessions are lazily resumed: if a prompt arrives for a session that
 * isn't running, the manager auto-resumes it (starts proxy + CLI process).
 * This means the runtime is self-healing after restarts — no persistence needed.
 */

import { EventEmitter } from "node:events";
import {
  RuntimeSession,
  createRuntimeSession,
  resumeRuntimeSession,
  type CreateSessionOptions,
  type ResumeSessionOptions,
} from "./session";
import type { StreamEvent } from "./proxy";

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
  /** Enable extended thinking */
  thinking?: boolean;
  /** Thinking budget tokens */
  thinkingBudget?: number;
}

export interface SessionResumeParams {
  /** Claude Code session UUID to resume */
  sessionId: string;
  /** Working directory */
  cwd: string;
  /** Model to use */
  model?: string;
  /** Enable extended thinking */
  thinking?: boolean;
  /** Thinking budget tokens */
  thinkingBudget?: number;
}

// ── Manager ──────────────────────────────────────────────────

export class RuntimeSessionManager extends EventEmitter {
  private sessions = new Map<string, RuntimeSession>();

  /**
   * Create a new Claude session.
   * Starts proxy, session ready for prompts.
   */
  async create(params: SessionCreateParams): Promise<{ sessionId: string; proxyPort: number }> {
    const options: CreateSessionOptions = {
      cwd: params.cwd,
      model: params.model,
      systemPrompt: params.systemPrompt,
      thinking: params.thinking,
      thinkingBudget: params.thinkingBudget,
    };

    const session = createRuntimeSession(options);
    await session.start();

    this.sessions.set(session.id, session);
    this.wireSession(session);

    console.log(`[Manager] Created session: ${session.id.slice(0, 8)} (proxy: ${session.proxyPort})`);
    return { sessionId: session.id, proxyPort: session.proxyPort };
  }

  /**
   * Resume an existing Claude session.
   * Starts proxy, session ready for prompts.
   */
  async resume(params: SessionResumeParams): Promise<{ sessionId: string; proxyPort: number }> {
    // Check if already active
    const existing = this.sessions.get(params.sessionId);
    if (existing?.isActive) {
      console.log(`[Manager] Session already active: ${params.sessionId.slice(0, 8)}`);
      return { sessionId: existing.id, proxyPort: existing.proxyPort };
    }

    const options: ResumeSessionOptions = {
      cwd: params.cwd,
      model: params.model,
      thinking: params.thinking,
      thinkingBudget: params.thinkingBudget,
    };

    const session = resumeRuntimeSession(params.sessionId, options);
    await session.start();

    this.sessions.set(session.id, session);
    this.wireSession(session);

    console.log(`[Manager] Resumed session: ${session.id.slice(0, 8)} (proxy: ${session.proxyPort})`);
    return { sessionId: session.id, proxyPort: session.proxyPort };
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
      console.log(`[Manager] Auto-resuming session: ${sessionId.slice(0, 8)} (cwd: ${cwd})`);
      await this.resume({ sessionId, cwd });
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
   * Close a session — stop proxy, kill process.
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
    proxyPort: number;
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

  private getActiveSession(sessionId: string): RuntimeSession {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    if (!session.isActive) {
      throw new Error(`Session not active: ${sessionId}`);
    }
    return session;
  }

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
