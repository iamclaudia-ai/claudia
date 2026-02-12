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
  Response,
  Event,
  Message,
  GatewayEvent,
} from "@claudia/shared";
import { loadConfig } from "@claudia/shared";
export type { GatewayEvent };
import { existsSync } from "node:fs";
import { join } from "node:path";
import { ExtensionManager } from "./extensions";
import { getDb, closeDb } from "./db/index";
import { SessionManager } from "./session-manager";
import { homedir } from "node:os";

// Web UI — served as SPA fallback for all non-WS routes
import index from "./web/index.html";

// Load configuration (claudia.json or env var fallback)
const config = loadConfig();
const PORT = config.gateway.port;
const DATA_DIR = process.env.CLAUDIA_DATA_DIR || join(homedir(), ".claudia");

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
      console.log(`[Gateway] Prompt request from ${source}: ${preview}`);

      // Set request context for routing
      sessionManager.currentRequestWantsVoice = false;
      sessionManager.currentRequestSource = req.source || null;
      sessionManager.currentResponseText = "";

      // Send prompt through session manager with explicit session targeting/config.
      if (!req.sessionId || !req.model || req.thinking === undefined || !req.effort) {
        console.warn("[Gateway] Ignoring prompt_request with missing required params: sessionId/model/thinking/effort");
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
    console.error("Failed to parse message:", error);
    sendError(ws, "unknown", "Invalid message format");
  }
}

/**
 * Route requests to handlers
 */
function handleRequest(ws: ServerWebSocket<ClientState>, req: Request): void {
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
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";
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
      sendResponse(ws, req.id, { extensions: extensions.getExtensionList() });
      break;
    }
    default:
      sendError(ws, req.id, `Unknown extension action: ${action}`);
  }
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
        sessionManager.currentRequestWantsVoice =
          req.params?.speakResponse === true;
        sessionManager.currentRequestSource =
          (req.params?.source as string) || null;

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
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";
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
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";
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
function handleUnsubscribe(
  ws: ServerWebSocket<ClientState>,
  req: Request,
): void {
  const state = clients.get(ws);
  if (!state) return;

  const events = (req.params?.events as string[]) || [];
  events.forEach((event) => state.subscriptions.delete(event));

  sendResponse(ws, req.id, { unsubscribed: events });
}

/**
 * Send a response to a client
 */
function sendResponse(
  ws: ServerWebSocket<ClientState>,
  id: string,
  payload: unknown,
): void {
  const response: Response = { type: "res", id, ok: true, payload };
  ws.send(JSON.stringify(response));
}

/**
 * Send an error response to a client
 */
function sendError(
  ws: ServerWebSocket<ClientState>,
  id: string,
  error: string,
): void {
  const response: Response = { type: "res", id, ok: false, error };
  ws.send(JSON.stringify(response));
}

/**
 * Broadcast an event to subscribed clients
 */
function broadcastEvent(
  eventName: string,
  payload: unknown,
  source?: string,
): void {
  const event: Event = { type: "event", event: eventName, payload };
  const data = JSON.stringify(event);
  const payloadObj =
    payload && typeof payload === "object"
      ? (payload as Record<string, unknown>)
      : null;
  const payloadSessionId =
    typeof payloadObj?.sessionId === "string"
      ? (payloadObj.sessionId as string)
      : null;
  const isScopedVoiceEvent =
    eventName.startsWith("voice.") && payloadSessionId !== null;
  const requiredStreamPattern = payloadSessionId
    ? `stream.${payloadSessionId}.*`
    : null;

  for (const [ws, state] of clients) {
    // Route session-scoped voice streams only to clients subscribed to that session stream.
    if (isScopedVoiceEvent) {
      const hasGlobal = state.subscriptions.has("*");
      const hasSessionStream =
        requiredStreamPattern !== null &&
        state.subscriptions.has(requiredStreamPattern);
      if (!hasGlobal && !hasSessionStream) {
        continue;
      }
    }

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
  async fetch(req, server) {
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

      if (upgraded) return undefined;
      return new globalThis.Response("WebSocket upgrade failed", {
        status: 400,
      });
    }

    // Fall through to routes
    return null;
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
        }),
        { headers: { "Content-Type": "application/json" } },
      );
    },
    // SPA fallback — serves the web UI for all other paths
    "/*": index,
  },
  websocket: {
    open(ws) {
      clients.set(ws, ws.data);
      console.log(`Client connected: ${ws.data.id} (${clients.size} total)`);
    },
    message(ws, message) {
      handleMessage(ws, message.toString());
    },
    close(ws) {
      clients.delete(ws);
      console.log(`Client disconnected: ${ws.data.id} (${clients.size} total)`);
    },
  },
  development: {
    hmr: true,
    console: true,
  },
});

console.log(`
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
  console.log(`\n[Gateway] ${signal} received, shutting down...`);
  try {
    server.stop();
    await sessionManager.close();
    closeDb();
  } catch (e) {
    console.error("[Gateway] Error during shutdown:", e);
  }
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGHUP", () => shutdown("SIGHUP"));

// HMR cleanup — dispose managers when module reloads during development
if (import.meta.hot) {
  import.meta.hot.dispose(async () => {
    console.log("[HMR] Disposing managers...");
    server.stop();
    await sessionManager.close();
    closeDb();
  });
}

export { server, broadcastEvent, extensions, sessionManager };
