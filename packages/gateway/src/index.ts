/**
 * Claudia Gateway
 *
 * The heart of Claudia - manages Claude Code sessions, routes messages
 * between clients and extensions, broadcasts events.
 */

import type { Server, ServerWebSocket } from 'bun';
import type { Request, Response, Event, Message } from '@claudia/shared';

const PORT = process.env.CLAUDIA_PORT ? parseInt(process.env.CLAUDIA_PORT) : 3033;

interface ClientState {
  id: string;
  connectedAt: Date;
  subscriptions: Set<string>;
}

// Client connections
const clients = new Map<ServerWebSocket<ClientState>, ClientState>();

// Generate unique IDs
const generateId = () => crypto.randomUUID();

/**
 * Handle incoming WebSocket messages
 */
function handleMessage(ws: ServerWebSocket<ClientState>, data: string): void {
  try {
    const message: Message = JSON.parse(data);

    if (message.type === 'req') {
      handleRequest(ws, message);
    }
  } catch (error) {
    console.error('Failed to parse message:', error);
    sendError(ws, 'unknown', 'Invalid message format');
  }
}

/**
 * Route requests to handlers
 */
function handleRequest(ws: ServerWebSocket<ClientState>, req: Request): void {
  const [namespace, action] = req.method.split('.');

  switch (namespace) {
    case 'session':
      handleSessionMethod(ws, req, action);
      break;
    case 'subscribe':
      handleSubscribe(ws, req);
      break;
    case 'unsubscribe':
      handleUnsubscribe(ws, req);
      break;
    default:
      // Check if it's an extension method
      // TODO: Route to extension handlers
      sendError(ws, req.id, `Unknown method: ${req.method}`);
  }
}

/**
 * Handle session methods
 */
function handleSessionMethod(ws: ServerWebSocket<ClientState>, req: Request, action: string): void {
  switch (action) {
    case 'create':
      // TODO: Create new Claude session
      sendResponse(ws, req.id, { sessionId: generateId() });
      break;
    case 'prompt':
      // TODO: Send prompt to session
      sendResponse(ws, req.id, { status: 'ok' });
      break;
    case 'interrupt':
      // TODO: Interrupt current session
      sendResponse(ws, req.id, { status: 'ok' });
      break;
    case 'close':
      // TODO: Close session
      sendResponse(ws, req.id, { status: 'ok' });
      break;
    case 'list':
      // TODO: List active sessions
      sendResponse(ws, req.id, { sessions: [] });
      break;
    default:
      sendError(ws, req.id, `Unknown session action: ${action}`);
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
  const response: Response = { type: 'res', id, ok: true, payload };
  ws.send(JSON.stringify(response));
}

/**
 * Send an error response to a client
 */
function sendError(ws: ServerWebSocket<ClientState>, id: string, error: string): void {
  const response: Response = { type: 'res', id, ok: false, error };
  ws.send(JSON.stringify(response));
}

/**
 * Broadcast an event to subscribed clients
 */
function broadcastEvent(eventName: string, payload: unknown): void {
  const event: Event = { type: 'event', event: eventName, payload };
  const data = JSON.stringify(event);

  for (const [ws, state] of clients) {
    // Check if client is subscribed to this event
    const isSubscribed = Array.from(state.subscriptions).some((pattern) => {
      if (pattern === '*') return true;
      if (pattern === eventName) return true;
      if (pattern.endsWith('.*')) {
        const prefix = pattern.slice(0, -2);
        return eventName.startsWith(prefix + '.');
      }
      return false;
    });

    if (isSubscribed) {
      ws.send(data);
    }
  }
}

// Start the server
const server = Bun.serve<ClientState>({
  port: PORT,
  fetch(req, server) {
    const url = new URL(req.url);

    // Health check endpoint
    if (url.pathname === '/health') {
      return new globalThis.Response(JSON.stringify({ status: 'ok', clients: clients.size }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // WebSocket upgrade
    if (url.pathname === '/ws' || url.pathname === '/') {
      const upgraded = server.upgrade(req, {
        data: {
          id: generateId(),
          connectedAt: new Date(),
          subscriptions: new Set<string>(),
        },
      });

      if (upgraded) return undefined;
      return new globalThis.Response('WebSocket upgrade failed', { status: 400 });
    }

    return new globalThis.Response('Not found', { status: 404 });
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
});

console.log(`
╔═══════════════════════════════════════════════════════════╗
║                                                           ║
║   💙 Claudia Gateway running on port ${PORT}               ║
║                                                           ║
║   WebSocket: ws://localhost:${PORT}/ws                     ║
║   Health:    http://localhost:${PORT}/health               ║
║                                                           ║
╚═══════════════════════════════════════════════════════════╝
`);

export { server, broadcastEvent };
