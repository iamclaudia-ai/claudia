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
  Ping,
  GatewayEvent,
} from "@claudia/shared";
import { loadConfig, createLogger } from "@claudia/shared";
export type { GatewayEvent };
import { existsSync } from "node:fs";
import { join } from "node:path";
import { ExtensionManager } from "./extensions";
import { getDb, closeDb } from "./db/index";
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
  lastPong: number; // Date.now() — initialized on connect, updated on pong
}

// Client connections
const clients = new Map<ServerWebSocket<ClientState>, ClientState>();

// Maps streamId → connectionId for connection-scoped voice routing.
// When a client sends a prompt with speakResponse=true, we record which
// connection originated the voice stream so audio events route only to it.
const voiceStreamOrigins = new Map<string, string>();

// Exclusive subscriptions: pattern → WebSocket. Last subscriber wins.
// Used by dominatrix Chrome extensions so only the focused profile handles commands.
const exclusiveSubscribers = new Map<string, ServerWebSocket<ClientState>>();

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

// Initialize database (runs migrations)
getDb();

// Wire up extension event emitting to broadcast
extensions.setEmitCallback(async (type, payload, source) => {
  const payloadObj =
    payload && typeof payload === "object" ? (payload as Record<string, unknown>) : null;

  // Track voice stream origins for connection-scoped routing
  if (type === "voice.stream_start" && payloadObj?.streamId) {
    const payloadConnectionId =
      typeof payloadObj.connectionId === "string" ? payloadObj.connectionId : null;
    const connectionId = payloadConnectionId;
    if (connectionId) {
      voiceStreamOrigins.set(payloadObj.streamId as string, connectionId);
    } else {
      log.warn("voice.stream_start without routable connection", {
        streamId: payloadObj.streamId,
      });
    }
  }

  // gateway:caller routing — send only to originating connection
  if (source === "gateway:caller" && payloadObj?.connectionId) {
    const targetConnectionId = payloadObj.connectionId as string;
    for (const [ws, state] of clients) {
      if (state.id === targetConnectionId) {
        const event: Event = { type: "event", event: type, payload };
        ws.send(JSON.stringify(event));
        break;
      }
    }
    // Forward to extension handlers (but not WS clients — already handled above)
    extensions.broadcast({
      type,
      payload,
      timestamp: Date.now(),
      origin: source,
      connectionId: payloadObj.connectionId as string,
    });
    return;
  }

  broadcastEvent(type, payload, source);

  if (type === "voice.stream_end" && payloadObj?.streamId) {
    voiceStreamOrigins.delete(payloadObj.streamId as string);
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
    method: "gateway.list-methods",
    description: "List all gateway and extension methods with schemas",
    inputSchema: z.object({}),
  },
  {
    method: "gateway.list-extensions",
    description: "List loaded extensions and their methods",
    inputSchema: z.object({}),
  },
  {
    method: "gateway.subscribe",
    description: "Subscribe to events",
    inputSchema: z.object({
      events: z.array(z.string()).optional(),
      exclusive: z.boolean().optional().describe("Last subscriber wins — only one client receives"),
    }),
  },
  {
    method: "gateway.unsubscribe",
    description: "Unsubscribe from events",
    inputSchema: z.object({
      events: z.array(z.string()).optional(),
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

    if (message.type === "pong") {
      ws.data.lastPong = Date.now();
      return;
    }

    if (message.type === "req") {
      // Stamp connectionId on the envelope — flows through the entire pipeline
      message.connectionId = ws.data.id;
      handleRequest(ws, message);
    }
  } catch (error) {
    log.error("Failed to parse message", { error: String(error) });
    sendError(ws, "unknown", "Invalid message format");
  }
}

/**
 * Route requests to handlers.
 *
 * Gateway is a pure hub — only `gateway.*` methods are handled locally.
 * Everything else routes through the extension system.
 */
function handleRequest(ws: ServerWebSocket<ClientState>, req: Request): void {
  // Validate builtin methods
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

  switch (req.method) {
    case "gateway.list-methods":
      handleListMethods(ws, req);
      break;
    case "gateway.list-extensions":
      handleListExtensions(ws, req);
      break;
    case "gateway.subscribe":
      handleSubscribe(ws, req);
      break;
    case "gateway.unsubscribe":
      handleUnsubscribe(ws, req);
      break;
    default:
      // Everything else routes through extensions
      if (extensions.hasMethod(req.method)) {
        handleExtensionMethod(ws, req);
      } else {
        sendError(ws, req.id, `Unknown method: ${req.method}`);
      }
  }
}

/**
 * gateway.list-methods — list all gateway and extension methods with schemas
 */
function handleListMethods(ws: ServerWebSocket<ClientState>, req: Request): void {
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
}

/**
 * gateway.list-extensions — list loaded extensions and their methods
 */
function handleListExtensions(ws: ServerWebSocket<ClientState>, req: Request): void {
  sendResponse(ws, req.id, { extensions: extensions.getExtensionList() });
}

/**
 * Handle extension method calls — routes through the extension system
 */
async function handleExtensionMethod(
  ws: ServerWebSocket<ClientState>,
  req: Request,
): Promise<void> {
  try {
    const result = await extensions.handleMethod(
      req.method,
      (req.params as Record<string, unknown>) || {},
      req.connectionId,
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
  const exclusive = (req.params?.exclusive as boolean) || false;

  events.forEach((event) => {
    state.subscriptions.add(event);
    if (exclusive) {
      exclusiveSubscribers.set(event, ws);
    }
  });

  sendResponse(ws, req.id, { subscribed: events, exclusive });
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
function broadcastEvent(
  eventName: string,
  payload: unknown,
  _source?: string,
  connectionId?: string,
): void {
  const event: Event = { type: "event", event: eventName, payload, connectionId };
  const data = JSON.stringify(event);
  const payloadObj =
    payload && typeof payload === "object" ? (payload as Record<string, unknown>) : null;

  const streamId =
    typeof payloadObj?.streamId === "string" ? (payloadObj.streamId as string) : null;
  const payloadConnectionId =
    typeof payloadObj?.connectionId === "string" ? (payloadObj.connectionId as string) : null;
  const targetConnectionId = streamId
    ? (voiceStreamOrigins.get(streamId) ?? payloadConnectionId ?? null)
    : null;
  const isVoiceEvent = eventName.startsWith("voice.");
  const isConnectionScoped = isVoiceEvent && targetConnectionId !== null;

  // 1. Connection-scoped voice events — send to originating connection only
  if (isConnectionScoped) {
    for (const [ws, state] of clients) {
      if (state.id === targetConnectionId) {
        ws.send(data);
        break;
      }
    }
    return;
  }

  // 1b. Never fan out stream-scoped voice events when owner is unknown.
  if (isVoiceEvent && streamId) {
    log.warn("Dropping unscoped voice stream event", { eventName, streamId });
    return;
  }

  // 2. Exclusive subscriber — last subscriber wins, only they get the event
  const exclusiveWs = exclusiveSubscribers.get(eventName);
  if (exclusiveWs && clients.has(exclusiveWs)) {
    exclusiveWs.send(data);
    return;
  }

  // 3. Standard subscription matching for all clients
  for (const [ws, state] of clients) {
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
  hostname: config.gateway.host || "localhost",
  reusePort: false,
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
          lastPong: Date.now(),
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
      return new globalThis.Response(
        JSON.stringify({
          status: "ok",
          clients: clients.size,
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

      // Clean up exclusive subscriptions held by this connection
      for (const [pattern, exclusiveWs] of exclusiveSubscribers) {
        if (exclusiveWs === ws) exclusiveSubscribers.delete(pattern);
      }

      // Notify extensions that this client disconnected (connectionId on envelope)
      broadcastEvent("client.disconnected", {}, undefined, ws.data.id);
      extensions.broadcast({
        type: "client.disconnected",
        payload: {},
        timestamp: Date.now(),
        origin: "gateway",
        connectionId: ws.data.id,
      });

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

// ── Ping/Pong — Connection Liveness ─────────────────────────────────
// Every 30s, send a ping to all WS clients and prune those that haven't
// responded within 60s (missed 2 consecutive pings).

const PING_INTERVAL_MS = 30_000;
const PONG_STALE_MS = 60_000;

function pruneClient(ws: ServerWebSocket<ClientState>): void {
  const state = clients.get(ws);
  if (!state) return;

  log.info(`Pruning stale client: ${state.id}`);

  clients.delete(ws);

  // Clean up voice stream origins
  for (const [streamId, connId] of voiceStreamOrigins) {
    if (connId === state.id) voiceStreamOrigins.delete(streamId);
  }

  // Clean up exclusive subscriptions
  for (const [pattern, exclusiveWs] of exclusiveSubscribers) {
    if (exclusiveWs === ws) exclusiveSubscribers.delete(pattern);
  }

  // Notify extensions
  broadcastEvent("client.disconnected", {}, undefined, state.id);
  extensions.broadcast({
    type: "client.disconnected",
    payload: {},
    timestamp: Date.now(),
    origin: "gateway",
    connectionId: state.id,
  });

  try {
    ws.close();
  } catch {
    // Already closed
  }
}

const pingInterval = setInterval(() => {
  const now = Date.now();

  for (const [ws, state] of clients) {
    // Prune clients that haven't responded to pings
    if (now - state.lastPong > PONG_STALE_MS) {
      pruneClient(ws);
      continue;
    }

    // Send ping
    const ping: Ping = { type: "ping", id: crypto.randomUUID(), timestamp: now };
    try {
      ws.send(JSON.stringify(ping));
    } catch {
      // Send failed — prune immediately
      pruneClient(ws);
    }
  }
}, PING_INTERVAL_MS);

// Graceful shutdown — handle all termination signals
async function shutdown(signal: string) {
  log.info(`${signal} received, shutting down...`);
  try {
    clearInterval(pingInterval);
    server.stop();
    await extensions.killRemoteHosts();
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
    clearInterval(pingInterval);
    server.stop();
    await extensions.killRemoteHosts();
    closeDb();
  });
}

export { server, broadcastEvent, extensions };
