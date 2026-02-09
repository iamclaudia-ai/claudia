# Claudia Gateway Architecture

## Single Server Design

The gateway runs as a single Bun.serve instance on port 30086, handling HTTP, WebSocket, and static file serving:

```
┌──────────────────────────────────────────────────────────────┐
│                    Bun.serve (port 30086)                      │
│                                                                │
│  fetch(req):                                                   │
│    /ws  → WebSocket upgrade → handleMessage()                  │
│    *    → fall through to routes                               │
│                                                                │
│  routes:                                                       │
│    /health → JSON status (sessions, extensions, clients)       │
│    /*      → index.html (SPA shell, Tailwind + Bun bundling)  │
│                                                                │
│  websocket:                                                    │
│    open    → register client, assign ID                        │
│    message → parse JSON → route to handler                     │
│    close   → cleanup client                                    │
│                                                                │
│  development:                                                  │
│    hmr: true (hot module reload + dispose hooks)               │
└──────────────────────────────────────────────────────────────┘
```

The SPA (`clients/web/index.html`) is imported directly by the gateway via Bun's HTML import. Bun handles bundling, CSS (Tailwind via `bun-plugin-tailwind`), and asset serving automatically.

## WebSocket Protocol

All client communication uses a single protocol over WebSocket:

```
Client ──req──► Gateway ──res──► Client     (request/response)
                Gateway ──event─► Client     (push events)
```

### Message Types

```typescript
// Request: client → gateway
{ type: "req", id: string, method: string, params?: Record<string, unknown> }

// Response: gateway → client
{ type: "res", id: string, ok: boolean, payload?: unknown, error?: string }

// Event: gateway → client (streaming, notifications)
{ type: "event", event: string, payload: unknown }
```

### Method Routing

Methods are namespaced. The gateway routes by prefix:

| Prefix | Handler | Methods |
|--------|---------|---------|
| `session.*` | SessionManager | prompt, history, create, switch, list, info, interrupt, reset, get, config |
| `workspace.*` | SessionManager | list, get, getOrCreate |
| `subscribe` | Client state | Subscribe to event patterns |
| `unsubscribe` | Client state | Remove subscriptions |
| `*` | ExtensionManager | Any method registered by an extension |

### Event Subscriptions

Clients subscribe to event patterns with wildcards:

```typescript
// Subscribe to all session events
{ method: "subscribe", params: { events: ["session.*"] } }

// Subscribe to everything
{ method: "subscribe", params: { events: ["*"] } }
```

Events are broadcast only to clients whose subscriptions match.

## Session Management

### Data Model

```
Workspace (SQLite)                 Session Record (SQLite)
┌──────────────────┐              ┌──────────────────────┐
│ id: ws_...       │──has many──►│ id: ses_...          │
│ name: "claudia"  │              │ workspaceId: ws_...  │
│ cwd: "/path/to"  │              │ ccSessionId: uuid    │
│ activeSessionId  │              │ status: active/arch  │
└──────────────────┘              │ title, summary       │
                                  │ lastActivity         │
                                  └──────────────────────┘

Session History (JSONL files)
~/.claude/projects/{cwd-encoded}/{uuid}.jsonl
  → Parsed by parse-session.ts into Message[] for UI
  → Paginated: parseSessionFilePaginated(path, { limit, offset })
  → Must parse all lines (tool results backfill earlier messages)
```

### Session Lifecycle

1. **VS Code flow**: `workspace.getOrCreate(cwd)` → discovers existing sessions from JSONL files → loads active session
2. **Web flow**: Navigate to `/session/:sessionId` → `session.history` with pagination → `session.prompt` targets specific session
3. **Extension flow**: `imessage.prompt_request` → `sessionManager.prompt(content)` → response routed back to source

### History Pagination

Session history uses load-all-then-slice (required because tool results in user messages must backfill earlier assistant tool_use blocks):

```
Request:  { method: "session.history", params: { sessionId: "ses_...", limit: 50, offset: 0 } }
Response: { messages: [...50], total: 4077, hasMore: true, offset: 0, usage: {...} }

Load more: { params: { ..., limit: 50, offset: 50 } }
Response:  { messages: [...50], total: 4077, hasMore: true, offset: 50 }
```

## Extension System

### Server-Side Extensions

Extensions register methods and events, subscribe to the event bus:

```typescript
interface ClaudiaExtension {
  id: string;
  name: string;
  methods: string[];          // RPC methods this extension handles
  events: string[];           // Events this extension emits
  sourceRoutes?: string[];    // Source prefixes for response routing
  start(ctx: ExtensionContext): Promise<void>;
  stop(): Promise<void>;
  handleMethod(method: string, params: Record<string, unknown>): Promise<unknown>;
  handleSourceResponse?(source: string, event: GatewayEvent): Promise<void>;
  health(): { ok: boolean; details?: Record<string, unknown> };
}
```

**ExtensionContext** provides:
- `on(pattern, handler)` — subscribe to gateway events (wildcard support)
- `emit(type, payload)` — emit events to the bus
- `config` — extension configuration
- `log` — scoped logger

### Client-Side Extensions (Routes)

Extensions can also declare web pages:

```
extensions/<name>/src/
  index.ts       # Server: createMyExtension() → ClaudiaExtension
  routes.ts      # Client: export const myRoutes: Route[]
  pages/         # React page components
```

Routes use the `/ext/<name>` prefix convention (except chat which owns `/`).

The web shell (`clients/web/src/index.tsx`) imports routes from all extensions and feeds them to the `Router` component from `packages/ui`.

### Extension Loading

Extensions are loaded at startup via `packages/gateway/src/start.ts`:

```typescript
const EXTENSION_FACTORIES: Record<string, (config) => ClaudiaExtension> = {
  voice: (config) => createVoiceExtension(config),
  imessage: (config) => createIMessageExtension(config),
};
```

Configuration comes from `claudia.json` or environment variables.

### Source Routing

For extensions that bridge external systems (e.g., iMessage), source routing enables round-trip responses:

```
iMessage from +1234 → imessage extension → prompt_request event
  → session.prompt(content, source="imessage/chatId")
  → Claude responds → message_stop event
  → routeToSource("imessage/chatId", response)
  → imessage extension sends reply to chat
```

## Client-Side Router

Zero-dependency pushState router in `packages/ui/src/router.tsx` (~75 lines):

- `matchPath(pattern, pathname)` — regex `:param` matching
- `Router` component — iterates routes, first match wins
- `navigate(path)` — pushState + dispatch popstate
- `Link` component — respects modifier keys
- `useRouter()` hook — current pathname, params, navigate

The gateway's `"/*": index` route serves `index.html` for all paths, enabling clean URLs.

## SSE Event Flow

Claude Code CLI → SDK (HTTP proxy intercept) → Gateway → Clients + Extensions:

```
Claude Code CLI
    │ HTTP to Anthropic API (intercepted by SDK proxy)
    ▼
ClaudiaSession (SDK)
    │ EventEmitter: "sse" events
    ▼
SessionManager.wireSession()
    │ Broadcasts to:
    ├──► WebSocket clients (broadcastEvent)
    ├──► Extensions (broadcastExtension)
    └──► Source routing (routeToSource) on message_stop
```

SSE event types forwarded: `message_start`, `content_block_start`, `content_block_delta`, `content_block_stop`, `message_delta`, `message_stop`, `api_error`, `api_warning`

## File Map

```
packages/gateway/
  src/
    index.ts              # Bun.serve, WS handlers, request routing
    start.ts              # Extension loading, startup
    session-manager.ts    # Workspace/session lifecycle, history
    extensions.ts         # Extension registration, method/event dispatch
    parse-session.ts      # JSONL → Message[] with pagination
    db/
      index.ts            # SQLite connection
      schema.ts           # Table definitions
      models/
        workspace.ts      # Workspace CRUD
        session.ts        # Session CRUD
  bunfig.toml             # Tailwind plugin for SPA serving

packages/ui/
  src/
    router.tsx            # Client-side pushState router
    hooks/useGateway.ts   # WebSocket connection + state management
    components/
      ClaudiaChat.tsx     # Main chat interface
      MessageList.tsx     # Message rendering with pagination
      WorkspaceList.tsx   # Workspace browser
      SessionList.tsx     # Session browser
    contexts/
      WorkspaceContext.tsx # CWD context for path stripping

clients/web/
  index.html              # SPA shell (imported by gateway)
  src/index.tsx           # Route collector (~30 lines)

extensions/
  chat/src/               # Web chat pages
    routes.ts             # /, /workspace/:id, /session/:id
    pages/                # WorkspacesPage, WorkspacePage, SessionPage
    app.ts                # GATEWAY_URL + PlatformBridge
  voice/src/index.ts      # ElevenLabs TTS extension
  imessage/src/index.ts   # iMessage bridge extension
```
