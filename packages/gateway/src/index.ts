/**
 * Claudia Gateway
 *
 * The heart of Claudia - manages Claude Code sessions, routes messages
 * between clients and extensions, broadcasts events.
 *
 * Single server: serves both the web UI (SPA) and WebSocket on port 30086.
 */

import type { ServerWebSocket } from "bun";
import type {
  Request,
  Response as GatewayResponse,
  Event,
  Message,
  GatewayEvent,
} from "@claudia/shared";
import { loadConfig, createLogger } from "@claudia/shared";
export type { GatewayEvent };
import { existsSync } from "node:fs";
import { join } from "node:path";
import { ExtensionManager } from "./extensions";
import { getDb, closeDb } from "./db/index";
import { SessionManager } from "./session-manager";
import { homedir } from "node:os";
import { z, type ZodTypeAny } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

// Web UI — served as SPA fallback for all non-WS routes
import index from "./web/index.html";

// Load configuration (claudia.json or env var fallback)
const config = loadConfig();
const PORT = config.gateway.port;
const DATA_DIR = process.env.CLAUDIA_DATA_DIR || join(homedir(), ".claudia");

// Structured logger — writes to console + ~/.claudia/logs/gateway.log
const log = createLogger("Gateway", join(DATA_DIR, "logs", "gateway.log"));

// Ensure data directory exists
if (!existsSync(DATA_DIR)) {
  await Bun.write(join(DATA_DIR, ".gitkeep"), "");
}

interface ClientState {
  id: string;
  connectedAt: Date;
  subscriptions: Set<string>;
}

// Client connections
const clients = new Map<ServerWebSocket<ClientState>, ClientState>();

// Maps streamId → connectionId for connection-scoped voice routing.
// When a client sends a prompt with speakResponse=true, we record which
// connection originated the voice stream so audio events route only to it.
const voiceStreamOrigins = new Map<string, string>();

// ── Client Health Beacon ─────────────────────────────────────
// Tracks client-side errors and heartbeats for the watchdog.
// Errors are event-driven (pushed immediately), health is inferred
// from heartbeat freshness + absence of recent errors.

interface ClientErrorReport {
  type: "react" | "runtime" | "unhandled_rejection";
  message: string;
  stack?: string;
  componentStack?: string;
  url: string;
  timestamp: string;
  userAgent: string;
  receivedAt: number;
}

const MAX_CLIENT_ERRORS = 20;
const CLIENT_ERROR_TTL = 5 * 60 * 1000; // Keep errors for 5 minutes
const clientErrors: ClientErrorReport[] = [];
let lastClientHeartbeat: number | null = null;
let lastClientRendered: boolean | null = null;

function addClientError(error: Omit<ClientErrorReport, "receivedAt">): void {
  // Deduplicate: if the last error has the same message, just update its timestamp
  const last = clientErrors[clientErrors.length - 1];
  if (last && last.message === error.message) {
    last.receivedAt = Date.now();
    last.timestamp = error.timestamp;
    return;
  }

  clientErrors.push({ ...error, receivedAt: Date.now() });
  // Trim old errors
  const cutoff = Date.now() - CLIENT_ERROR_TTL;
  while (clientErrors.length > 0 && clientErrors[0].receivedAt < cutoff) {
    clientErrors.shift();
  }
  // Cap size
  while (clientErrors.length > MAX_CLIENT_ERRORS) {
    clientErrors.shift();
  }
  log.warn("Client error reported", { type: error.type, message: error.message.slice(0, 200) });
}

function getClientHealth(): {
  healthy: boolean;
  rendered: boolean | null;
  lastHeartbeat: string | null;
  heartbeatAge: number | null;
  recentErrors: number;
  errors: ClientErrorReport[];
} {
  // Prune stale errors
  const cutoff = Date.now() - CLIENT_ERROR_TTL;
  while (clientErrors.length > 0 && clientErrors[0].receivedAt < cutoff) {
    clientErrors.shift();
  }

  const heartbeatAge = lastClientHeartbeat ? Date.now() - lastClientHeartbeat : null;
  const noErrors = clientErrors.length === 0;
  const heartbeatFresh = heartbeatAge === null || heartbeatAge < 120_000;
  const rendered = lastClientRendered !== false; // null (no data yet) is OK

  return {
    healthy: noErrors && heartbeatFresh && rendered,
    rendered: lastClientRendered,
    lastHeartbeat: lastClientHeartbeat ? new Date(lastClientHeartbeat).toISOString() : null,
    heartbeatAge,
    recentErrors: clientErrors.length,
    errors: clientErrors,
  };
}

// Extension manager
const extensions = new ExtensionManager();

// Initialize database
const db = getDb();

// Session manager (replaces old singleton session)
const sessionManager = new SessionManager({
  db,
  dataDir: DATA_DIR,
  config,
  broadcastEvent,
  broadcastExtension: (event) => extensions.broadcast(event),
  routeToSource: (source, event) => extensions.routeToSource(source, event),
});

// Migrate legacy .session-id file if present
await sessionManager.migrateLegacySession();

// Connect to the session runtime service
sessionManager.connectToRuntime();

// Wire up extension event emitting to broadcast
extensions.setEmitCallback(async (type, payload, source) => {
  const payloadObj =
    payload && typeof payload === "object" ? (payload as Record<string, unknown>) : null;

  // Track voice stream origins for connection-scoped routing
  if (type === "voice.stream_start" && payloadObj?.streamId) {
    const connectionId = sessionManager.currentRequestConnectionId;
    if (connectionId) {
      voiceStreamOrigins.set(payloadObj.streamId as string, connectionId);
    }
  }
  if (type === "voice.stream_end" && payloadObj?.streamId) {
    voiceStreamOrigins.delete(payloadObj.streamId as string);
  }

  broadcastEvent(type, payload, source);

  // Handle prompt requests from extensions (e.g., iMessage)
  if (type.endsWith(".prompt_request")) {
    const req = payload as {
      content: string | unknown[];
      source?: string;
      sessionId?: string;
      model?: string;
      thinking?: boolean;
      effort?: string;
      metadata?: Record<string, unknown>;
    };

    if (req.content) {
      const isMultimodal = Array.isArray(req.content);
      const preview = isMultimodal
        ? `[${req.content.length} content blocks]`
        : `"${String(req.content).substring(0, 50)}..."`;
      log.info("Prompt request", { source, preview });

      // Set request context for routing
      sessionManager.currentRequestWantsVoice = false;
      sessionManager.currentRequestSource = req.source || null;
      sessionManager.currentRequestConnectionId = null;
      sessionManager.currentResponseText = "";

      // Send prompt through session manager with explicit session targeting/config.
      if (!req.sessionId || !req.model || req.thinking === undefined || !req.effort) {
        log.warn(
          "Ignoring prompt_request with missing required params: sessionId/model/thinking/effort",
        );
        return;
      }
      await sessionManager.prompt(req.content as string | unknown[], req.sessionId, {
        model: req.model,
        thinking: req.thinking,
        effort: req.effort,
      });
    }
  }
});

// Generate unique IDs
const generateId = () => crypto.randomUUID();

type GatewayMethodDefinition = {
  method: string;
  description: string;
  inputSchema: ZodTypeAny;
};

const BUILTIN_METHODS: GatewayMethodDefinition[] = [
  {
    method: "workspace.list",
    description: "List all workspaces",
    inputSchema: z.object({}),
  },
  {
    method: "workspace.get",
    description: "Get one workspace by id",
    inputSchema: z.object({ workspaceId: z.string().min(1) }),
  },
  {
    method: "workspace.getOrCreate",
    description: "Get or create a workspace for an explicit cwd",
    inputSchema: z.object({
      cwd: z.string().min(1),
      name: z.string().optional(),
    }),
  },
  {
    method: "workspace.listSessions",
    description: "List sessions for a specific workspace",
    inputSchema: z.object({ workspaceId: z.string().min(1) }),
  },
  {
    method: "workspace.createSession",
    description: "Create a new session for a workspace with explicit runtime config",
    inputSchema: z.object({
      workspaceId: z.string().min(1),
      model: z.string().min(1),
      thinking: z.boolean(),
      effort: z.string().min(1),
      title: z.string().optional(),
      systemPrompt: z.string().optional(),
    }),
  },
  {
    method: "session.info",
    description: "Get current runtime/session info",
    inputSchema: z.object({}),
  },
  {
    method: "session.prompt",
    description: "Send prompt to explicit session with explicit runtime config",
    inputSchema: z.object({
      sessionId: z.string().min(1),
      content: z.union([z.string(), z.array(z.unknown())]),
      model: z.string().min(1),
      thinking: z.boolean(),
      effort: z.string().min(1),
      speakResponse: z.boolean().optional(),
      source: z.string().optional(),
    }),
  },
  {
    method: "session.interrupt",
    description: "Interrupt a specific session",
    inputSchema: z.object({ sessionId: z.string().min(1) }),
  },
  {
    method: "session.permissionMode",
    description:
      "Set the permission mode for a session (bypassPermissions, acceptEdits, plan, default)",
    inputSchema: z.object({
      sessionId: z.string().min(1),
      mode: z.enum(["bypassPermissions", "acceptEdits", "plan", "default", "delegate", "dontAsk"]),
    }),
  },
  {
    method: "session.toolResult",
    description:
      "Send a tool_result for an interactive tool (ExitPlanMode, EnterPlanMode, AskUserQuestion)",
    inputSchema: z.object({
      sessionId: z.string().min(1),
      toolUseId: z.string().min(1),
      content: z.string(),
      isError: z.boolean().optional(),
    }),
  },
  {
    method: "session.get",
    description: "Get one session record by id",
    inputSchema: z.object({ sessionId: z.string().min(1) }),
  },
  {
    method: "session.history",
    description: "Get history for a specific session",
    inputSchema: z.object({
      sessionId: z.string().min(1),
      limit: z.number().int().positive().optional(),
      offset: z.number().int().min(0).optional(),
    }),
  },
  {
    method: "session.switch",
    description: "Switch runtime to an explicit session id",
    inputSchema: z.object({ sessionId: z.string().min(1) }),
  },
  {
    method: "session.reset",
    description: "Create a replacement session for a workspace with explicit runtime config",
    inputSchema: z.object({
      workspaceId: z.string().min(1),
      model: z.string().min(1),
      thinking: z.boolean(),
      effort: z.string().min(1),
      systemPrompt: z.string().optional(),
    }),
  },
  {
    method: "extension.list",
    description: "List loaded extensions and their methods",
    inputSchema: z.object({}),
  },
  {
    method: "method.list",
    description: "List gateway and extension methods with schemas",
    inputSchema: z.object({}),
  },
  {
    method: "subscribe",
    description: "Subscribe to events",
    inputSchema: z.object({
      events: z.array(z.string()).optional(),
    }),
  },
  {
    method: "unsubscribe",
    description: "Unsubscribe from events",
    inputSchema: z.object({
      events: z.array(z.string()).optional(),
    }),
  },
  {
    method: "runtime.health-check",
    description: "Return runtime session health status for Mission Control",
    inputSchema: z.object({}),
  },
  {
    method: "runtime.kill-session",
    description: "Kill a Claude process on the runtime",
    inputSchema: z.object({
      sessionId: z.string().min(1),
    }),
  },
];

const BUILTIN_METHODS_BY_NAME = new Map(BUILTIN_METHODS.map((m) => [m.method, m] as const));

/**
 * Handle incoming WebSocket messages
 */
function handleMessage(ws: ServerWebSocket<ClientState>, data: string): void {
  try {
    const message: Message = JSON.parse(data);

    if (message.type === "req") {
      handleRequest(ws, message);
    }
  } catch (error) {
    log.error("Failed to parse message", { error: String(error) });
    sendError(ws, "unknown", "Invalid message format");
  }
}

/**
 * Route requests to handlers
 */
function handleRequest(ws: ServerWebSocket<ClientState>, req: Request): void {
  const methodDef = BUILTIN_METHODS_BY_NAME.get(req.method);
  if (methodDef) {
    const parsed = methodDef.inputSchema.safeParse(req.params ?? {});
    if (!parsed.success) {
      const issues = parsed.error.issues.map(
        (i) => `${i.path.join(".") || "params"}: ${i.message}`,
      );
      sendError(ws, req.id, `Invalid params for ${req.method}: ${issues.join("; ")}`);
      return;
    }
    req.params = parsed.data as Record<string, unknown>;
  }

  const [namespace, action] = req.method.split(".");

  switch (namespace) {
    case "session":
      handleSessionMethod(ws, req, action);
      break;
    case "workspace":
      handleWorkspaceMethod(ws, req, action);
      break;
    case "extension":
      handleExtensionBuiltin(ws, req, action);
      break;
    case "runtime":
      handleRuntimeMethod(ws, req, action);
      break;
    case "method":
      handleMethodBuiltin(ws, req, action);
      break;
    case "subscribe":
      handleSubscribe(ws, req);
      break;
    case "unsubscribe":
      handleUnsubscribe(ws, req);
      break;
    default:
      // Check if an extension handles this method
      if (extensions.hasMethod(req.method)) {
        handleExtensionMethod(ws, req);
      } else {
        sendError(ws, req.id, `Unknown method: ${req.method}`);
      }
  }
}

function handleMethodBuiltin(ws: ServerWebSocket<ClientState>, req: Request, action: string): void {
  switch (action) {
    case "list": {
      const builtin = BUILTIN_METHODS.map((m) => ({
        method: m.method,
        source: "gateway",
        description: m.description,
        inputSchema: zodToJsonSchema(m.inputSchema, m.method),
      }));
      const extensionMethods = extensions.getMethodDefinitions().map((m) => {
        // Remote extensions don't have Zod schemas — their inputSchema is a plain object
        let inputSchema: unknown;
        try {
          inputSchema = zodToJsonSchema(m.method.inputSchema, m.method.name);
        } catch {
          inputSchema = m.method.inputSchema ?? {};
        }
        let outputSchema: unknown;
        if (m.method.outputSchema) {
          try {
            outputSchema = zodToJsonSchema(m.method.outputSchema, `${m.method.name}.output`);
          } catch {
            outputSchema = m.method.outputSchema;
          }
        }
        return {
          method: m.method.name,
          source: "extension",
          extensionId: m.extensionId,
          extensionName: m.extensionName,
          description: m.method.description,
          inputSchema,
          outputSchema,
        };
      });
      sendResponse(ws, req.id, { methods: [...builtin, ...extensionMethods] });
      break;
    }
    default:
      sendError(ws, req.id, `Unknown method action: ${action}`);
  }
}

/**
 * Handle workspace methods
 */
async function handleWorkspaceMethod(
  ws: ServerWebSocket<ClientState>,
  req: Request,
  action: string,
): Promise<void> {
  try {
    switch (action) {
      case "list": {
        const workspaces = sessionManager.listWorkspaces();
        sendResponse(ws, req.id, { workspaces });
        break;
      }

      case "get": {
        const workspaceId = req.params?.workspaceId as string;
        if (!workspaceId) {
          sendError(ws, req.id, "Missing workspaceId parameter");
          return;
        }
        const workspace = sessionManager.getWorkspace(workspaceId);
        if (!workspace) {
          sendError(ws, req.id, `Workspace not found: ${workspaceId}`);
          return;
        }
        sendResponse(ws, req.id, { workspace });
        break;
      }

      case "getOrCreate": {
        const cwd = req.params?.cwd as string;
        if (!cwd) {
          sendError(
            ws,
            req.id,
            "Missing cwd parameter — workspace.getOrCreate requires an explicit CWD",
          );
          return;
        }
        const name = req.params?.name as string | undefined;
        const result = sessionManager.getOrCreateWorkspace(cwd, name);
        sendResponse(ws, req.id, result);
        break;
      }

      case "listSessions": {
        const workspaceId = req.params?.workspaceId as string;
        if (!workspaceId) {
          sendError(ws, req.id, "Missing workspaceId parameter");
          return;
        }
        const sessions = sessionManager.listSessions(workspaceId);
        sendResponse(ws, req.id, { sessions });
        break;
      }

      case "createSession": {
        const workspaceId = req.params?.workspaceId as string;
        const model = req.params?.model as string;
        const thinking = req.params?.thinking as boolean | undefined;
        const effort = req.params?.effort as string | undefined;
        if (!workspaceId) {
          sendError(ws, req.id, "Missing workspaceId parameter");
          return;
        }
        if (!model || thinking === undefined || !effort) {
          sendError(ws, req.id, "Missing required params: model, thinking, and effort");
          return;
        }
        const title = req.params?.title as string | undefined;
        const systemPrompt = req.params?.systemPrompt as string | undefined;
        const result = await sessionManager.createNewSession(workspaceId, title, {
          model,
          thinking,
          effort,
          systemPrompt,
        });
        sendResponse(ws, req.id, result);
        break;
      }

      default:
        sendError(ws, req.id, `Unknown workspace action: ${action}`);
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    sendError(ws, req.id, errorMessage);
  }
}

/**
 * Handle extension discovery methods (built-in, not routed to extensions)
 */
function handleExtensionBuiltin(
  ws: ServerWebSocket<ClientState>,
  req: Request,
  action: string,
): void {
  switch (action) {
    case "list": {
      // Include real extensions + synthetic "runtime" entry for Mission Control discovery
      const extensionList = [
        ...extensions.getExtensionList(),
        {
          id: "runtime",
          name: "Runtime Sessions",
          methods: ["runtime.health-check", "runtime.kill-session"],
        },
      ];
      sendResponse(ws, req.id, { extensions: extensionList });
      break;
    }
    default:
      sendError(ws, req.id, `Unknown extension action: ${action}`);
  }
}

/**
 * Handle runtime methods — runtime.health-check, runtime.kill-session
 * These are "virtual" extension methods that query the runtime service directly.
 * Mission Control auto-discovers them via the synthetic "runtime" entry in extension.list.
 */
async function handleRuntimeMethod(
  ws: ServerWebSocket<ClientState>,
  req: Request,
  action: string,
): Promise<void> {
  const runtimeHost = config.runtime?.host || "localhost";
  const runtimePort = config.runtime?.port || 30087;
  const runtimeUrl = `http://${runtimeHost}:${runtimePort}`;

  try {
    switch (action) {
      case "health-check": {
        // Query the runtime's /health endpoint
        let runtimeData: {
          status: string;
          clients: number;
          sessions: Array<{
            id: string;
            cwd: string;
            model: string;
            isActive: boolean;
            isProcessRunning: boolean;
            createdAt?: string;
            lastActivity?: string;
            healthy?: boolean;
            stale?: boolean;
          }>;
        };

        try {
          const res = await fetch(`${runtimeUrl}/health`);
          runtimeData = await res.json();
        } catch {
          // Runtime is unreachable
          sendResponse(ws, req.id, {
            ok: false,
            status: "disconnected",
            label: "Runtime Sessions",
            metrics: [{ label: "Status", value: "disconnected" }],
          });
          return;
        }

        const sessions = runtimeData.sessions || [];
        const activeSessions = sessions.filter((s) => s.isActive);

        // Build health items from runtime sessions
        const items = sessions.map((s) => {
          const lastActivity = s.lastActivity ? formatTimeAgo(new Date(s.lastActivity)) : "unknown";

          // Determine status
          let status: "healthy" | "stale" | "dead" | "inactive" = "inactive";
          if (s.healthy) status = "healthy";
          else if (s.stale) status = "stale";
          else if (s.isActive && !s.isProcessRunning) status = "dead";
          else if (s.isActive) status = "healthy";

          // Shorten cwd for display
          const cwdLabel = s.cwd.replace(homedir(), "~");
          const modelShort = s.model.replace("claude-", "").replace(/-\d+$/, "");

          return {
            id: s.id,
            label: `${cwdLabel} (${modelShort})`,
            status,
            details: {
              model: modelShort,
              lastActivity,
              process: s.isProcessRunning ? "running" : "stopped",
            },
          };
        });

        sendResponse(ws, req.id, {
          ok: true,
          status: activeSessions.length > 0 ? "healthy" : "inactive",
          label: "Runtime Sessions",
          metrics: [
            { label: "Active Sessions", value: activeSessions.length },
            {
              label: "Runtime",
              value: sessionManager.isRuntimeConnected ? "connected" : "disconnected",
            },
          ],
          items,
          actions: [
            {
              method: "runtime.kill-session",
              label: "Kill",
              confirm: "Kill this Claude process?",
              params: [{ name: "sessionId", source: "item.id" }],
              scope: "item",
            },
          ],
        });
        break;
      }

      case "kill-session": {
        const sessionId = req.params?.sessionId as string;
        if (!sessionId) {
          sendError(ws, req.id, "Missing sessionId parameter");
          return;
        }

        // Kill via runtime HTTP endpoint
        const res = await fetch(`${runtimeUrl}/session/${sessionId}`, { method: "DELETE" });
        const result = await res.json();
        sendResponse(ws, req.id, result);
        break;
      }

      default:
        sendError(ws, req.id, `Unknown runtime action: ${action}`);
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    sendError(ws, req.id, errorMessage);
  }
}

/**
 * Format a Date as a human-readable "X ago" string
 */
function formatTimeAgo(date: Date): string {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

/**
 * Handle session methods
 */
async function handleSessionMethod(
  ws: ServerWebSocket<ClientState>,
  req: Request,
  action: string,
): Promise<void> {
  try {
    switch (action) {
      case "info": {
        sendResponse(ws, req.id, sessionManager.getInfo());
        break;
      }

      case "prompt": {
        const content = req.params?.content as string | unknown[];
        const targetSessionId = req.params?.sessionId as string;
        const model = req.params?.model as string;
        const thinking = req.params?.thinking as boolean | undefined;
        const effort = req.params?.effort as string | undefined;
        if (!content) {
          sendError(ws, req.id, "Missing content parameter");
          return;
        }
        if (!targetSessionId) {
          sendError(ws, req.id, "Missing sessionId parameter");
          return;
        }
        if (!model || thinking === undefined || !effort) {
          sendError(ws, req.id, "Missing required params: model, thinking, and effort");
          return;
        }

        // Track request metadata for routing
        sessionManager.currentRequestWantsVoice = req.params?.speakResponse === true;
        sessionManager.currentRequestSource = (req.params?.source as string) || null;
        sessionManager.currentRequestConnectionId = req.params?.speakResponse ? ws.data.id : null;

        // Send prompt through session manager
        const ccSessionId = await sessionManager.prompt(content, targetSessionId, {
          model,
          thinking,
          effort,
        });
        sendResponse(ws, req.id, {
          status: "ok",
          sessionId: ccSessionId,
          source: sessionManager.currentRequestSource,
        });
        break;
      }

      case "interrupt": {
        const sessionId = req.params?.sessionId as string;
        if (!sessionId) {
          sendError(ws, req.id, "Missing sessionId parameter");
          return;
        }
        const interrupted = await sessionManager.interrupt(sessionId);
        if (interrupted) {
          sendResponse(ws, req.id, { status: "interrupted" });
        } else {
          sendError(ws, req.id, `Session not found or not interruptible: ${sessionId}`);
        }
        break;
      }

      case "permissionMode": {
        const sessionId = req.params?.sessionId as string;
        const mode = req.params?.mode as string;
        if (!sessionId || !mode) {
          sendError(ws, req.id, "Missing sessionId or mode parameter");
          return;
        }
        const ok = await sessionManager.setPermissionMode(sessionId, mode);
        if (ok) {
          sendResponse(ws, req.id, { status: "ok", mode });
        } else {
          sendError(ws, req.id, `Session not found: ${sessionId}`);
        }
        break;
      }

      case "toolResult": {
        const sessionId = req.params?.sessionId as string;
        const toolUseId = req.params?.toolUseId as string;
        const content = req.params?.content as string;
        const isError = (req.params?.isError as boolean) || false;
        if (!sessionId || !toolUseId || content === undefined) {
          sendError(ws, req.id, "Missing sessionId, toolUseId, or content parameter");
          return;
        }
        const ok = await sessionManager.sendToolResult(sessionId, toolUseId, content, isError);
        if (ok) {
          sendResponse(ws, req.id, { status: "ok" });
        } else {
          sendError(ws, req.id, `Session not found: ${sessionId}`);
        }
        break;
      }

      case "get": {
        const getSessionId = req.params?.sessionId as string;
        if (!getSessionId) {
          sendError(ws, req.id, "Missing sessionId parameter");
          return;
        }
        const sessionRecord = sessionManager.getSession(getSessionId);
        if (!sessionRecord) {
          sendError(ws, req.id, `Session not found: ${getSessionId}`);
          return;
        }
        sendResponse(ws, req.id, { session: sessionRecord });
        break;
      }

      case "history": {
        const historySessionId = req.params?.sessionId as string;
        if (!historySessionId) {
          sendError(ws, req.id, "Missing sessionId parameter");
          return;
        }
        const limit = req.params?.limit as number | undefined;
        const offset = req.params?.offset as number | undefined;
        const result = sessionManager.getSessionHistory(
          historySessionId,
          limit ? { limit, offset: offset || 0 } : undefined,
        );
        // Include offset in response so client can distinguish initial vs load-more
        sendResponse(ws, req.id, { ...result, offset: offset || 0 });
        break;
      }

      case "switch": {
        const sessionId = req.params?.sessionId as string;
        if (!sessionId) {
          sendError(ws, req.id, "Missing sessionId parameter");
          return;
        }
        const sessionRecord = await sessionManager.switchSession(sessionId);
        sendResponse(ws, req.id, { session: sessionRecord });
        break;
      }

      case "reset": {
        const workspaceId = req.params?.workspaceId as string;
        const model = req.params?.model as string;
        const thinking = req.params?.thinking as boolean | undefined;
        const effort = req.params?.effort as string | undefined;
        if (!workspaceId || !model || thinking === undefined || !effort) {
          sendError(ws, req.id, "Missing required params: workspaceId/model/thinking/effort");
          return;
        }
        await sessionManager.createNewSession(workspaceId, undefined, {
          model,
          thinking,
          effort,
          systemPrompt: req.params?.systemPrompt as string | undefined,
        });
        sendResponse(ws, req.id, { status: "reset" });
        break;
      }

      default:
        sendError(ws, req.id, `Unknown session action: ${action}`);
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    sendError(ws, req.id, errorMessage);
  }
}

/**
 * Handle extension method calls
 */
async function handleExtensionMethod(
  ws: ServerWebSocket<ClientState>,
  req: Request,
): Promise<void> {
  try {
    const result = await extensions.handleMethod(
      req.method,
      (req.params as Record<string, unknown>) || {},
    );
    sendResponse(ws, req.id, result);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    sendError(ws, req.id, errorMessage);
  }
}

/**
 * Handle subscription requests
 */
function handleSubscribe(ws: ServerWebSocket<ClientState>, req: Request): void {
  const state = clients.get(ws);
  if (!state) return;

  const events = (req.params?.events as string[]) || [];
  events.forEach((event) => state.subscriptions.add(event));

  sendResponse(ws, req.id, { subscribed: events });
}

/**
 * Handle unsubscription requests
 */
function handleUnsubscribe(ws: ServerWebSocket<ClientState>, req: Request): void {
  const state = clients.get(ws);
  if (!state) return;

  const events = (req.params?.events as string[]) || [];
  events.forEach((event) => state.subscriptions.delete(event));

  sendResponse(ws, req.id, { unsubscribed: events });
}

/**
 * Send a response to a client
 */
function sendResponse(ws: ServerWebSocket<ClientState>, id: string, payload: unknown): void {
  const response: GatewayResponse = { type: "res", id, ok: true, payload };
  ws.send(JSON.stringify(response));
}

/**
 * Send an error response to a client
 */
function sendError(ws: ServerWebSocket<ClientState>, id: string, error: string): void {
  const response: GatewayResponse = { type: "res", id, ok: false, error };
  ws.send(JSON.stringify(response));
}

/**
 * Broadcast an event to subscribed clients
 */
function broadcastEvent(eventName: string, payload: unknown, _source?: string): void {
  const event: Event = { type: "event", event: eventName, payload };
  const data = JSON.stringify(event);
  const payloadObj =
    payload && typeof payload === "object" ? (payload as Record<string, unknown>) : null;
  const payloadSessionId =
    typeof payloadObj?.sessionId === "string" ? (payloadObj.sessionId as string) : null;

  // Connection-scoped routing: DISABLED for debugging — voice events not reaching browser
  // TODO: re-enable once root cause is found
  // const streamId =
  //   typeof payloadObj?.streamId === "string" ? (payloadObj.streamId as string) : null;
  // const targetConnectionId = streamId ? (voiceStreamOrigins.get(streamId) ?? null) : null;
  // const isConnectionScoped = eventName.startsWith("voice.") && targetConnectionId !== null;
  //
  // if (isConnectionScoped) {
  //   for (const [ws, state] of clients) {
  //     if (state.id === targetConnectionId) {
  //       ws.send(data);
  //       break;
  //     }
  //   }
  //   return;
  // }

  // For voice events, check standard subscription matching for all clients
  for (const [ws, state] of clients) {
    // Check if client is subscribed to this event
    const isSubscribed = Array.from(state.subscriptions).some((pattern) => {
      if (pattern === "*") return true;
      if (pattern === eventName) return true;
      if (pattern.endsWith(".*")) {
        const prefix = pattern.slice(0, -2);
        return eventName.startsWith(prefix + ".");
      }
      return false;
    });

    if (isSubscribed) {
      ws.send(data);
    }
  }
}

// Combined HTTP + WebSocket server (single port, like claudia-code)
const server = Bun.serve<ClientState>({
  port: PORT,
  reusePort: true,
  // Custom fetch handler for WebSocket upgrades
  fetch(req, server) {
    const url = new URL(req.url);

    // WebSocket upgrade — only on /ws
    if (url.pathname === "/ws") {
      const upgraded = server.upgrade(req, {
        data: {
          id: generateId(),
          connectedAt: new Date(),
          subscriptions: new Set<string>(),
        },
      });

      if (upgraded) return undefined as unknown as globalThis.Response;
      return new globalThis.Response("WebSocket upgrade failed", {
        status: 400,
      });
    }

    // Fall through to routes
    return null as unknown as globalThis.Response;
  },
  routes: {
    // Health check endpoint
    "/health": () => {
      const info = sessionManager.getInfo();
      return new globalThis.Response(
        JSON.stringify({
          status: "ok",
          clients: clients.size,
          runtime: {
            connected: info.isRuntimeConnected,
          },
          workspace: sessionManager.getCurrentWorkspace(),
          session: info.sessionId
            ? {
                id: info.sessionId,
                active: info.isActive,
                running: info.isProcessRunning,
              }
            : null,
          extensions: extensions.getHealth(),
          sourceRoutes: extensions.getSourceRoutes(),
          client: getClientHealth(),
        }),
        { headers: { "Content-Type": "application/json" } },
      );
    },

    // Client error beacon — receives crash reports from the web UI
    "/api/client-error": async (req: globalThis.Request) => {
      if (req.method !== "POST") {
        return new globalThis.Response("Method not allowed", { status: 405 });
      }
      try {
        const body = await req.json();
        addClientError(body);
        return new globalThis.Response(JSON.stringify({ ok: true }), {
          headers: { "Content-Type": "application/json" },
        });
      } catch {
        return new globalThis.Response(JSON.stringify({ ok: false, error: "Invalid JSON" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
      }
    },

    // Client health heartbeat — confirms the web UI is rendering successfully
    "/api/client-health": async (req: globalThis.Request) => {
      if (req.method !== "POST") {
        return new globalThis.Response("Method not allowed", { status: 405 });
      }
      try {
        const body = (await req.json()) as {
          rendered?: boolean;
          bunHmrError?: string | null;
        };
        lastClientRendered = body.rendered ?? true;

        // If the DOM health check found a bun-hmr error overlay, treat it as a client error
        if (body.bunHmrError) {
          addClientError({
            type: "runtime",
            message: body.bunHmrError,
            url: req.headers.get("referer") || "",
            timestamp: new Date().toISOString(),
            userAgent: req.headers.get("user-agent") || "",
          });
        } else if (body.rendered) {
          // Client is rendering successfully — clear any stale errors immediately
          clientErrors.length = 0;
        }
      } catch {
        lastClientRendered = true;
      }
      lastClientHeartbeat = Date.now();
      return new globalThis.Response(JSON.stringify({ ok: true }), {
        headers: { "Content-Type": "application/json" },
      });
    },

    // SPA fallback — serves the web UI for all other paths
    "/*": index,
  },
  websocket: {
    open(ws) {
      clients.set(ws, ws.data);
      log.info(`Client connected: ${ws.data.id} (${clients.size} total)`);

      // Send the server-authoritative connectionId to the client
      ws.send(
        JSON.stringify({
          type: "event",
          event: "gateway.welcome",
          payload: { connectionId: ws.data.id },
        }),
      );
    },
    message(ws, message) {
      handleMessage(ws, message.toString());
    },
    close(ws) {
      clients.delete(ws);

      // Clean up voice stream origins for this connection
      for (const [streamId, connId] of voiceStreamOrigins) {
        if (connId === ws.data.id) voiceStreamOrigins.delete(streamId);
      }

      log.info(`Client disconnected: ${ws.data.id} (${clients.size} total)`);
    },
  },
  development: {
    hmr: true,
    console: true,
  },
});

log.info(`
╔═══════════════════════════════════════════════════════════╗
║                                                           ║
║   💙 Claudia running on http://localhost:${PORT}           ║
║                                                           ║
║   Web UI:    http://localhost:${PORT}                      ║
║   WebSocket: ws://localhost:${PORT}/ws                     ║
║   Health:    http://localhost:${PORT}/health               ║
║                                                           ║
║   Model:    ${config.session.model.padEnd(42)}║
║   Thinking: ${String(config.session.thinking).padEnd(42)}║
║                                                           ║
╚═══════════════════════════════════════════════════════════╝
`);

// Graceful shutdown — handle all termination signals
async function shutdown(signal: string) {
  log.info(`${signal} received, shutting down...`);
  try {
    server.stop();
    await extensions.killRemoteHosts();
    await sessionManager.close();
    closeDb();
  } catch (e) {
    log.error("Error during shutdown", { error: String(e) });
  }
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGHUP", () => shutdown("SIGHUP"));

// Last-resort synchronous cleanup: force-kill extension hosts on process exit
// This catches cases where async shutdown didn't complete (e.g. bun --watch)
process.on("exit", () => {
  extensions.forceKillRemoteHosts();
});

// HMR cleanup — dispose managers when module reloads during development
if (import.meta.hot) {
  import.meta.hot.dispose(async () => {
    log.info("HMR: Disposing managers...");
    server.stop();
    await extensions.killRemoteHosts();
    await sessionManager.close();
    closeDb();
  });
}

export { server, broadcastEvent, extensions, sessionManager };
