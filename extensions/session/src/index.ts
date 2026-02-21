/**
 * Session Extension
 *
 * Owns all session and workspace lifecycle — the "brain" of Claudia's session management.
 * Session lifecycle, workspace management, and Claude SDK integration.
 *
 * Gateway is a pure hub: this extension handles create, prompt, history, switch, etc.
 * Other extensions interact via ctx.call("session.*") through the gateway hub.
 *
 * Method naming: session.verb-noun (exception: session.health-check)
 */

import { z } from "zod";
import type {
  ClaudiaExtension,
  ExtensionContext,
  ExtensionMethodDefinition,
  HealthCheckResponse,
} from "@claudia/shared";
import { createLogger } from "@claudia/shared";
import { join } from "node:path";
import { homedir } from "node:os";
import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  openSync,
  readSync,
  closeSync,
} from "node:fs";
import { SessionManager } from "./session-manager";
import {
  parseSessionFile,
  parseSessionFilePaginated,
  parseSessionUsage,
  resolveSessionPath,
} from "./parse-session";
import { listWorkspaces, getWorkspace, getOrCreateWorkspace, closeDb } from "./workspace";

const log = createLogger("SessionExt", join(homedir(), ".claudia", "logs", "session.log"));

// ── Types ────────────────────────────────────────────────────

interface SessionConfig {
  model?: string;
  thinking?: boolean;
  effort?: string;
}

// ── Session Discovery ────────────────────────────────────────

interface SessionIndexEntry {
  sessionId: string;
  created?: string;
  modified?: string;
  messageCount?: number;
  firstPrompt?: string;
  gitBranch?: string;
}

/**
 * Resolve the Claude Code project directory for a given CWD.
 * Claude Code encodes paths by replacing / with - (dash).
 */
function resolveProjectDir(cwd: string): string | null {
  const projectsDir = join(homedir(), ".claude", "projects");
  if (!existsSync(projectsDir)) return null;

  // Primary: Claude Code encodes cwd by replacing / with - (dash)
  const encodedCwd = cwd.replace(/\//g, "-");
  const primaryDir = join(projectsDir, encodedCwd);
  if (existsSync(primaryDir)) return primaryDir;

  // Fallback: scan for matching originalPath in sessions-index.json
  const dirs = readdirSync(projectsDir);
  for (const dir of dirs) {
    const indexPath = join(projectsDir, dir, "sessions-index.json");
    if (!existsSync(indexPath)) continue;
    try {
      const data = JSON.parse(readFileSync(indexPath, "utf-8"));
      if (data.originalPath === cwd) return join(projectsDir, dir);
    } catch {
      // skip
    }
  }

  return null;
}

/**
 * Read the sessions-index.json if it exists, returning a map of sessionId → entry.
 */
function readSessionsIndexMap(projectDir: string): Map<string, SessionIndexEntry> {
  const map = new Map<string, SessionIndexEntry>();
  const indexPath = join(projectDir, "sessions-index.json");
  if (!existsSync(indexPath)) return map;

  try {
    const data = JSON.parse(readFileSync(indexPath, "utf-8"));
    const entries: SessionIndexEntry[] =
      data.entries && Array.isArray(data.entries) ? data.entries : Array.isArray(data) ? data : [];
    for (const entry of entries) {
      if (entry.sessionId) map.set(entry.sessionId, entry);
    }
  } catch {
    // skip
  }
  return map;
}

/**
 * Extract cwd from a JSONL session file (from first user message).
 */
function extractSessionCwd(filepath: string): string | undefined {
  try {
    const buf = new Uint8Array(8192);
    const fd = openSync(filepath, "r");
    const bytesRead = readSync(fd, buf, 0, 8192, 0);
    closeSync(fd);
    const text = new TextDecoder().decode(buf.subarray(0, bytesRead));
    const lines = text.split("\n");

    for (let i = 0; i < Math.min(lines.length, 10); i++) {
      const line = lines[i]?.trim();
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.type === "user" && msg.cwd) return msg.cwd;
      } catch {
        // skip
      }
    }
  } catch {
    // skip
  }
  return undefined;
}

/**
 * Extract first user prompt from a JSONL session file.
 * Reads only the first ~20 lines (user message is typically line 1-2).
 *
 * Claude Code JSONL user message structure:
 *   { type: "user", message: { role: "user", content: "..." | [{type:"text",text:"..."}] } }
 */
function extractFirstPrompt(filepath: string): string | undefined {
  try {
    // Read only first 8KB — enough for the first few messages
    const buf = new Uint8Array(8192);
    const fd = openSync(filepath, "r");
    const bytesRead = readSync(fd, buf, 0, 8192, 0);
    closeSync(fd);
    const text = new TextDecoder().decode(buf.subarray(0, bytesRead));
    const lines = text.split("\n");

    for (let i = 0; i < Math.min(lines.length, 10); i++) {
      const line = lines[i]?.trim();
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.type !== "user") continue;

        // message.content can be string or array of content blocks
        const content = msg.message?.content;
        if (typeof content === "string") return content.slice(0, 200);
        if (Array.isArray(content)) {
          const textBlock = content.find(
            (b: { type: string; text?: string }) => b.type === "text" && b.text,
          );
          if (textBlock?.text) return textBlock.text.slice(0, 200);
        }
      } catch {
        // skip — line might be truncated at buffer boundary
      }
    }
  } catch {
    // skip
  }
  return undefined;
}

/**
 * Discover sessions by scanning JSONL files on disk, enriched with index data.
 * This is the primary source of truth — the index file may be stale or incomplete.
 */
function discoverSessions(cwd: string): SessionIndexEntry[] {
  const projectDir = resolveProjectDir(cwd);
  if (!projectDir) return [];

  // Load index data for enrichment
  const indexMap = readSessionsIndexMap(projectDir);

  // Scan all .jsonl files in the project directory
  const files = readdirSync(projectDir).filter((f) => f.endsWith(".jsonl"));
  const sessions: SessionIndexEntry[] = [];

  for (const file of files) {
    const sessionId = file.replace(".jsonl", "");
    const filepath = join(projectDir, file);

    // Get file stats for timestamps
    let stats;
    try {
      stats = statSync(filepath);
    } catch {
      continue;
    }

    // Merge with index data if available
    const indexed = indexMap.get(sessionId);

    sessions.push({
      sessionId,
      created: indexed?.created || stats.birthtime.toISOString(),
      modified: indexed?.modified || stats.mtime.toISOString(),
      messageCount: indexed?.messageCount,
      firstPrompt: indexed?.firstPrompt || extractFirstPrompt(filepath),
      gitBranch: indexed?.gitBranch,
    });
  }

  return sessions;
}

// ── Request context tracking ─────────────────────────────────

interface RequestContext {
  connectionId: string | null;
  source?: string;
  wantsVoice?: boolean;
  responseText: string;
}

// ── Extension factory ────────────────────────────────────────

export function createSessionExtension(config: Record<string, unknown> = {}): ClaudiaExtension {
  const sessionConfig = config as SessionConfig;
  const manager = new SessionManager();
  let ctx: ExtensionContext;

  // Per-session request context (for streaming events)
  const requestContexts = new Map<string, RequestContext>();

  // Set session defaults from config
  manager.setDefaults({
    model: sessionConfig.model,
    thinking: sessionConfig.thinking,
    effort: sessionConfig.effort as "low" | "medium" | "high" | "max" | undefined,
  });

  // Wire manager events → ctx.emit
  manager.on(
    "session.event",
    (event: { eventName: string; sessionId: string; [key: string]: unknown }) => {
      if (!ctx) return;

      const { eventName, sessionId, ...payload } = event;
      const reqCtx = requestContexts.get(sessionId);

      // Emit stream events with optional source routing
      ctx.emit(
        eventName,
        { ...payload, sessionId },
        reqCtx?.source ? { source: reqCtx.source } : undefined,
      );

      // Accumulate response text for non-streaming callers
      if (payload.type === "content_block_delta") {
        const delta = (payload as { delta?: { type?: string; text?: string } }).delta;
        if (delta?.type === "text_delta" && delta.text && reqCtx) {
          reqCtx.responseText += delta.text;
        }
      }
    },
  );

  // ── Method Definitions ─────────────────────────────────────

  const methods: ExtensionMethodDefinition[] = [
    {
      name: "session.create-session",
      description: "Create a new Claude session for a workspace CWD",
      inputSchema: z.object({
        cwd: z.string().describe("Working directory"),
        model: z.string().optional().describe("Model to use"),
        systemPrompt: z.string().optional().describe("System prompt"),
        thinking: z.boolean().optional().describe("Enable thinking"),
        effort: z.enum(["low", "medium", "high", "max"]).optional().describe("Thinking effort"),
      }),
    },
    {
      name: "session.send-prompt",
      description: "Send a prompt to a session (streaming or await completion)",
      inputSchema: z.object({
        sessionId: z.string().describe("Session UUID"),
        content: z.union([z.string(), z.array(z.unknown())]).describe("Prompt content"),
        cwd: z.string().optional().describe("CWD for auto-resume"),
        streaming: z.boolean().optional().default(true).describe("Stream events or await result"),
        source: z.string().optional().describe("Source for routing (e.g. imessage/+1555...)"),
      }),
    },
    {
      name: "session.interrupt-session",
      description: "Interrupt current response",
      inputSchema: z.object({
        sessionId: z.string().describe("Session UUID"),
      }),
    },
    {
      name: "session.close-session",
      description: "Close a session (kills CLI process via query.close())",
      inputSchema: z.object({
        sessionId: z.string().describe("Session UUID"),
      }),
    },
    {
      name: "session.list-sessions",
      description: "List sessions for a workspace (reads sessions-index.json)",
      inputSchema: z.object({
        cwd: z.string().describe("Workspace CWD"),
      }),
    },
    {
      name: "session.get-history",
      description: "Get session history from JSONL",
      inputSchema: z.object({
        sessionId: z.string().describe("Session UUID"),
        cwd: z.string().optional().describe("Workspace CWD for fast file lookup"),
        limit: z.number().optional().default(50).describe("Max messages"),
        offset: z.number().optional().default(0).describe("Offset from most recent"),
      }),
    },
    {
      name: "session.switch-session",
      description: "Switch active session for a workspace",
      inputSchema: z.object({
        sessionId: z.string().describe("Session UUID to switch to"),
        cwd: z.string().describe("Workspace CWD"),
        model: z.string().optional().describe("Model override"),
      }),
    },
    {
      name: "session.reset-session",
      description: "Create a replacement session for workspace",
      inputSchema: z.object({
        cwd: z.string().describe("Workspace CWD"),
        model: z.string().optional().describe("Model to use"),
      }),
    },
    {
      name: "session.get-info",
      description: "Get current session and extension info",
      inputSchema: z.object({
        sessionId: z.string().optional().describe("Session UUID (optional)"),
      }),
    },
    {
      name: "session.set-permission-mode",
      description: "Set CLI permission mode",
      inputSchema: z.object({
        sessionId: z.string().describe("Session UUID"),
        mode: z.string().describe("Permission mode"),
      }),
    },
    {
      name: "session.send-tool-result",
      description: "Send tool result for interactive tools",
      inputSchema: z.object({
        sessionId: z.string().describe("Session UUID"),
        toolUseId: z.string().describe("Tool use ID"),
        content: z.string().describe("Result content"),
        isError: z.boolean().optional().default(false).describe("Is error result"),
      }),
    },
    {
      name: "session.list-workspaces",
      description: "List all workspaces",
      inputSchema: z.object({}),
    },
    {
      name: "session.get-workspace",
      description: "Get workspace by ID",
      inputSchema: z.object({
        id: z.string().describe("Workspace ID"),
      }),
    },
    {
      name: "session.get-or-create-workspace",
      description: "Get or create workspace for CWD",
      inputSchema: z.object({
        cwd: z.string().describe("Working directory"),
        name: z.string().optional().describe("Workspace name"),
      }),
    },
    {
      name: "session.health-check",
      description: "Health status of session extension",
      inputSchema: z.object({}),
    },
  ];

  // ── Method Handler ─────────────────────────────────────────

  /** Short session ID for logging */
  const sid = (id: string) => id.slice(0, 8);

  /** Truncate prompt content for logging */
  const truncate = (content: string | unknown[], maxLen = 80): string => {
    if (typeof content === "string")
      return content.length > maxLen ? content.slice(0, maxLen) + "…" : content;
    return `[${(content as unknown[]).length} blocks]`;
  };

  async function handleMethod(method: string, params: Record<string, unknown>): Promise<unknown> {
    // Log all method calls (except high-frequency reads)
    const isRead =
      method === "session.list-sessions" ||
      method === "session.list-workspaces" ||
      method === "session.get-workspace" ||
      method === "session.health-check";
    if (!isRead) {
      log.info(
        `→ ${method}`,
        params.sessionId ? { sessionId: sid(params.sessionId as string) } : undefined,
      );
    }

    const start = Date.now();
    try {
      const result = await _handleMethod(method, params);
      const elapsed = Date.now() - start;
      if (!isRead && elapsed > 100) {
        log.info(`← ${method} OK (${elapsed}ms)`);
      }
      return result;
    } catch (err) {
      const elapsed = Date.now() - start;
      log.error(`← ${method} FAILED (${elapsed}ms)`, {
        error: err instanceof Error ? err.message : String(err),
        ...(params.sessionId ? { sessionId: sid(params.sessionId as string) } : {}),
      });
      throw err;
    }
  }

  async function _handleMethod(method: string, params: Record<string, unknown>): Promise<unknown> {
    switch (method) {
      case "session.create-session": {
        const cwd = params.cwd as string;
        const model = params.model as string | undefined;
        log.info("Creating session", { cwd, model: model || sessionConfig.model || "default" });
        const result = await manager.create({
          cwd,
          model,
          systemPrompt: params.systemPrompt as string | undefined,
          thinking: params.thinking as boolean | undefined,
          effort: params.effort as "low" | "medium" | "high" | "max" | undefined,
        });
        log.info("Session created", { sessionId: sid(result.sessionId), cwd });
        return result;
      }

      case "session.send-prompt": {
        const sessionId = params.sessionId as string;
        const content = params.content as string | unknown[];
        const cwd = params.cwd as string | undefined;
        const streaming = params.streaming !== false;
        const source = params.source as string | undefined;

        log.info("Sending prompt", {
          sessionId: sid(sessionId),
          streaming,
          source: source || "web",
          prompt: truncate(content),
        });

        // Set up request context
        requestContexts.set(sessionId, {
          connectionId: ctx.connectionId,
          source,
          responseText: "",
        });

        if (streaming) {
          // Fire and forget — events stream back via ctx.emit
          const promptStart = Date.now();
          await manager.prompt(sessionId, content, cwd);

          // Log turn completion when we see turn_stop
          const turnListener = (event: { sessionId: string; type?: string }) => {
            if (event.sessionId !== sessionId || event.type !== "turn_stop") return;
            const elapsed = Date.now() - promptStart;
            const reqCtx = requestContexts.get(sessionId);
            const responseLen = reqCtx?.responseText?.length || 0;
            log.info("Streaming turn complete", {
              sessionId: sid(sessionId),
              elapsed: `${elapsed}ms`,
              responseChars: responseLen,
            });
            manager.removeListener("session.event", turnListener);
          };
          manager.on("session.event", turnListener);

          return { status: "streaming", sessionId };
        }

        // Non-streaming: await completion, return final text
        const promptStart = Date.now();
        return new Promise<unknown>((resolve, reject) => {
          const timeout = setTimeout(() => {
            cleanup();
            log.error("Prompt timed out", { sessionId: sid(sessionId), elapsed: "300s" });
            reject(new Error("Prompt timed out after 5 minutes"));
          }, 300_000);

          const onEvent = (event: { eventName: string; sessionId: string; type?: string }) => {
            if (event.sessionId !== sessionId) return;
            if (event.type === "turn_stop") {
              cleanup();
              const reqCtx = requestContexts.get(sessionId);
              const text = reqCtx?.responseText || "";
              const elapsed = Date.now() - promptStart;
              log.info("Non-streaming prompt complete", {
                sessionId: sid(sessionId),
                elapsed: `${elapsed}ms`,
                responseChars: text.length,
              });
              resolve({ text, sessionId });
            }
          };

          const cleanup = () => {
            clearTimeout(timeout);
            manager.removeListener("session.event", onEvent);
            requestContexts.delete(sessionId);
          };

          manager.on("session.event", onEvent);
          manager.prompt(sessionId, content, cwd).catch((err) => {
            cleanup();
            reject(err);
          });
        });
      }

      case "session.interrupt-session": {
        log.info("Interrupting session", { sessionId: sid(params.sessionId as string) });
        const ok = manager.interrupt(params.sessionId as string);
        return { ok };
      }

      case "session.close-session": {
        log.info("Closing session", { sessionId: sid(params.sessionId as string) });
        await manager.close(params.sessionId as string);
        requestContexts.delete(params.sessionId as string);
        log.info("Session closed", { sessionId: sid(params.sessionId as string) });
        return { ok: true };
      }

      case "session.list-sessions": {
        const cwd = params.cwd as string;
        const sessions = discoverSessions(cwd);
        log.info("Listed sessions", { cwd, count: sessions.length });
        return {
          sessions: sessions.sort((a, b) => {
            const aTime = a.modified || a.created || "";
            const bTime = b.modified || b.created || "";
            return bTime.localeCompare(aTime); // Descending by recency
          }),
        };
      }

      case "session.get-history": {
        const sessionId = params.sessionId as string;
        const cwd = params.cwd as string | undefined;
        const limit = (params.limit as number) || 50;
        const offset = (params.offset as number) || 0;

        const filepath = resolveSessionPath(sessionId, cwd);
        if (!filepath) {
          log.warn("Session file not found", { sessionId: sid(sessionId), cwd: cwd || "none" });
          return { messages: [], total: 0, hasMore: false };
        }

        const result = parseSessionFilePaginated(filepath, { limit, offset });
        log.info("Loaded history", {
          sessionId: sid(sessionId),
          total: (result as { total: number }).total,
          limit,
          offset,
        });
        return result;
      }

      case "session.switch-session": {
        const sessionId = params.sessionId as string;
        const cwd = params.cwd as string;
        const model = params.model as string | undefined;

        log.info("Switching session", { sessionId: sid(sessionId), cwd, model });
        await manager.resume({
          sessionId,
          cwd,
          model,
        });
        return { sessionId };
      }

      case "session.reset-session": {
        const cwd = params.cwd as string;
        log.info("Resetting session", { cwd });
        const result = await manager.create({
          cwd,
          model: params.model as string | undefined,
        });
        return result;
      }

      case "session.get-info": {
        const sessionId = params.sessionId as string | undefined;
        const activeSessions = manager.list();

        if (sessionId) {
          const session = activeSessions.find((s) => s.id === sessionId);
          return { session: session || null, activeSessions };
        }

        return { activeSessions };
      }

      case "session.set-permission-mode": {
        log.info("Setting permission mode", {
          sessionId: sid(params.sessionId as string),
          mode: params.mode,
        });
        const ok = manager.setPermissionMode(params.sessionId as string, params.mode as string);
        return { ok };
      }

      case "session.send-tool-result": {
        log.info("Sending tool result", {
          sessionId: sid(params.sessionId as string),
          toolUseId: params.toolUseId,
          isError: params.isError,
        });
        const ok = manager.sendToolResult(
          params.sessionId as string,
          params.toolUseId as string,
          params.content as string,
          params.isError as boolean,
        );
        return { ok };
      }

      case "session.list-workspaces": {
        return { workspaces: listWorkspaces() };
      }

      case "session.get-workspace": {
        const workspace = getWorkspace(params.id as string);
        return { workspace };
      }

      case "session.get-or-create-workspace": {
        const cwd = params.cwd as string;
        const result = getOrCreateWorkspace(cwd, params.name as string | undefined);
        log.info("Get/create workspace", {
          cwd,
          created: (result as { created: boolean }).created,
        });
        return result;
      }

      case "session.health-check": {
        return health();
      }

      default:
        throw new Error(`Unknown method: ${method}`);
    }
  }

  // ── Health Check ───────────────────────────────────────────

  function health(): HealthCheckResponse {
    const sessions = manager.list();
    return {
      ok: true,
      status: "healthy",
      label: "Sessions",
      metrics: [{ label: "Active Sessions", value: sessions.length }],
      actions: [
        {
          method: "session.close-session",
          label: "Close",
          confirm: "Close this session?",
          params: [{ name: "sessionId", source: "item.id" }],
          scope: "item",
        },
      ],
      items: sessions.map((s) => ({
        id: s.id,
        label: s.cwd,
        status: s.healthy ? (s.stale ? "stale" : "healthy") : "dead",
        details: {
          model: s.model,
          lastActivity: s.lastActivity,
        },
      })),
    };
  }

  // ── Extension Interface ────────────────────────────────────

  return {
    id: "session",
    name: "Session Manager",
    methods,
    events: ["stream.*"],
    sourceRoutes: [],

    async start(extCtx: ExtensionContext): Promise<void> {
      ctx = extCtx;
      log.info("Session extension started");
    },

    async stop(): Promise<void> {
      await manager.closeAll();
      closeDb();
      log.info("Session extension stopped");
    },

    handleMethod,

    health,
  };
}
