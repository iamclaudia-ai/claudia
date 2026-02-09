/**
 * Session Manager
 *
 * Manages workspace-aware session lifecycle. Replaces the old singleton
 * session pattern with SQLite-backed workspace/session management.
 *
 * Supports two modes:
 * - VS Code: auto-discover workspace by CWD, auto-create if needed
 * - Web: explicit session selection via session ID
 */

import type { Database } from "bun:sqlite";
import type { Workspace, SessionRecord, GatewayEvent, ClaudiaConfig } from "@claudia/shared";
import { ClaudiaSession, createSession, resumeSession } from "@claudia/sdk";
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

  // Current active state
  private session: ClaudiaSession | null = null;
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

  // ── Workspace Operations ───────────────────────────────────

  listWorkspaces(): Workspace[] {
    return workspaceModel.listWorkspaces(this.db);
  }

  getWorkspace(id: string): Workspace | null {
    return workspaceModel.getWorkspace(this.db, id);
  }

  getOrCreateWorkspace(cwd: string, name?: string): { workspace: Workspace; created: boolean } {
    const result = workspaceModel.getOrCreateWorkspace(this.db, cwd, name);

    // If we just created the workspace, discover any existing Claude Code sessions
    if (result.created) {
      this.discoverSessionsForWorkspace(result.workspace);
    }

    // If this is the workspace we're working in, track it
    if (!this.currentWorkspace || this.currentWorkspace.cwd === cwd) {
      // Refresh in case discover updated it
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

  getCurrentSession(): { session: ClaudiaSession | null; record: SessionRecord | null } {
    return { session: this.session, record: this.currentSessionRecord };
  }

  /**
   * Initialize or resume a session.
   *
   * If a session record ID is provided, load that specific session (web client flow).
   * Otherwise, use the current workspace's active session (VS Code flow).
   * Never auto-creates a workspace from gateway CWD.
   */
  async initSession(sessionRecordId?: string): Promise<ClaudiaSession> {
    // If targeting a specific session record, switch to it
    if (sessionRecordId) {
      const record = sessionModel.getSession(this.db, sessionRecordId);
      if (!record) {
        throw new Error(`Session not found: ${sessionRecordId}`);
      }

      // If this is already our active session, just return it
      if (this.session?.isActive && this.currentSessionRecord?.id === record.id) {
        return this.session;
      }

      // Close existing session if different
      if (this.session) {
        await this.session.close();
        this.session = null;
      }

      // Set workspace context from the session's workspace
      this.currentWorkspace = workspaceModel.getWorkspace(this.db, record.workspaceId);
      const cwd = this.currentWorkspace?.cwd;
      if (!cwd) throw new Error(`Workspace not found for session: ${record.workspaceId}`);

      console.log(`[SessionManager] Resuming session: ${record.ccSessionId} (from record ${record.id}, cwd: ${cwd})`);
      this.session = await resumeSession(record.ccSessionId, { cwd });
      this.currentSessionRecord = record;
      this.wireSession();
      return this.session;
    }

    // No specific session — use current workspace's active session
    if (this.session?.isActive) {
      return this.session;
    }

    if (!this.currentWorkspace) {
      throw new Error("No workspace set. Use workspace.getOrCreate (VS Code) or specify a sessionId (web).");
    }

    // Check if workspace has an active session to resume
    if (this.currentWorkspace.activeSessionId) {
      const record = sessionModel.getSession(this.db, this.currentWorkspace.activeSessionId);
      if (record) {
        console.log(`[SessionManager] Resuming session: ${record.ccSessionId} (cwd: ${this.currentWorkspace.cwd})`);
        this.session = await resumeSession(record.ccSessionId, { cwd: this.currentWorkspace.cwd });
        this.currentSessionRecord = record;
        this.wireSession();
        return this.session;
      }
    }

    // No session available — user must create one explicitly
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
    if (!wsId) {
      throw new Error("No workspace available");
    }

    // Close current session if active
    let previousSessionId: string | undefined;
    if (this.session) {
      await this.session.close();
      this.session = null;
    }

    // Archive current active session
    const workspace = workspaceModel.getWorkspace(this.db, wsId);
    if (!workspace) {
      throw new Error(`Workspace not found: ${wsId}`);
    }
    if (workspace.activeSessionId) {
      sessionModel.archiveSession(this.db, workspace.activeSessionId);
      previousSessionId = workspace.activeSessionId;
    }

    // Create the new Claude Code session using config defaults + any pending overrides
    const sessionConfig = this.config.session;
    const thinking = this.pendingSessionConfig.thinking ?? sessionConfig.thinking;
    const thinkingBudget = this.pendingSessionConfig.thinkingBudget ?? sessionConfig.thinkingBudget;
    const model = sessionConfig.model || undefined;

    console.log(`[SessionManager] Creating new session (model: ${model || "default"}, thinking: ${thinking}, cwd: ${workspace.cwd})...`);
    this.session = await createSession({
      systemPrompt: sessionConfig.systemPrompt || undefined,
      cwd: workspace.cwd,
      thinking,
      thinkingBudget,
      model,
    });

    // Record in DB
    const record = sessionModel.createSessionRecord(this.db, {
      workspaceId: wsId,
      ccSessionId: this.session.id,
      title,
      previousSessionId,
    });

    // Set as active
    workspaceModel.setActiveSession(this.db, wsId, record.id);
    this.currentSessionRecord = record;
    this.currentWorkspace = workspaceModel.getWorkspace(this.db, wsId);

    // Clear pending config
    this.pendingSessionConfig = {};

    // Wire up events
    this.wireSession();

    console.log(`[SessionManager] Created session: ${this.session.id} (${record.id})`);
    return { session: record, previousSessionId };
  }

  /**
   * Switch to a different session (resume it).
   */
  async switchSession(sessionId: string): Promise<SessionRecord> {
    const record = sessionModel.getSession(this.db, sessionId);
    if (!record) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    // Close current session
    if (this.session) {
      await this.session.close();
      this.session = null;
    }

    // Get workspace for CWD
    const workspace = workspaceModel.getWorkspace(this.db, record.workspaceId);
    if (!workspace) throw new Error(`Workspace not found: ${record.workspaceId}`);

    // Resume the target session
    console.log(`[SessionManager] Switching to session: ${record.ccSessionId} (cwd: ${workspace.cwd})`);
    this.session = await resumeSession(record.ccSessionId, { cwd: workspace.cwd });
    this.currentSessionRecord = record;

    // Update workspace active session
    workspaceModel.setActiveSession(this.db, record.workspaceId, record.id);
    this.currentWorkspace = workspace;

    // Mark as active if it was archived
    if (record.status === "archived") {
      this.db.query("UPDATE sessions SET status = 'active' WHERE id = ?").run(record.id);
      this.currentSessionRecord = sessionModel.getSession(this.db, record.id);
    }

    // Wire up events
    this.wireSession();

    return this.currentSessionRecord!;
  }

  /**
   * Get session history from JSONL file with optional pagination.
   * Accepts explicit session ID (ses_...) for web client, or falls back
   * to current session for VS Code auto-discover flow.
   *
   * When limit is provided, returns paginated results (most recent first).
   * When no limit, returns all messages (legacy behavior).
   */
  getSessionHistory(sessionId?: string, options?: { limit?: number; offset?: number }) {
    let ccSessionId: string | undefined;

    if (sessionId) {
      // Explicit session ID provided (web client flow)
      const record = sessionModel.getSession(this.db, sessionId);
      ccSessionId = record?.ccSessionId;
    } else {
      // Fall back to current session (VS Code flow)
      ccSessionId = this.currentSessionRecord?.ccSessionId || this.session?.id;
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
        // Paginated: return a slice of messages
        const { messages, total, hasMore } = parseSessionFilePaginated(sessionPath, {
          limit: options.limit,
          offset: options.offset || 0,
        });
        console.log(`[SessionManager] Loaded ${messages.length}/${total} messages (offset: ${options.offset || 0}, hasMore: ${hasMore})`);
        return { messages, usage, total, hasMore };
      }

      // Unpaginated: return everything (legacy behavior)
      const messages = parseSessionFile(sessionPath);
      console.log(`[SessionManager] Loaded ${messages.length} messages from history`);
      return { messages, usage, total: messages.length, hasMore: false };
    } catch (err) {
      console.error("[SessionManager] Failed to parse session history:", err);
      return { messages: [], usage: null, total: 0, hasMore: false };
    }
  }

  /**
   * Send a prompt to a session.
   * If sessionRecordId is provided, targets that specific session (web client).
   * Otherwise uses the current workspace's active session (VS Code / extensions).
   */
  async prompt(content: string | unknown[], sessionRecordId?: string): Promise<ClaudiaSession> {
    const s = await this.initSession(sessionRecordId);

    // Update activity timestamp
    if (this.currentSessionRecord) {
      sessionModel.updateSessionActivity(this.db, this.currentSessionRecord.id);
    }

    s.prompt(content as string | unknown[]);
    return s;
  }

  /**
   * Interrupt the current session
   */
  interrupt(): boolean {
    if (this.session) {
      this.session.interrupt();
      return true;
    }
    return false;
  }

  /**
   * Get session info
   */
  getInfo() {
    // Get session config (current config for active session, or what would be used for new sessions)
    const sessionConfig = this.config.session;
    const effectiveConfig = {
      thinking: this.pendingSessionConfig.thinking ?? sessionConfig.thinking,
      thinkingBudget: this.pendingSessionConfig.thinkingBudget ?? sessionConfig.thinkingBudget,
      model: sessionConfig.model,
      systemPrompt: sessionConfig.systemPrompt,
    };

    return {
      sessionId: this.session?.id || this.currentSessionRecord?.ccSessionId || null,
      isActive: this.session?.isActive || false,
      isProcessRunning: this.session?.isProcessRunning || false,
      workspaceId: this.currentWorkspace?.id || null,
      workspaceName: this.currentWorkspace?.name || null,
      session: this.currentSessionRecord,
      sessionConfig: effectiveConfig,
      pendingConfig: !this.session ? this.pendingSessionConfig : undefined,
    };
  }

  /**
   * Legacy migration: convert old .session-id file to DB records
   */
  async migrateLegacySession(): Promise<void> {
    const sessionFile = join(this.dataDir, ".session-id");
    if (!existsSync(sessionFile)) return;

    const ccSessionId = readFileSync(sessionFile, "utf-8").trim();
    if (!ccSessionId) {
      unlinkSync(sessionFile);
      return;
    }

    // Check if we already have this session in DB
    const existing = sessionModel.getSessionByCcId(this.db, ccSessionId);
    if (existing) {
      console.log(`[SessionManager] Legacy session already migrated: ${ccSessionId}`);
      unlinkSync(sessionFile);
      return;
    }

    // Create workspace for current CWD and a session record
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
   * Close everything for shutdown
   */
  async close(): Promise<void> {
    if (this.session) {
      await this.session.close();
      this.session = null;
    }
  }

  // ── Private Methods ────────────────────────────────────────

  /**
   * Discover existing Claude Code sessions for a workspace by scanning
   * ~/.claude/projects/ for JSONL files matching the workspace's CWD.
   *
   * Claude Code stores sessions at:
   *   ~/.claude/projects/{cwd-with-dashes}/{uuid}.jsonl
   *
   * The directory name is the CWD with "/" replaced by "-" and leading "-".
   */
  private discoverSessionsForWorkspace(workspace: Workspace): void {
    const projectsDir = join(homedir(), ".claude", "projects");
    if (!existsSync(projectsDir)) return;

    // Claude Code encodes CWD as: /Users/michael/foo → -Users-michael-foo
    const cwdEncoded = workspace.cwd.replace(/\//g, "-");

    // Find the matching directory
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

    // Scan for JSONL session files
    try {
      const files = readdirSync(targetDir)
        .filter((f) => f.endsWith(".jsonl"))
        .map((f) => ({
          filename: f,
          ccSessionId: f.replace(".jsonl", ""),
          path: join(targetDir!, f),
        }))
        // Sort by modification time (most recent last)
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
        // Skip if already in DB
        const existing = sessionModel.getSessionByCcId(this.db, file.ccSessionId);
        if (existing) {
          latestRecord = existing;
          continue;
        }

        // Create a DB record for this discovered session
        const record = sessionModel.createSessionRecord(this.db, {
          workspaceId: workspace.id,
          ccSessionId: file.ccSessionId,
        });

        console.log(`[SessionManager] Imported session: ${file.ccSessionId} → ${record.id}`);
        latestRecord = record;
      }

      // Set the most recent session as active (if workspace has no active session)
      if (latestRecord && !workspace.activeSessionId) {
        workspaceModel.setActiveSession(this.db, workspace.id, latestRecord.id);
        console.log(`[SessionManager] Set active session: ${latestRecord.id}`);
      }
    } catch (err) {
      console.error(`[SessionManager] Error discovering sessions:`, err);
    }
  }

  /**
   * Wire up SSE event forwarding from the ClaudiaSession to clients/extensions
   */
  private wireSession(): void {
    if (!this.session) return;

    const sessionRef = this.session;

    sessionRef.on("sse", (event) => {
      const eventName = `session.${event.type}`;

      // ── Streaming event logging ──
      if (event.type === "message_start") {
        console.log(`[Stream] ▶ message_start (session: ${sessionRef.id.slice(0, 8)}…)`);
      } else if (event.type === "message_stop") {
        console.log(`[Stream] ■ message_stop`);
      } else if (event.type === "content_block_start") {
        const block = (event as Record<string, unknown>).content_block as { type: string; name?: string } | undefined;
        const label = block?.type === "tool_use" ? `tool_use(${block.name})` : block?.type || "unknown";
        console.log(`[Stream]   ┌ content_block_start: ${label}`);
      } else if (event.type === "content_block_stop") {
        console.log(`[Stream]   └ content_block_stop`);
      } else if (event.type === "api_error") {
        const e = event as Record<string, unknown>;
        console.error(`[Stream] ✖ API ERROR ${e.status}: ${e.message}`);
      } else if (event.type === "api_warning") {
        const w = event as Record<string, unknown>;
        console.warn(`[Stream] ⚠ API RETRY attempt ${w.attempt}/${w.maxRetries}: ${w.message}`);
      }
      // Don't log content_block_delta (too noisy) or message_delta (just usage)

      const payload = {
        sessionId: sessionRef.id,
        source: this.currentRequestSource,
        ...event,
      };

      // Accumulate text from content deltas for source routing
      if (event.type === "content_block_start") {
        const block = (event as Record<string, unknown>).content_block as { type: string } | undefined;
        if (block?.type === "text") {
          this.currentResponseText = "";
        }
      } else if (event.type === "content_block_delta") {
        const delta = (event as Record<string, unknown>).delta as { type: string; text?: string } | undefined;
        if (delta?.type === "text_delta" && delta.text) {
          this.currentResponseText += delta.text;
        }
      }

      // Broadcast to WebSocket clients
      this.broadcastEvent(eventName, payload, "session");

      // Build gateway event for extensions
      const gatewayEvent: GatewayEvent = {
        type: eventName,
        payload: {
          ...payload,
          speakResponse: this.currentRequestWantsVoice,
          responseText: event.type === "message_stop" ? this.currentResponseText : undefined,
        },
        timestamp: Date.now(),
        origin: "session",
        source: this.currentRequestSource || undefined,
        sessionId: sessionRef.id,
      };

      // Broadcast to extensions
      this.broadcastExtension(gatewayEvent);

      // On message complete, route to source if applicable
      if (event.type === "message_stop" && this.currentRequestSource) {
        this.routeToSource(this.currentRequestSource, gatewayEvent);
        this.currentResponseText = "";
      }
    });

    sessionRef.on("process_started", () => {
      this.broadcastEvent("session.process_started", { sessionId: sessionRef.id }, "session");
    });

    sessionRef.on("process_ended", () => {
      this.broadcastEvent("session.process_ended", { sessionId: sessionRef.id }, "session");
    });
  }
}
