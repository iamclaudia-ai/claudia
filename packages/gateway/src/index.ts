/**
 * Claudia Gateway
 *
 * The heart of Claudia - manages Claude Code sessions, routes messages
 * between clients and extensions, broadcasts events.
 */

import type { ServerWebSocket } from 'bun';
import type { Request, Response, Event, Message, GatewayEvent } from '@claudia/shared';
export type { GatewayEvent };
import { ClaudiaSession, createSession, resumeSession } from '@claudia/sdk';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ExtensionManager } from './extensions';

const PORT = process.env.CLAUDIA_PORT ? parseInt(process.env.CLAUDIA_PORT) : 3033;
const DATA_DIR = process.env.CLAUDIA_DATA_DIR || join(import.meta.dir, '../../../.claudia');
const SESSION_FILE = join(DATA_DIR, '.session-id');

// Ensure data directory exists
if (!existsSync(DATA_DIR)) {
  await Bun.write(join(DATA_DIR, '.gitkeep'), '');
}

interface ClientState {
  id: string;
  connectedAt: Date;
  subscriptions: Set<string>;
}

// Client connections
const clients = new Map<ServerWebSocket<ClientState>, ClientState>();

// The main session (singleton for now - KISS!)
let session: ClaudiaSession | null = null;

// Track per-request state
let currentRequestWantsVoice = false;
let currentRequestSource: string | null = null;

// Session config (can be set before first prompt)
let pendingSessionConfig: { thinking?: boolean; thinkingBudget?: number } = {};

// Extension manager
const extensions = new ExtensionManager();

// Wire up extension event emitting to broadcast
extensions.setEmitCallback((type, payload, source) => {
  broadcastEvent(type, payload, source);
});

// Generate unique IDs
const generateId = () => crypto.randomUUID();

/**
 * Get or create the session ID from file
 */
function getSessionId(): string | null {
  if (existsSync(SESSION_FILE)) {
    return readFileSync(SESSION_FILE, 'utf-8').trim();
  }
  return null;
}

/**
 * Save session ID to file
 */
function saveSessionId(sessionId: string): void {
  writeFileSync(SESSION_FILE, sessionId);
}

/**
 * Initialize or resume the main session
 */
async function initSession(): Promise<ClaudiaSession> {
  if (session?.isActive) {
    return session;
  }

  const existingId = getSessionId();

  if (existingId) {
    console.log(`Resuming session: ${existingId}`);
    session = await resumeSession(existingId);
  } else {
    // Use pending config if set, otherwise fall back to env vars
    const thinking = pendingSessionConfig.thinking ?? (process.env.CLAUDIA_THINKING === 'true');
    const thinkingBudget = pendingSessionConfig.thinkingBudget ??
      (process.env.CLAUDIA_THINKING_BUDGET ? parseInt(process.env.CLAUDIA_THINKING_BUDGET) : undefined);

    console.log(`Creating new session (thinking: ${thinking})...`);
    session = await createSession({
      systemPrompt: process.env.CLAUDIA_SYSTEM_PROMPT,
      thinking,
      thinkingBudget,
    });
    saveSessionId(session.id);
    console.log(`Created session: ${session.id}`);

    // Clear pending config
    pendingSessionConfig = {};
  }

  // Wire up SSE event forwarding
  session.on('sse', (event) => {
    // Map SSE events to our event format
    const eventName = `session.${event.type}`;
    const payload = {
      sessionId: session!.id,
      source: currentRequestSource,
      ...event,
    };

    // Broadcast to WebSocket clients
    broadcastEvent(eventName, payload, 'session');

    // Build gateway event for extensions
    const gatewayEvent: GatewayEvent = {
      type: eventName,
      payload: { ...payload, speakResponse: currentRequestWantsVoice },
      timestamp: Date.now(),
      origin: 'session',
      source: currentRequestSource || undefined,
      sessionId: session!.id,
    };

    // Broadcast to extensions (for voice, etc.)
    extensions.broadcast(gatewayEvent);

    // On message complete, also route to source if applicable
    if (event.type === 'message_stop' && currentRequestSource) {
      extensions.routeToSource(currentRequestSource, gatewayEvent);
    }
  });

  session.on('process_started', () => {
    broadcastEvent('session.process_started', { sessionId: session!.id }, 'session');
  });

  session.on('process_ended', () => {
    broadcastEvent('session.process_ended', { sessionId: session!.id }, 'session');
  });

  return session;
}

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
      // Check if an extension handles this method
      if (extensions.hasMethod(req.method)) {
        handleExtensionMethod(ws, req);
      } else {
        sendError(ws, req.id, `Unknown method: ${req.method}`);
      }
  }
}

/**
 * Handle session methods
 */
async function handleSessionMethod(
  ws: ServerWebSocket<ClientState>,
  req: Request,
  action: string
): Promise<void> {
  try {
    switch (action) {
      case 'info': {
        const s = session;
        sendResponse(ws, req.id, {
          sessionId: s?.id || null,
          isActive: s?.isActive || false,
          isProcessRunning: s?.isProcessRunning || false,
          pendingConfig: !session ? pendingSessionConfig : undefined,
        });
        break;
      }

      case 'config': {
        // Set session config before first prompt
        // This only affects NEW sessions - ignored if session already exists
        if (!session) {
          if (req.params?.thinking !== undefined) {
            pendingSessionConfig.thinking = req.params.thinking as boolean;
          }
          if (req.params?.thinkingBudget !== undefined) {
            pendingSessionConfig.thinkingBudget = req.params.thinkingBudget as number;
          }
          sendResponse(ws, req.id, { status: 'ok', pending: pendingSessionConfig });
        } else {
          sendResponse(ws, req.id, {
            status: 'ignored',
            reason: 'Session already exists - config only applies to new sessions',
          });
        }
        break;
      }

      case 'prompt': {
        const content = req.params?.content as string;
        if (!content) {
          sendError(ws, req.id, 'Missing content parameter');
          return;
        }

        // Track request metadata for routing
        currentRequestWantsVoice = req.params?.speakResponse === true;
        currentRequestSource = (req.params?.source as string) || null;

        // If thinking is specified and no session exists yet, set pending config
        if (!session && req.params?.thinking !== undefined) {
          pendingSessionConfig.thinking = req.params.thinking as boolean;
        }

        // Ensure session is initialized
        const s = await initSession();

        // Send prompt (non-blocking - events will stream back)
        s.prompt(content);
        sendResponse(ws, req.id, { status: 'ok', sessionId: s.id, source: currentRequestSource });
        break;
      }

      case 'interrupt': {
        if (session) {
          session.interrupt();
          sendResponse(ws, req.id, { status: 'interrupted' });
        } else {
          sendError(ws, req.id, 'No active session');
        }
        break;
      }

      case 'reset': {
        // Close existing session and remove session file
        if (session) {
          await session.close();
          session = null;
        }
        if (existsSync(SESSION_FILE)) {
          await Bun.write(SESSION_FILE, ''); // Clear file
          require('node:fs').unlinkSync(SESSION_FILE);
        }
        sendResponse(ws, req.id, { status: 'reset' });
        break;
      }

      default:
        sendError(ws, req.id, `Unknown session action: ${action}`);
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    sendError(ws, req.id, errorMessage);
  }
}

/**
 * Handle extension method calls
 */
async function handleExtensionMethod(ws: ServerWebSocket<ClientState>, req: Request): Promise<void> {
  try {
    const result = await extensions.handleMethod(req.method, (req.params as Record<string, unknown>) || {});
    sendResponse(ws, req.id, result);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
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
function broadcastEvent(eventName: string, payload: unknown, source?: string): void {
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
      return new globalThis.Response(
        JSON.stringify({
          status: 'ok',
          clients: clients.size,
          session: session
            ? { id: session.id, active: session.isActive, running: session.isProcessRunning }
            : null,
          extensions: extensions.getHealth(),
          sourceRoutes: extensions.getSourceRoutes(),
        }),
        { headers: { 'Content-Type': 'application/json' } }
      );
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

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('\nShutting down...');
  if (session) {
    await session.close();
  }
  server.stop();
  process.exit(0);
});

export { server, broadcastEvent, extensions };
