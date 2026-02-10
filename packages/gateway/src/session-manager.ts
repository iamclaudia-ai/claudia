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
import type { Request, Response, Event, Message } from "@claudia/shared";
import { existsSync, readFileSync, readdirSync, unlinkSync, statSync } from "node:fs";
import { join, basename } from "node:path";
import { homedir } from "node:os";

import * as workspaceModel from "./db/models/workspace";
import * as sessionModel from "./db/models/session";
import { parseSessionFile, parseSessionFilePaginated, parseSessionUsage, resolveSessionPath } from "./parse-session";

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
  private pendingRequests = new Map<string, {
    resolve: (payload: unknown) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();

  // Active session tracking (which ccSessionId is active in the runtime)
  private activeRuntimeSessionId: string | null = null;

  // Current workspace/session state
  private currentWorkspace: Workspace | null = null;
  private currentSessionRecord: SessionRecord | null = null;

  // Per-request state
  currentRequestWantsVoice = false;
  currentRequestSource: string | null = null;
  currentResponseText = "";

  // Session config (can be set before first prompt)
  pendingSessionConfig: { thinking?: boolean; thinkingBudget?: number } = {};

  constructor(options: SessionManagerOptions) {
    this.db = options.db;
    this.dataDir = options.dataDir;
    this.config = options.config;
    this.broadcastEvent = options.broadcastEvent;
    this.broadcastExtension = options.broadcastExtension;
    this.routeToSource = options.routeToSource;
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

    console.log(`[SessionManager] Connecting to runtime: ${url}`);

    const ws = new WebSocket(url);

    ws.onopen = () => {
      console.log("[SessionManager] Connected to runtime ✓");
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
        console.error("[SessionManager] Failed to parse runtime message:", error);
      }
    };

    ws.onclose = () => {
      console.log("[SessionManager] Runtime disconnected");
      this.runtimeConnected = false;
      this.runtimeWs = null;

      // Reject pending requests
      for (const [id, pending] of this.pendingRequests) {
        clearTimeout(pending.timer);
        pending.reject(new Error("Runtime disconnected"));
      }
      this.pendingRequests.clear();

      // Schedule reconnect
      this.scheduleReconnect();
    };

    ws.onerror = (error) => {
      console.error("[SessionManager] Runtime WebSocket error:", error);
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
      console.log(`[Stream] ▶ message_start (session: ${sessionId?.slice(0, 8)}…)`);
    } else if (eventType === "message_stop") {
      console.log(`[Stream] ■ message_stop`);
    } else if (eventType === "content_block_start") {
      const block = eventPayload.content_block as { type: string; name?: string } | undefined;
      const label = block?.type === "tool_use" ? `tool_use(${block.name})` : block?.type || "unknown";
      console.log(`[Stream]   ┌ content_block_start: ${label}`);
    } else if (eventType === "content_block_stop") {
      console.log(`[Stream]   └ content_block_stop`);
    } else if (eventType === "api_error") {
      console.error(`[Stream] ✖ API ERROR ${eventPayload.status}: ${eventPayload.message}`);
    } else if (eventType === "api_warning") {
      console.warn(`[Stream] ⚠ API RETRY attempt ${eventPayload.attempt}/${eventPayload.maxRetries}: ${eventPayload.message}`);
    }

    const payload = {
      sessionId,
      source: this.currentRequestSource,
      ...eventPayload,
    };

    // Accumulate text for source routing
    if (eventType === "content_block_start") {
      const block = eventPayload.content_block as { type: string } | undefined;
      if (block?.type === "text") {
        this.currentResponseText = "";
      }
    } else if (eventType === "content_block_delta") {
      const delta = eventPayload.delta as { type: string; text?: string } | undefined;
      if (delta?.type === "text_delta" && delta.text) {
        this.currentResponseText += delta.text;
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
        speakResponse: this.currentRequestWantsVoice,
        responseText: eventType === "message_stop" ? this.currentResponseText : undefined,
      },
      timestamp: Date.now(),
      origin: "session",
      source: this.currentRequestSource || undefined,
      sessionId,
    };

    // Broadcast to extensions
    this.broadcastExtension(gatewayEvent);

    // On message complete, route to source if applicable
    if (eventType === "message_stop" && this.currentRequestSource) {
      this.routeToSource(this.currentRequestSource, gatewayEvent);
      this.currentResponseText = "";
    }
  }

  /**
   * On runtime connect, check for existing sessions and reconcile.
   */
  private async reconcileRuntimeSessions(): Promise<void> {
    try {
      const result = await this.runtimeRequest("session.list") as { sessions: Array<{ id: string }> };
      if (result.sessions?.length > 0) {
        console.log(`[SessionManager] Runtime has ${result.sessions.length} active session(s)`);
        // TODO: reconcile with SQLite records
      }
    } catch (error) {
      console.warn("[SessionManager] Failed to reconcile runtime sessions:", error);
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

  listSessions(workspaceId?: string): SessionRecord[] {
    const wsId = workspaceId || this.currentWorkspace?.id;
    if (!wsId) return [];
    return sessionModel.listSessions(this.db, wsId);
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
  async initSession(sessionRecordId?: string): Promise<string> {
    if (sessionRecordId) {
      const record = sessionModel.getSession(this.db, sessionRecordId);
      if (!record) throw new Error(`Session not found: ${sessionRecordId}`);

      // Already active?
      if (this.activeRuntimeSessionId === record.ccSessionId && this.currentSessionRecord?.id === record.id) {
        return record.ccSessionId;
      }

      // Close existing runtime session if different
      if (this.activeRuntimeSessionId && this.activeRuntimeSessionId !== record.ccSessionId) {
        try {
          await this.runtimeRequest("session.close", { sessionId: this.activeRuntimeSessionId });
        } catch {
          // Ignore close errors
        }
      }

      // Set workspace context
      this.currentWorkspace = workspaceModel.getWorkspace(this.db, record.workspaceId);
      const cwd = this.currentWorkspace?.cwd;
      if (!cwd) throw new Error(`Workspace not found for session: ${record.workspaceId}`);

      // Resume in runtime
      console.log(`[SessionManager] Resuming session via runtime: ${record.ccSessionId} (cwd: ${cwd})`);
      await this.runtimeRequest("session.resume", {
        sessionId: record.ccSessionId,
        cwd,
      });

      this.activeRuntimeSessionId = record.ccSessionId;
      this.currentSessionRecord = record;
      return record.ccSessionId;
    }

    // No specific session — use current workspace's active session
    if (this.activeRuntimeSessionId) {
      return this.activeRuntimeSessionId;
    }

    if (!this.currentWorkspace) {
      throw new Error("No workspace set. Use workspace.getOrCreate (VS Code) or specify a sessionId (web).");
    }

    if (this.currentWorkspace.activeSessionId) {
      const record = sessionModel.getSession(this.db, this.currentWorkspace.activeSessionId);
      if (record) {
        console.log(`[SessionManager] Resuming session via runtime: ${record.ccSessionId} (cwd: ${this.currentWorkspace.cwd})`);
        await this.runtimeRequest("session.resume", {
          sessionId: record.ccSessionId,
          cwd: this.currentWorkspace.cwd,
        });

        this.activeRuntimeSessionId = record.ccSessionId;
        this.currentSessionRecord = record;
        return record.ccSessionId;
      }
    }

    throw new Error("No active session. Create a new session first.");
  }

  /**
   * Create a new session, archiving the current active one.
   */
  async createNewSession(workspaceId?: string, title?: string): Promise<{
    session: SessionRecord;
    previousSessionId?: string;
  }> {
    const wsId = workspaceId || this.currentWorkspace?.id;
    if (!wsId) throw new Error("No workspace available");

    // Close current runtime session
    if (this.activeRuntimeSessionId) {
      try {
        await this.runtimeRequest("session.close", { sessionId: this.activeRuntimeSessionId });
      } catch {
        // Ignore close errors
      }
      this.activeRuntimeSessionId = null;
    }

    // Archive current active session
    let previousSessionId: string | undefined;
    const workspace = workspaceModel.getWorkspace(this.db, wsId);
    if (!workspace) throw new Error(`Workspace not found: ${wsId}`);

    if (workspace.activeSessionId) {
      sessionModel.archiveSession(this.db, workspace.activeSessionId);
      previousSessionId = workspace.activeSessionId;
    }

    // Create session in runtime
    const sessionConfig = this.config.session;
    const thinking = this.pendingSessionConfig.thinking ?? sessionConfig.thinking;
    const thinkingBudget = this.pendingSessionConfig.thinkingBudget ?? sessionConfig.thinkingBudget;
    const model = sessionConfig.model || undefined;

    console.log(`[SessionManager] Creating new session via runtime (model: ${model || "default"}, thinking: ${thinking}, cwd: ${workspace.cwd})...`);

    const result = await this.runtimeRequest("session.create", {
      cwd: workspace.cwd,
      model,
      systemPrompt: sessionConfig.systemPrompt || undefined,
      thinking,
      thinkingBudget,
    }) as { sessionId: string; proxyPort: number };

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

    console.log(`[SessionManager] Created session: ${result.sessionId} (${record.id})`);
    return { session: record, previousSessionId };
  }

  /**
   * Switch to a different session.
   */
  async switchSession(sessionId: string): Promise<SessionRecord> {
    const record = sessionModel.getSession(this.db, sessionId);
    if (!record) throw new Error(`Session not found: ${sessionId}`);

    // Close current runtime session
    if (this.activeRuntimeSessionId) {
      try {
        await this.runtimeRequest("session.close", { sessionId: this.activeRuntimeSessionId });
      } catch {
        // Ignore
      }
    }

    // Get workspace for CWD
    const workspace = workspaceModel.getWorkspace(this.db, record.workspaceId);
    if (!workspace) throw new Error(`Workspace not found: ${record.workspaceId}`);

    // Resume in runtime
    console.log(`[SessionManager] Switching to session via runtime: ${record.ccSessionId} (cwd: ${workspace.cwd})`);
    await this.runtimeRequest("session.resume", {
      sessionId: record.ccSessionId,
      cwd: workspace.cwd,
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
  getSessionHistory(sessionId?: string, options?: { limit?: number; offset?: number }) {
    let ccSessionId: string | undefined;

    if (sessionId) {
      const record = sessionModel.getSession(this.db, sessionId);
      ccSessionId = record?.ccSessionId;
    } else {
      ccSessionId = this.currentSessionRecord?.ccSessionId || this.activeRuntimeSessionId || undefined;
    }

    if (!ccSessionId) {
      return { messages: [], usage: null, total: 0, hasMore: false };
    }

    const sessionPath = resolveSessionPath(ccSessionId);
    if (!sessionPath) {
      console.warn(`[SessionManager] Session JSONL not found for: ${ccSessionId}`);
      return { messages: [], usage: null, total: 0, hasMore: false };
    }

    try {
      const usage = parseSessionUsage(sessionPath);

      if (options?.limit) {
        const { messages, total, hasMore } = parseSessionFilePaginated(sessionPath, {
          limit: options.limit,
          offset: options.offset || 0,
        });
        console.log(`[SessionManager] Loaded ${messages.length}/${total} messages (offset: ${options.offset || 0}, hasMore: ${hasMore})`);
        return { messages, usage, total, hasMore };
      }

      const messages = parseSessionFile(sessionPath);
      console.log(`[SessionManager] Loaded ${messages.length} messages from history`);
      return { messages, usage, total: messages.length, hasMore: false };
    } catch (err) {
      console.error("[SessionManager] Failed to parse session history:", err);
      return { messages: [], usage: null, total: 0, hasMore: false };
    }
  }

  /**
   * Send a prompt to a session via the runtime.
   */
  async prompt(content: string | unknown[], sessionRecordId?: string): Promise<string> {
    const ccSessionId = await this.initSession(sessionRecordId);

    // Update activity timestamp
    if (this.currentSessionRecord) {
      sessionModel.updateSessionActivity(this.db, this.currentSessionRecord.id);
    }

    await this.runtimeRequest("session.prompt", {
      sessionId: ccSessionId,
      content,
    });

    return ccSessionId;
  }

  /**
   * Interrupt the current session via the runtime.
   */
  async interrupt(): Promise<boolean> {
    if (!this.activeRuntimeSessionId) return false;

    try {
      await this.runtimeRequest("session.interrupt", {
        sessionId: this.activeRuntimeSessionId,
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
      thinkingBudget: this.pendingSessionConfig.thinkingBudget ?? sessionConfig.thinkingBudget,
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
      console.log(`[SessionManager] Legacy session already migrated: ${ccSessionId}`);
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

    console.log(`[SessionManager] Migrated legacy session: ${ccSessionId} → ${record.id}`);
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

      console.log(`[SessionManager] Discovered ${files.length} existing session(s) for ${workspace.name}`);

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

        console.log(`[SessionManager] Imported session: ${file.ccSessionId} → ${record.id}`);
        latestRecord = record;
      }

      if (latestRecord && !workspace.activeSessionId) {
        workspaceModel.setActiveSession(this.db, workspace.id, latestRecord.id);
        console.log(`[SessionManager] Set active session: ${latestRecord.id}`);
      }
    } catch (err) {
      console.error(`[SessionManager] Error discovering sessions:`, err);
    }
  }
}
