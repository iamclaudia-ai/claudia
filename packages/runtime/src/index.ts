/**
 * Claudia Session Runtime
 *
 * Persistent service that manages Claude Code CLI sessions.
 * Runs on port 30087, communicates via WebSocket using the same
 * req/res/event protocol as the gateway.
 *
 * The runtime owns:
 * - WebSocket bridge per session (CLI connects via --sdk-url)
 * - Claude CLI process per session (Bun.spawn with stdin pipe)
 * - SSE event capture and forwarding
 * - Session lifecycle (create, resume, prompt, interrupt, close)
 *
 * The gateway connects here and relays to clients/extensions.
 * Since this service rarely changes, it rarely restarts —
 * keeping Claude sessions alive across gateway restarts.
 */

import type { ServerWebSocket } from "bun";
import type { Request, Response, Event, Message, ThinkingEffort } from "@claudia/shared";
import { loadConfig } from "@claudia/shared";
import { RuntimeSessionManager } from "./manager";
import { RuntimeSession } from "./session";
import { ThinkingProxy } from "./thinking-proxy";

// ── Configuration ────────────────────────────────────────────

const config = loadConfig();
const PORT = config.runtime?.port || 30087;
const PROXY_PORT = 30088;

// Set runtime port on session class so --sdk-url points here
RuntimeSession.runtimePort = PORT;

// ── Thinking Proxy ──────────────────────────────────────────

const sessionConfig = config.session || {};
const thinkingEnabled = sessionConfig.thinking !== false;

let thinkingProxy: ThinkingProxy | null = null;

if (thinkingEnabled) {
  thinkingProxy = new ThinkingProxy({
    effort: sessionConfig.effort || "medium",
  });
  await thinkingProxy.start(PROXY_PORT);

  // Set the proxy URL on session class so CLI processes use it
  RuntimeSession.proxyBaseUrl = thinkingProxy.baseUrl;

  // Note: thinking events come through --sdk-url stream_events naturally
  // now that the proxy injects thinking config. No need to emit from proxy.
}

// ── State ────────────────────────────────────────────────────

/** Socket types: gateway clients or CLI connections */
type SocketData =
  | { kind: "gateway"; id: string; connectedAt: Date; subscriptions: Set<string> }
  | { kind: "cli"; sessionId: string };

const clients = new Map<ServerWebSocket<SocketData>, SocketData>();
const manager = new RuntimeSessionManager();
manager.setConfig(config);

// Forward all session events to subscribed WS clients
// Events arrive with session-scoped names: session.{sessionId}.{eventType}
manager.on("session.event", ({ eventName, ...payload }) => {
  broadcastEvent(eventName, payload);
});

// ── Message Handling ─────────────────────────────────────────

function handleMessage(ws: ServerWebSocket<SocketData>, data: string): void {
  try {
    const message: Message = JSON.parse(data);
    if (message.type === "req") {
      handleRequest(ws, message);
    }
  } catch (error) {
    console.error("[Runtime] Failed to parse message:", error);
    sendError(ws, "unknown", "Invalid message format");
  }
}

async function handleRequest(ws: ServerWebSocket<SocketData>, req: Request): Promise<void> {
  const [namespace, action] = req.method.split(".");

  switch (namespace) {
    case "session":
      await handleSessionMethod(ws, req, action);
      break;
    case "subscribe":
      handleSubscribe(ws, req);
      break;
    case "unsubscribe":
      handleUnsubscribe(ws, req);
      break;
    default:
      sendError(ws, req.id, `Unknown method: ${req.method}`);
  }
}

// ── Session Methods ──────────────────────────────────────────

async function handleSessionMethod(
  ws: ServerWebSocket<SocketData>,
  req: Request,
  action: string,
): Promise<void> {
  try {
    switch (action) {
      case "create": {
        const cwd = req.params?.cwd as string;
        if (!cwd) {
          sendError(ws, req.id, "Missing cwd parameter");
          return;
        }
        const result = await manager.create({
          cwd,
          model: req.params?.model as string | undefined,
          systemPrompt: req.params?.systemPrompt as string | undefined,
          thinking: req.params?.thinking as boolean | undefined,
          effort: req.params?.effort as ThinkingEffort | undefined,
        });
        sendResponse(ws, req.id, result);
        break;
      }

      case "resume": {
        const sessionId = req.params?.sessionId as string;
        const cwd = req.params?.cwd as string;
        if (!sessionId || !cwd) {
          sendError(ws, req.id, "Missing sessionId or cwd parameter");
          return;
        }
        const result = await manager.resume({
          sessionId,
          cwd,
          model: req.params?.model as string | undefined,
          thinking: req.params?.thinking as boolean | undefined,
          effort: req.params?.effort as ThinkingEffort | undefined,
        });
        sendResponse(ws, req.id, result);
        break;
      }

      case "prompt": {
        const sessionId = req.params?.sessionId as string;
        const content = req.params?.content;
        const cwd = req.params?.cwd as string | undefined;
        if (!sessionId || !content) {
          sendError(ws, req.id, "Missing sessionId or content parameter");
          return;
        }
        await manager.prompt(sessionId, content as string | unknown[], cwd);
        sendResponse(ws, req.id, { status: "ok", sessionId });
        break;
      }

      case "interrupt": {
        const sessionId = req.params?.sessionId as string;
        if (!sessionId) {
          sendError(ws, req.id, "Missing sessionId parameter");
          return;
        }
        const interrupted = manager.interrupt(sessionId);
        sendResponse(ws, req.id, { status: interrupted ? "interrupted" : "not_found" });
        break;
      }

      case "close": {
        const sessionId = req.params?.sessionId as string;
        if (!sessionId) {
          sendError(ws, req.id, "Missing sessionId parameter");
          return;
        }
        await manager.close(sessionId);
        sendResponse(ws, req.id, { status: "closed" });
        break;
      }

      case "list": {
        const sessions = manager.list();
        sendResponse(ws, req.id, { sessions });
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

// ── Subscriptions ────────────────────────────────────────────

function handleSubscribe(ws: ServerWebSocket<SocketData>, req: Request): void {
  const state = clients.get(ws);
  if (!state || state.kind !== "gateway") return;
  const events = (req.params?.events as string[]) || [];
  events.forEach((event) => state.subscriptions.add(event));
  sendResponse(ws, req.id, { subscribed: events });
}

function handleUnsubscribe(ws: ServerWebSocket<SocketData>, req: Request): void {
  const state = clients.get(ws);
  if (!state || state.kind !== "gateway") return;
  const events = (req.params?.events as string[]) || [];
  events.forEach((event) => state.subscriptions.delete(event));
  sendResponse(ws, req.id, { unsubscribed: events });
}

// ── Protocol Helpers ─────────────────────────────────────────

function sendResponse(ws: ServerWebSocket<SocketData>, id: string, payload: unknown): void {
  const response: Response = { type: "res", id, ok: true, payload };
  ws.send(JSON.stringify(response));
}

function sendError(ws: ServerWebSocket<SocketData>, id: string, error: string): void {
  const response: Response = { type: "res", id, ok: false, error };
  ws.send(JSON.stringify(response));
}

function broadcastEvent(eventName: string, payload: unknown): void {
  const event: Event = { type: "event", event: eventName, payload };
  const data = JSON.stringify(event);

  for (const [ws, state] of clients) {
    if (state.kind !== "gateway") continue;

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

// ── Server ───────────────────────────────────────────────────

const server = Bun.serve<SocketData>({
  port: PORT,
  async fetch(req, server) {
    const url = new URL(req.url);

    // Gateway WebSocket — the control plane connection
    if (url.pathname === "/ws") {
      const upgraded = server.upgrade(req, {
        data: {
          kind: "gateway" as const,
          id: crypto.randomUUID(),
          connectedAt: new Date(),
          subscriptions: new Set<string>(),
        },
      });
      if (upgraded) return undefined;
      return new globalThis.Response("WebSocket upgrade failed", { status: 400 });
    }

    // CLI WebSocket — Claude Code CLI connects here via --sdk-url
    const cliMatch = url.pathname.match(/^\/ws\/cli\/([a-f0-9-]+)$/);
    if (cliMatch) {
      const sessionId = cliMatch[1];
      const upgraded = server.upgrade(req, {
        data: {
          kind: "cli" as const,
          sessionId,
        },
      });
      if (upgraded) return undefined;
      return new globalThis.Response("WebSocket upgrade failed", { status: 400 });
    }

    // Health check
    if (url.pathname === "/health") {
      return new globalThis.Response(
        JSON.stringify({
          status: "ok",
          clients: clients.size,
          sessions: manager.list(),
        }),
        { headers: { "Content-Type": "application/json" } },
      );
    }

    return new globalThis.Response("Not found", { status: 404 });
  },
  websocket: {
    open(ws) {
      const data = ws.data;

      if (data.kind === "gateway") {
        clients.set(ws, data);
        console.log(`[Runtime] Gateway connected: ${data.id.slice(0, 8)} (${clients.size} total)`);
      } else if (data.kind === "cli") {
        // Route CLI connection to the appropriate session's bridge
        manager.handleCliConnection(data.sessionId, ws);
        console.log(`[Runtime] CLI connected for session: ${data.sessionId.slice(0, 8)}`);
      }
    },
    message(ws, message) {
      const data = ws.data;

      if (data.kind === "gateway") {
        handleMessage(ws, message.toString());
      } else if (data.kind === "cli") {
        // Route CLI messages to the appropriate session's bridge
        manager.handleCliMessage(data.sessionId, message);
      }
    },
    close(ws) {
      const data = ws.data;

      if (data.kind === "gateway") {
        clients.delete(ws);
        console.log(`[Runtime] Gateway disconnected: ${data.id.slice(0, 8)} (${clients.size} total)`);
      } else if (data.kind === "cli") {
        manager.handleCliClose(data.sessionId);
        console.log(`[Runtime] CLI disconnected for session: ${data.sessionId.slice(0, 8)}`);
      }
    },
  },
});

console.log(`
╔═══════════════════════════════════════════════════════════╗
║                                                           ║
║   ⚡ Claudia Runtime on http://localhost:${PORT}           ║
║                                                           ║
║   Gateway WS: ws://localhost:${PORT}/ws                    ║
║   CLI WS:     ws://localhost:${PORT}/ws/cli/:sessionId     ║
║   Health:     http://localhost:${PORT}/health               ║
${thinkingProxy ? `║   Thinking:  http://localhost:${thinkingProxy.port} (${sessionConfig.effort || "medium"})      ║` : `║   Thinking:  disabled                                     ║`}
║                                                           ║
╚═══════════════════════════════════════════════════════════╝
`);

// Graceful shutdown
process.on("SIGINT", async () => {
  console.log("\n[Runtime] Shutting down...");
  await manager.closeAll();
  thinkingProxy?.stop();
  server.stop();
  process.exit(0);
});

export { server, manager };
