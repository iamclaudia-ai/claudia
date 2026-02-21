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
import { existsSync, readFileSync, readdirSync } from "node:fs";
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

// ── sessions-index.json ──────────────────────────────────────

interface SessionIndexEntry {
  sessionId: string;
  created?: string;
  modified?: string;
  messageCount?: number;
  firstPrompt?: string;
  gitBranch?: string;
}

/**
 * Read sessions from Claude Code's filesystem index.
 * Sessions live at ~/.claude/projects/{encoded-cwd}/sessions-index.json
 */
function readSessionsIndex(cwd: string): SessionIndexEntry[] {
  const projectsDir = join(homedir(), ".claude", "projects");
  if (!existsSync(projectsDir)) return [];

  // Encode cwd the same way Claude Code does (replace / with %)
  const encodedCwd = cwd.replace(/\//g, "%");
  const indexPath = join(projectsDir, encodedCwd, "sessions-index.json");

  if (!existsSync(indexPath)) {
    // Try alternative encoding: base64
    const entries = readdirSync(projectsDir);
    for (const entry of entries) {
      const sessionsIndexPath = join(projectsDir, entry, "sessions-index.json");
      if (existsSync(sessionsIndexPath)) {
        try {
          const data = JSON.parse(readFileSync(sessionsIndexPath, "utf-8"));
          // Check if this directory matches our cwd
          if (Array.isArray(data)) {
            // Look for any JSONL file to check cwd match
            const dirPath = join(projectsDir, entry);
            const jsonlFiles = readdirSync(dirPath).filter((f) => f.endsWith(".jsonl"));
            if (jsonlFiles.length > 0) {
              // Read first line of first jsonl to check cwd
              const firstJsonl = join(dirPath, jsonlFiles[0]!);
              const firstLine = readFileSync(firstJsonl, "utf-8").split("\n")[0];
              if (firstLine) {
                try {
                  const parsed = JSON.parse(firstLine);
                  if (parsed.cwd === cwd) {
                    return data;
                  }
                } catch {
                  // skip
                }
              }
            }
          }
        } catch {
          // skip
        }
      }
    }
    return [];
  }

  try {
    const data = JSON.parse(readFileSync(indexPath, "utf-8"));
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
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

  async function handleMethod(method: string, params: Record<string, unknown>): Promise<unknown> {
    switch (method) {
      case "session.create-session": {
        const result = await manager.create({
          cwd: params.cwd as string,
          model: params.model as string | undefined,
          systemPrompt: params.systemPrompt as string | undefined,
          thinking: params.thinking as boolean | undefined,
          effort: params.effort as "low" | "medium" | "high" | "max" | undefined,
        });
        return result;
      }

      case "session.send-prompt": {
        const sessionId = params.sessionId as string;
        const content = params.content as string | unknown[];
        const cwd = params.cwd as string | undefined;
        const streaming = params.streaming !== false;
        const source = params.source as string | undefined;

        // Set up request context
        requestContexts.set(sessionId, {
          connectionId: ctx.connectionId,
          source,
          responseText: "",
        });

        if (streaming) {
          // Fire and forget — events stream back via ctx.emit
          await manager.prompt(sessionId, content, cwd);
          return { status: "streaming", sessionId };
        }

        // Non-streaming: await completion, return final text
        return new Promise<unknown>((resolve, reject) => {
          const timeout = setTimeout(() => {
            cleanup();
            reject(new Error("Prompt timed out after 5 minutes"));
          }, 300_000);

          const onEvent = (event: { eventName: string; sessionId: string; type?: string }) => {
            if (event.sessionId !== sessionId) return;
            if (event.type === "turn_stop") {
              cleanup();
              const reqCtx = requestContexts.get(sessionId);
              resolve({ text: reqCtx?.responseText || "", sessionId });
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
        const ok = manager.interrupt(params.sessionId as string);
        return { ok };
      }

      case "session.close-session": {
        await manager.close(params.sessionId as string);
        requestContexts.delete(params.sessionId as string);
        return { ok: true };
      }

      case "session.list-sessions": {
        const sessions = readSessionsIndex(params.cwd as string);
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
        const limit = (params.limit as number) || 50;
        const offset = (params.offset as number) || 0;

        const filepath = resolveSessionPath(sessionId);
        if (!filepath) {
          return { messages: [], total: 0, hasMore: false };
        }

        return parseSessionFilePaginated(filepath, { limit, offset });
      }

      case "session.switch-session": {
        const sessionId = params.sessionId as string;
        const cwd = params.cwd as string;
        const model = params.model as string | undefined;

        await manager.resume({
          sessionId,
          cwd,
          model,
        });
        return { sessionId };
      }

      case "session.reset-session": {
        const result = await manager.create({
          cwd: params.cwd as string,
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
        const ok = manager.setPermissionMode(params.sessionId as string, params.mode as string);
        return { ok };
      }

      case "session.send-tool-result": {
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
        const result = getOrCreateWorkspace(
          params.cwd as string,
          params.name as string | undefined,
        );
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
