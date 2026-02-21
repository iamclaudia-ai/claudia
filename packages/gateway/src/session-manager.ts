/**
 * Session Manager
 *
 * Manages workspace-aware session lifecycle. Uses the session runtime
 * service for Claude process management, communicating via WebSocket
 * with the same req/res/event protocol used throughout Claudia.
 *
 * Supports two modes:
 * - VS Code: auto-discover workspace by CWD, auto-create if needed
 * - Web: explicit session selection via session ID
 */

import type { Database } from "bun:sqlite";
import type { Workspace, SessionRecord, GatewayEvent, ClaudiaConfig } from "@claudia/shared";
import type { Request, Event, Message } from "@claudia/shared";
import { createLogger } from "@claudia/shared";
import { existsSync, readFileSync, readdirSync, unlinkSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const log = createLogger("SessionManager", join(homedir(), ".claudia", "logs", "gateway.log"));

import * as workspaceModel from "./db/models/workspace";
import * as sessionModel from "./db/models/session";
import {
  parseSessionFile,
  parseSessionFilePaginated,
  parseSessionUsage,
  resolveSessionPath,
} from "./parse-session";

export interface SessionManagerOptions {
  db: Database;
  dataDir: string;
  config: ClaudiaConfig;
  broadcastEvent: (eventName: string, payload: unknown, source?: string) => void;
  broadcastExtension: (event: GatewayEvent) => void;
  routeToSource: (source: string, event: GatewayEvent) => void;
}

export class SessionManager {
  private db: Database;
  private dataDir: string;
  private config: ClaudiaConfig;
  private broadcastEvent: SessionManagerOptions["broadcastEvent"];
  private broadcastExtension: SessionManagerOptions["broadcastExtension"];
  private routeToSource: SessionManagerOptions["routeToSource"];

  // Runtime WebSocket connection
  private runtimeWs: WebSocket | null = null;
  private runtimeConnected = false;
  private runtimeReconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingRequests = new Map<
    string,
    {
      resolve: (payload: unknown) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();

  // Active session tracking (which ccSessionId is active in the runtime)
  private activeRuntimeSessionId: string | null = null;

  // Current workspace/session state
  private currentWorkspace: Workspace | null = null;
  private currentSessionRecord: SessionRecord | null = null;

  // Per-runtime-session request context
  private requestContextByCcSessionId = new Map<
    string,
    {
      wantsVoice: boolean;
      source: string | null;
      connectionId: string | null;
      responseText: string;
      /** When streaming=false, resolves the prompt() promise with accumulated text */
      completeResolver: ((text: string) => void) | null;
    }
  >();

  // Session config (can be set before first prompt)
  pendingSessionConfig: { thinking?: boolean; effort?: string } = {};

  constructor(options: SessionManagerOptions) {
    this.db = options.db;
    this.dataDir = options.dataDir;
    this.config = options.config;
    this.broadcastEvent = options.broadcastEvent;
    this.broadcastExtension = options.broadcastExtension;
    this.routeToSource = options.routeToSource;
  }

  private getRuntimeSessionDefaults(): {
    model?: string;
    thinking?: boolean;
    effort?: string;
  } {
    return {
      model: this.config.session.model || undefined,
      thinking: this.config.session.thinking,
      effort: this.config.session.effort,
    };
  }

  private getRequestContext(ccSessionId: string): {
    wantsVoice: boolean;
    source: string | null;
    connectionId: string | null;
    responseText: string;
    completeResolver: ((text: string) => void) | null;
  } {
    const existing = this.requestContextByCcSessionId.get(ccSessionId);
    if (existing) return existing;

    const fallback = {
      wantsVoice: false,
      source: null,
      connectionId: null,
      responseText: "",
      completeResolver: null,
    };
    this.requestContextByCcSessionId.set(ccSessionId, fallback);
    return fallback;
  }

  getConnectionIdForSession(ccSessionId: string): string | null {
    return this.requestContextByCcSessionId.get(ccSessionId)?.connectionId ?? null;
  }

  // ── Runtime Connection ──────────────────────────────────────

  /**
   * Connect to the session runtime service via WebSocket.
   * Auto-reconnects on disconnect.
   */
  connectToRuntime(): void {
    const host = this.config.runtime?.host || "localhost";
    const port = this.config.runtime?.port || 30087;
    const url = `ws://${host}:${port}/ws`;

    log.info(` Connecting to runtime: ${url}`);

    const ws = new WebSocket(url);

    ws.onopen = () => {
      log.info(" Connected to runtime ✓");
      this.runtimeConnected = true;
      this.runtimeWs = ws;

      // Subscribe to all streaming events from runtime
      this.runtimeSend({
        type: "req",
        id: crypto.randomUUID(),
        method: "subscribe",
        params: { events: ["stream.*"] },
      });

      // Check for existing runtime sessions and reconcile
      this.reconcileRuntimeSessions();
    };

    ws.onmessage = (event) => {
      try {
        const message: Message = JSON.parse(event.data as string);
        this.handleRuntimeMessage(message);
      } catch (error) {
        log.error(" Failed to parse runtime message:", error);
      }
    };

    ws.onclose = () => {
      log.info(" Runtime disconnected");
      this.runtimeConnected = false;
      this.runtimeWs = null;

      // Reject pending requests
      for (const [_id, pending] of this.pendingRequests) {
        clearTimeout(pending.timer);
        pending.reject(new Error("Runtime disconnected"));
      }
      this.pendingRequests.clear();

      // Schedule reconnect
      this.scheduleReconnect();
    };

    ws.onerror = (error) => {
      log.error(" Runtime WebSocket error:", error);
    };
  }

  private scheduleReconnect(): void {
    if (this.runtimeReconnectTimer) return;
    this.runtimeReconnectTimer = setTimeout(() => {
      this.runtimeReconnectTimer = null;
      this.connectToRuntime();
    }, 2000);
  }

  private runtimeSend(message: Message): void {
    if (!this.runtimeWs || this.runtimeWs.readyState !== WebSocket.OPEN) {
      throw new Error("Runtime not connected");
    }
    this.runtimeWs.send(JSON.stringify(message));
  }

  /**
   * Send a request to the runtime and wait for the response.
   */
  private runtimeRequest(method: string, params?: Record<string, unknown>): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.runtimeConnected) {
        reject(new Error("Runtime not connected"));
        return;
      }

      const id = crypto.randomUUID();
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`Runtime request timeout: ${method}`));
      }, 30000);

      this.pendingRequests.set(id, { resolve, reject, timer });

      this.runtimeSend({
        type: "req",
        id,
        method,
        params,
      } as Request);
    });
  }

  /**
   * Handle messages from the runtime WebSocket.
   */
  private handleRuntimeMessage(message: Message): void {
    if (message.type === "res") {
      // Response to a pending request
      const pending = this.pendingRequests.get(message.id);
      if (pending) {
        clearTimeout(pending.timer);
        this.pendingRequests.delete(message.id);
        if (message.ok) {
          pending.resolve(message.payload);
        } else {
          pending.reject(new Error(message.error || "Runtime error"));
        }
      }
    } else if (message.type === "event") {
      // SSE event from a runtime session
      this.handleRuntimeEvent(message);
    }
  }

  /**
   * Handle SSE events forwarded from the runtime.
   *
   * Events arrive as: stream.{sessionId}.{eventType}
   * We broadcast with the same name pattern to gateway clients.
   * Extensions receive events via the generic "session.{eventType}" pattern.
   */
  private handleRuntimeEvent(event: Event): void {
    const eventPayload = event.payload as Record<string, unknown>;
    const sessionId = eventPayload.sessionId as string;
    const eventType = eventPayload.type as string;

    // stream.{sessionId}.{eventType} — session-scoped for client subscriptions
    const streamEventName = event.event;
    // session.{eventType} — generic for extensions
    const genericEventName = `session.${eventType}`;

    // ── Streaming event logging ──
    if (eventType === "message_start") {
      log.info(`[Stream] ▶ message_start (session: ${sessionId?.slice(0, 8)}…)`);
    } else if (eventType === "message_stop") {
      log.info(`[Stream] ■ message_stop`);
    } else if (eventType === "content_block_start") {
      const block = eventPayload.content_block as { type: string; name?: string } | undefined;
      const label =
        block?.type === "tool_use" ? `tool_use(${block.name})` : block?.type || "unknown";
      log.info(`[Stream]   ┌ content_block_start: ${label}`);
    } else if (eventType === "content_block_stop") {
      log.info(`[Stream]   └ content_block_stop`);
    } else if (eventType === "api_error") {
      log.error(`[Stream] ✖ API ERROR ${eventPayload.status}: ${eventPayload.message}`);
    } else if (eventType === "api_warning") {
      log.warn(
        `[Stream] ⚠ API RETRY attempt ${eventPayload.attempt}/${eventPayload.maxRetries}: ${eventPayload.message}`,
      );
    } else if (eventType === "turn_stop") {
      const stopReason = eventPayload.stop_reason as string | undefined;
      const numTurns = eventPayload.num_turns as number | undefined;
      log.info(`[Stream] ⏹ turn_stop (reason: ${stopReason}, turns: ${numTurns})`);
    } else if (eventType === "compaction_start") {
      log.info(`[Stream] ⚡ compaction_start (session: ${sessionId?.slice(0, 8)}…)`);
    } else if (eventType === "compaction_end") {
      log.info(
        `[Stream] ✓ compaction_end (trigger: ${eventPayload.trigger}, pre_tokens: ${eventPayload.pre_tokens})`,
      );
    }

    const requestContext = this.getRequestContext(sessionId);

    const payload = {
      sessionId,
      source: requestContext.source,
      connectionId: requestContext.connectionId,
      ...eventPayload,
    };

    // Accumulate text for source routing
    if (eventType === "content_block_start") {
      const block = eventPayload.content_block as { type: string } | undefined;
      if (block?.type === "text") {
        requestContext.responseText = "";
      }
    } else if (eventType === "content_block_delta") {
      const delta = eventPayload.delta as { type: string; text?: string } | undefined;
      if (delta?.type === "text_delta" && delta.text) {
        requestContext.responseText += delta.text;
      }
    }

    // Broadcast to WebSocket clients
    // stream.{sessionId}.{eventType} — scoped, only matching session subscribers
    this.broadcastEvent(streamEventName, payload, "session");

    // Build gateway event for extensions (always uses generic name)
    const gatewayEvent: GatewayEvent = {
      type: genericEventName,
      payload: {
        ...payload,
        speakResponse: requestContext.wantsVoice,
        responseText: eventType === "message_stop" ? requestContext.responseText : undefined,
      },
      timestamp: Date.now(),
      origin: "session",
      source: requestContext.source || undefined,
      sessionId,
      connectionId: requestContext.connectionId || undefined,
    };

    // Broadcast to extensions
    this.broadcastExtension(gatewayEvent);

    // On message complete, route to source if applicable
    if (eventType === "message_stop" && requestContext.source) {
      this.routeToSource(requestContext.source, gatewayEvent);
      requestContext.responseText = "";
    }

    // Non-streaming mode: resolve on turn_stop (after all tool calls complete),
    // not message_stop (which fires after each individual assistant message).
    if (eventType === "turn_stop" && requestContext.completeResolver) {
      requestContext.completeResolver(requestContext.responseText);
      requestContext.completeResolver = null;
      requestContext.responseText = "";
    }
  }

  /**
   * On runtime connect, check for existing sessions and reconcile.
   */
  private async reconcileRuntimeSessions(): Promise<void> {
    try {
      const result = (await this.runtimeRequest("session.list")) as {
        sessions: Array<{ id: string }>;
      };
      if (result.sessions?.length > 0) {
        log.info(` Runtime has ${result.sessions.length} active session(s)`);
        // TODO: reconcile with SQLite records
      }
    } catch (error) {
      log.warn(" Failed to reconcile runtime sessions:", error);
    }
  }

  get isRuntimeConnected(): boolean {
    return this.runtimeConnected;
  }

  // ── Workspace Operations ───────────────────────────────────

  listWorkspaces(): Workspace[] {
    return workspaceModel.listWorkspaces(this.db);
  }

  getWorkspace(id: string): Workspace | null {
    return workspaceModel.getWorkspace(this.db, id);
  }

  getOrCreateWorkspace(cwd: string, name?: string): { workspace: Workspace; created: boolean } {
    const result = workspaceModel.getOrCreateWorkspace(this.db, cwd, name);

    if (result.created) {
      this.discoverSessionsForWorkspace(result.workspace);
    }

    if (!this.currentWorkspace || this.currentWorkspace.cwd === cwd) {
      this.currentWorkspace = workspaceModel.getWorkspace(this.db, result.workspace.id);
    }

    return {
      workspace: workspaceModel.getWorkspace(this.db, result.workspace.id)!,
      created: result.created,
    };
  }

  getCurrentWorkspace(): Workspace | null {
    return this.currentWorkspace;
  }

  // ── Session Operations ─────────────────────────────────────

  listSessions(workspaceId: string): SessionRecord[] {
    return sessionModel.listSessions(this.db, workspaceId);
  }

  getSession(sessionId: string): SessionRecord | null {
    return sessionModel.getSession(this.db, sessionId);
  }

  getCurrentSession(): { sessionId: string | null; record: SessionRecord | null } {
    return { sessionId: this.activeRuntimeSessionId, record: this.currentSessionRecord };
  }

  /**
   * Initialize or resume a session via the runtime.
   */
  async initSession(
    sessionRecordId: string,
    runtimeConfig: { model: string; thinking: boolean; effort: string },
  ): Promise<string> {
    const record = sessionModel.getSession(this.db, sessionRecordId);
    if (!record) throw new Error(`Session not found: ${sessionRecordId}`);

    // Already active?
    if (
      this.activeRuntimeSessionId === record.ccSessionId &&
      this.currentSessionRecord?.id === record.id
    ) {
      return record.ccSessionId;
    }

    // Track the foreground session (don't close the previous one — it may still
    // be processing in the background, e.g. Libby's memory pipeline).
    // The runtime supports multiple concurrent CLI sessions; stream routing is
    // already session-scoped via stream.{sessionId}.{eventType}.

    // Set workspace context
    this.currentWorkspace = workspaceModel.getWorkspace(this.db, record.workspaceId);
    const cwd = this.currentWorkspace?.cwd;
    if (!cwd) throw new Error(`Workspace not found for session: ${record.workspaceId}`);

    // Resume in runtime with explicit per-request config.
    log.info(`[SessionManager] Resuming session via runtime: ${record.ccSessionId} (cwd: ${cwd})`);
    await this.runtimeRequest("session.resume", {
      sessionId: record.ccSessionId,
      cwd,
      model: runtimeConfig.model,
      thinking: runtimeConfig.thinking,
      effort: runtimeConfig.effort,
    });

    this.activeRuntimeSessionId = record.ccSessionId;
    this.currentSessionRecord = record;
    return record.ccSessionId;
  }

  /**
   * Create a new session, archiving the current active one.
   */
  async createNewSession(
    workspaceId: string,
    title: string | undefined,
    runtimeConfig: {
      model: string;
      thinking: boolean;
      effort: string;
      systemPrompt?: string | null;
    },
  ): Promise<{
    session: SessionRecord;
    previousSessionId?: string;
  }> {
    const wsId = workspaceId;

    // Don't close the previous runtime session — it may still be processing
    // in the background (e.g. Libby). The runtime supports concurrent sessions.
    this.activeRuntimeSessionId = null;

    // Archive current active session
    let previousSessionId: string | undefined;
    const workspace = workspaceModel.getWorkspace(this.db, wsId);
    if (!workspace) throw new Error(`Workspace not found: ${wsId}`);

    if (workspace.activeSessionId) {
      sessionModel.archiveSession(this.db, workspace.activeSessionId);
      previousSessionId = workspace.activeSessionId;
    }

    // Create session in runtime
    const thinking = runtimeConfig.thinking;
    const effort = runtimeConfig.effort;
    const model = runtimeConfig.model;

    log.info(
      `[SessionManager] Creating new session via runtime (model: ${model}, thinking: ${thinking}, effort: ${effort}, cwd: ${workspace.cwd})...`,
    );

    const result = (await this.runtimeRequest("session.create", {
      cwd: workspace.cwd,
      model,
      systemPrompt: runtimeConfig.systemPrompt || undefined,
      thinking,
      effort,
    })) as { sessionId: string };

    this.activeRuntimeSessionId = result.sessionId;

    // Record in DB
    const record = sessionModel.createSessionRecord(this.db, {
      workspaceId: wsId,
      ccSessionId: result.sessionId,
      title,
      previousSessionId,
    });

    workspaceModel.setActiveSession(this.db, wsId, record.id);
    this.currentSessionRecord = record;
    this.currentWorkspace = workspaceModel.getWorkspace(this.db, wsId);

    // Clear pending config
    this.pendingSessionConfig = {};

    log.info(` Created session: ${result.sessionId} (${record.id})`);
    return { session: record, previousSessionId };
  }

  /**
   * Switch to a different session.
   */
  async switchSession(sessionId: string): Promise<SessionRecord> {
    const record = sessionModel.getSession(this.db, sessionId);
    if (!record) throw new Error(`Session not found: ${sessionId}`);

    // Don't close the previous runtime session — it may still be processing
    // in the background. Just switch the foreground tracking.

    // Get workspace for CWD
    const workspace = workspaceModel.getWorkspace(this.db, record.workspaceId);
    if (!workspace) throw new Error(`Workspace not found: ${record.workspaceId}`);

    // Resume in runtime
    log.info(
      `[SessionManager] Switching to session via runtime: ${record.ccSessionId} (cwd: ${workspace.cwd})`,
    );
    await this.runtimeRequest("session.resume", {
      sessionId: record.ccSessionId,
      cwd: workspace.cwd,
      ...this.getRuntimeSessionDefaults(),
    });

    this.activeRuntimeSessionId = record.ccSessionId;
    this.currentSessionRecord = record;

    // Update workspace active session
    workspaceModel.setActiveSession(this.db, record.workspaceId, record.id);
    this.currentWorkspace = workspace;

    // Mark as active if archived
    if (record.status === "archived") {
      this.db.query("UPDATE sessions SET status = 'active' WHERE id = ?").run(record.id);
      this.currentSessionRecord = sessionModel.getSession(this.db, record.id);
    }

    return this.currentSessionRecord!;
  }

  /**
   * Get session history from JSONL file with optional pagination.
   */
  getSessionHistory(sessionId: string, options?: { limit?: number; offset?: number }) {
    let ccSessionId: string | undefined;

    const record = sessionModel.getSession(this.db, sessionId);
    ccSessionId = record?.ccSessionId;

    if (!ccSessionId) {
      return { messages: [], usage: null, total: 0, hasMore: false };
    }

    const sessionPath = resolveSessionPath(ccSessionId);
    if (!sessionPath) {
      log.warn(`[SessionManager] Session JSONL not found for: ${ccSessionId}`);
      return { messages: [], usage: null, total: 0, hasMore: false };
    }

    try {
      const usage = parseSessionUsage(sessionPath);

      if (options?.limit) {
        const { messages, total, hasMore } = parseSessionFilePaginated(sessionPath, {
          limit: options.limit,
          offset: options.offset || 0,
        });
        log.info(
          `[SessionManager] Loaded ${messages.length}/${total} messages (offset: ${options.offset || 0}, hasMore: ${hasMore})`,
        );
        return { messages, usage, total, hasMore };
      }

      const messages = parseSessionFile(sessionPath);
      log.info(` Loaded ${messages.length} messages from history`);
      return { messages, usage, total: messages.length, hasMore: false };
    } catch (err) {
      log.error(" Failed to parse session history:", err);
      return { messages: [], usage: null, total: 0, hasMore: false };
    }
  }

  /**
   * Send a prompt to a session via the runtime.
   *
   * When streaming=true (default): returns immediately with ccSessionId.
   * Events stream to clients via broadcastEvent.
   *
   * When streaming=false: returns a Promise that resolves with the
   * accumulated response text when message_stop fires.
   */
  async prompt(
    content: string | unknown[],
    sessionRecordId: string,
    runtimeConfig: { model: string; thinking: boolean; effort: string },
    requestContext?: {
      wantsVoice: boolean;
      source: string | null;
      connectionId: string | null;
      streaming?: boolean;
    },
  ): Promise<{ ccSessionId: string; text?: string }> {
    const streaming = requestContext?.streaming ?? true;
    const ccSessionId = await this.initSession(sessionRecordId, runtimeConfig);

    // Create a promise that resolves when message_stop fires (non-streaming mode)
    let completeResolver: ((text: string) => void) | null = null;
    const completionPromise = streaming
      ? null
      : new Promise<string>((resolve) => {
          completeResolver = resolve;
        });

    const existingContext = this.getRequestContext(ccSessionId);
    this.requestContextByCcSessionId.set(ccSessionId, {
      wantsVoice: requestContext?.wantsVoice ?? existingContext.wantsVoice,
      source: requestContext?.source ?? existingContext.source,
      connectionId: requestContext?.connectionId ?? existingContext.connectionId,
      responseText: "",
      completeResolver,
    });

    // Update activity timestamp
    if (this.currentSessionRecord) {
      sessionModel.updateSessionActivity(this.db, this.currentSessionRecord.id);
    }

    await this.runtimeRequest("session.prompt", {
      sessionId: ccSessionId,
      content,
      cwd: this.currentWorkspace?.cwd,
    });

    // Streaming mode: return immediately
    if (streaming) {
      return { ccSessionId };
    }

    // Non-streaming: wait for message_stop to resolve with accumulated text
    const text = await completionPromise!;
    return { ccSessionId, text };
  }

  /**
   * Interrupt the current session via the runtime.
   */
  async interrupt(sessionRecordId: string): Promise<boolean> {
    const record = sessionModel.getSession(this.db, sessionRecordId);
    if (!record) return false;

    try {
      await this.runtimeRequest("session.interrupt", {
        sessionId: record.ccSessionId,
      });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Set the permission mode for a session's CLI process.
   */
  async setPermissionMode(sessionRecordId: string, mode: string): Promise<boolean> {
    const record = sessionModel.getSession(this.db, sessionRecordId);
    if (!record) return false;

    try {
      await this.runtimeRequest("session.permission-mode", {
        sessionId: record.ccSessionId,
        mode,
      });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Send a tool_result for an interactive tool (ExitPlanMode, etc.) via the runtime.
   */
  async sendToolResult(
    sessionRecordId: string,
    toolUseId: string,
    content: string,
    isError = false,
  ): Promise<boolean> {
    const record = sessionModel.getSession(this.db, sessionRecordId);
    if (!record) return false;

    try {
      await this.runtimeRequest("session.tool-result", {
        sessionId: record.ccSessionId,
        toolUseId,
        content,
        isError,
      });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Get session info.
   */
  getInfo() {
    const sessionConfig = this.config.session;
    const effectiveConfig = {
      thinking: this.pendingSessionConfig.thinking ?? sessionConfig.thinking,
      effort: this.pendingSessionConfig.effort ?? sessionConfig.effort,
      model: sessionConfig.model,
      systemPrompt: sessionConfig.systemPrompt,
    };

    return {
      sessionId: this.activeRuntimeSessionId || this.currentSessionRecord?.ccSessionId || null,
      isActive: !!this.activeRuntimeSessionId,
      isProcessRunning: !!this.activeRuntimeSessionId,
      isRuntimeConnected: this.runtimeConnected,
      workspaceId: this.currentWorkspace?.id || null,
      workspaceName: this.currentWorkspace?.name || null,
      session: this.currentSessionRecord,
      sessionConfig: effectiveConfig,
      pendingConfig: !this.activeRuntimeSessionId ? this.pendingSessionConfig : undefined,
    };
  }

  /**
   * Legacy migration: convert old .session-id file to DB records.
   */
  async migrateLegacySession(): Promise<void> {
    const sessionFile = join(this.dataDir, ".session-id");
    if (!existsSync(sessionFile)) return;

    const ccSessionId = readFileSync(sessionFile, "utf-8").trim();
    if (!ccSessionId) {
      unlinkSync(sessionFile);
      return;
    }

    const existing = sessionModel.getSessionByCcId(this.db, ccSessionId);
    if (existing) {
      log.info(` Legacy session already migrated: ${ccSessionId}`);
      unlinkSync(sessionFile);
      return;
    }

    const cwd = process.cwd();
    const { workspace } = workspaceModel.getOrCreateWorkspace(this.db, cwd);

    const record = sessionModel.createSessionRecord(this.db, {
      workspaceId: workspace.id,
      ccSessionId,
    });

    workspaceModel.setActiveSession(this.db, workspace.id, record.id);
    this.currentWorkspace = workspaceModel.getWorkspace(this.db, workspace.id);
    this.currentSessionRecord = record;

    log.info(` Migrated legacy session: ${ccSessionId} → ${record.id}`);
    unlinkSync(sessionFile);
  }

  /**
   * Close everything for shutdown.
   */
  async close(): Promise<void> {
    if (this.runtimeReconnectTimer) {
      clearTimeout(this.runtimeReconnectTimer);
      this.runtimeReconnectTimer = null;
    }

    if (this.runtimeWs) {
      this.runtimeWs.close();
      this.runtimeWs = null;
    }

    this.runtimeConnected = false;
  }

  // ── Private Methods ────────────────────────────────────────

  /**
   * Discover existing Claude Code sessions for a workspace by scanning
   * ~/.claude/projects/ for JSONL files matching the workspace's CWD.
   */
  private discoverSessionsForWorkspace(workspace: Workspace): void {
    const projectsDir = join(homedir(), ".claude", "projects");
    if (!existsSync(projectsDir)) return;

    const cwdEncoded = workspace.cwd.replace(/\//g, "-");

    let targetDir: string | null = null;
    try {
      const dirs = readdirSync(projectsDir, { withFileTypes: true });
      for (const dir of dirs) {
        if (dir.isDirectory() && dir.name === cwdEncoded) {
          targetDir = join(projectsDir, dir.name);
          break;
        }
      }
    } catch {
      return;
    }

    if (!targetDir) return;

    try {
      const files = readdirSync(targetDir)
        .filter((f) => f.endsWith(".jsonl"))
        .map((f) => ({
          filename: f,
          ccSessionId: f.replace(".jsonl", ""),
          path: join(targetDir!, f),
        }))
        .sort((a, b) => {
          try {
            return statSync(a.path).mtimeMs - statSync(b.path).mtimeMs;
          } catch {
            return 0;
          }
        });

      if (files.length === 0) return;

      log.info(
        `[SessionManager] Discovered ${files.length} existing session(s) for ${workspace.name}`,
      );

      let latestRecord: SessionRecord | null = null;

      for (const file of files) {
        const existing = sessionModel.getSessionByCcId(this.db, file.ccSessionId);
        if (existing) {
          latestRecord = existing;
          continue;
        }

        const record = sessionModel.createSessionRecord(this.db, {
          workspaceId: workspace.id,
          ccSessionId: file.ccSessionId,
        });

        log.info(` Imported session: ${file.ccSessionId} → ${record.id}`);
        latestRecord = record;
      }

      if (latestRecord && !workspace.activeSessionId) {
        workspaceModel.setActiveSession(this.db, workspace.id, latestRecord.id);
        log.info(` Set active session: ${latestRecord.id}`);
      }
    } catch (err) {
      log.error(` Error discovering sessions:`, err);
    }
  }
}
