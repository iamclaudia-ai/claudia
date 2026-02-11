# Claudia Architecture

## System Overview

Claudia is a two-tier system: a **Gateway** that serves clients and a **Runtime** that manages Claude Code CLI processes. The Gateway handles HTTP, WebSocket, and web UI on port 30086. The Runtime manages CLI sessions, WebSocket bridges, and thinking injection on port 30087.

```
┌────────────────────────────────────────────────────────────────────┐
│                     Clients                                        │
│  Web UI · VS Code · macOS Menubar · iOS · iMessage                 │
└──────────────────────────┬─────────────────────────────────────────┘
                           │ WebSocket (req/res/event protocol)
┌──────────────────────────▼─────────────────────────────────────────┐
│                    Gateway (port 30086)                             │
│                                                                    │
│  Bun.serve:                                                        │
│    /ws      → WebSocket (all client communication)                 │
│    /health  → JSON status endpoint                                 │
│    /*       → SPA (web UI + extension pages)                       │
│                                                                    │
│  ┌───────────────┐  ┌──────────────┐  ┌────────────────────────┐   │
│  │  Session       │  │  Event Bus   │  │  Extension System      │   │
│  │  Manager       │  │  (WS pub/sub)│  │  (voice, imessage...)  │   │
│  │  (SQLite)      │  │              │  │                        │   │
│  └───────────────┘  └──────────────┘  └────────────────────────┘   │
└──────────────────────────┬─────────────────────────────────────────┘
                           │ WebSocket (req/res/event protocol)
┌──────────────────────────▼─────────────────────────────────────────┐
│                    Runtime (port 30087)                             │
│                                                                    │
│  Bun.serve with dual WebSocket paths:                              │
│    /ws          → Gateway clients (control plane)                  │
│    /ws/cli/:id  → Claude CLI connections (NDJSON protocol)         │
│                                                                    │
│  ┌───────────────┐  ┌──────────────┐  ┌────────────────────────┐   │
│  │  Session       │  │  CLI Bridge  │  │  Thinking Proxy        │   │
│  │  Manager       │  │  (per sess)  │  │  (port 30088)          │   │
│  │               │  │              │  │                        │   │
│  │  create/      │  │  WS handler  │  │  Injects adaptive      │   │
│  │  resume/      │  │  msg routing │  │  thinking config into  │   │
│  │  prompt/      │  │  queue/flush │  │  API requests          │   │
│  │  interrupt    │  │  interrupt   │  │                        │   │
│  └───────────────┘  └──────────────┘  └───────────┬────────────┘   │
└───────────┬───────────────────────────────────────┼────────────────┘
            │ spawns per session                    │ HTTP proxy
            ▼                                       ▼
┌───────────────────────┐              ┌────────────────────────┐
│   Claude Code CLI     │──────────────│    Anthropic API       │
│                       │  API calls   │                        │
│  --sdk-url → WS back  │  via proxy   │  Returns thinking      │
│    to Runtime :30087   │  :30088      │  blocks when config    │
│                       │              │  is injected           │
│  Flags:               │              └────────────────────────┘
│  --include-partial-   │
│    messages            │
│  --permission-mode    │
│    bypassPermissions  │
│  --output-format      │
│    stream-json        │
│  --input-format       │
│    stream-json        │
│                       │
│  Env:                 │
│  ANTHROPIC_BASE_URL=  │
│    http://localhost:   │
│    30088              │
└───────────────────────┘
```

### Why Two Tiers?

The Runtime rarely changes and rarely restarts — keeping Claude CLI sessions alive across Gateway restarts. During development, the Gateway restarts often (HMR, code changes), but the Runtime holds steady so active conversations aren't interrupted.

## Gateway (port 30086)

### Single Server Design

The gateway runs as a single Bun.serve instance handling HTTP, WebSocket, and static file serving:

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

### WebSocket Protocol

All client communication uses a single protocol over WebSocket:

```
Client ──req──► Gateway ──res──► Client     (request/response)
                Gateway ──event─► Client     (push events)
```

#### Message Types

```typescript
// Request: client → gateway
{ type: "req", id: string, method: string, params?: Record<string, unknown> }

// Response: gateway → client
{ type: "res", id: string, ok: boolean, payload?: unknown, error?: string }

// Event: gateway → client (streaming, notifications)
{ type: "event", event: string, payload: unknown }
```

#### Method Routing

Methods are namespaced. The gateway routes by prefix:

| Prefix | Handler | Methods |
|--------|---------|---------|
| `session.*` | SessionManager | prompt, history, create, switch, list, info, interrupt, reset, get, config |
| `workspace.*` | SessionManager | list, get, getOrCreate |
| `subscribe` | Client state | Subscribe to event patterns |
| `unsubscribe` | Client state | Remove subscriptions |
| `*` | ExtensionManager | Any method registered by an extension |

#### Event Subscriptions

Clients subscribe to event patterns with wildcards:

```typescript
// Subscribe to all session events
{ method: "subscribe", params: { events: ["session.*"] } }

// Subscribe to everything
{ method: "subscribe", params: { events: ["*"] } }
```

Events are broadcast only to clients whose subscriptions match.

## Runtime (port 30087)

The Runtime is a persistent Bun.serve instance managing Claude Code CLI processes. It accepts two types of WebSocket connections:

- **Gateway connections** (`/ws`) — Control plane using the same req/res/event protocol
- **CLI connections** (`/ws/cli/:sessionId`) — Data plane using Claude Code's NDJSON protocol

### CLI Bridge (--sdk-url)

Each session gets a `CliBridge` instance that handles the WebSocket connection from a Claude Code CLI process spawned with `--sdk-url ws://localhost:30087/ws/cli/:sessionId`.

The CLI connects TO us (we are the server). This gives us native access to all events without intercepting HTTP traffic.

#### NDJSON Message Protocol

Messages from the CLI are newline-delimited JSON:

| CLI Message Type | Action | Description |
|-----------------|--------|-------------|
| `stream_event` | Unwrap inner `event`, emit as SSE | Real-time streaming deltas (text, thinking, tool use) |
| `assistant` | Log only | Complete assistant message (streaming already handled) |
| `user` | Extract `tool_result` blocks, emit as `request_tool_results` | Tool execution results from CLI |
| `result` | Emit `turn_stop` with usage/cost | Agent turn completed |
| `control_request` | Auto-approve with `control_response` | Permission requests (safety net) |
| `system` | Log | Initialization with capabilities |
| `keep_alive` | Ignore | Heartbeat |

#### Key Pattern: stream_event Unwrapping

The CLI wraps Anthropic SSE events in a `stream_event` envelope. We unwrap to preserve the standard format:

```typescript
// CLI sends:  { type: "stream_event", event: { type: "content_block_delta", ... } }
// We emit:    { type: "content_block_delta", ... }  ← Same format for all consumers
```

#### Key Pattern: Tool Results from User Messages

After the CLI executes tools, it sends results as `type: "user"` messages with `tool_result` content blocks. We extract these and emit `request_tool_results` events so the UI can display tool output:

```typescript
// CLI sends:  { type: "user", message: { role: "user", content: [{ type: "tool_result", ... }] } }
// We emit:    { type: "request_tool_results", tool_results: [{ tool_use_id, content, is_error }] }
```

#### Flush-on-Connect Pattern

The CLI takes ~500ms to connect after spawn. User prompts sent before connection are queued in `pendingMessages` and flushed when the WebSocket opens.

### Thinking Proxy (port 30088)

A lightweight HTTP proxy that injects adaptive thinking configuration into API requests. This is needed because the CLI's `--effort` flag doesn't inject API-level thinking parameters.

```
CLI HTTP Request → Proxy :30088 → Injects thinking config → Anthropic API
                                                                │
                                   API returns thinking blocks in SSE
                                                                │
                                   CLI forwards via --sdk-url stream_event
```

The proxy only modifies `POST /v1/messages` requests (excluding Haiku side-channel):

```typescript
parsed.thinking = { type: "adaptive" };
parsed.output_config = { effort: this.effort };  // "low" | "medium" | "high" | "max"
```

Thinking events flow through the `--sdk-url` WebSocket bridge naturally — the proxy never parses responses.

### Session Lifecycle

1. **Create**: Gateway sends `session.create` → Runtime spawns nothing yet (lazy start)
2. **First prompt**: `session.prompt` → `ensureProcess()` spawns CLI with `--sdk-url` + `--session-id`
3. **Resume**: `session.prompt` to existing session → `ensureProcess()` spawns CLI with `--resume`
4. **Auto-resume**: If session not running (runtime restarted), auto-spawns on next prompt
5. **Interrupt**: Gateway sends `session.interrupt` → Bridge sends graceful interrupt via WebSocket + emits synthetic stop events for immediate UI update
6. **Close**: Kill CLI process, clean up bridge

### Interrupt Flow

Interrupts use a hybrid approach for responsiveness:

```
User presses ESC → Gateway → Runtime → session.interrupt()
  ├── bridge.sendInterrupt() → WebSocket message to CLI (graceful)
  └── emitSyntheticStops()  → Immediate UI update (content_block_stop, message_stop, turn_stop)
```

The synthetic events ensure the UI reflects the abort immediately, even if the CLI takes a moment to process the interrupt.

## Data Flow

### Prompts (User → Claude)

```
Browser → Gateway WS → Runtime WS → CliBridge → CLI WS (NDJSON)
```

Attachments are sent as Anthropic API content blocks:
- Images: `{ type: "image", source: { type: "base64", media_type, data } }`
- Files: `{ type: "document", source: { type: "base64", media_type, data } }`

### Streaming (Claude → User)

```
Anthropic API SSE → CLI → --sdk-url stream_event → CliBridge
  → unwrap to SSE event → Runtime EventEmitter → Gateway WS → UI
```

SSE event types: `message_start`, `content_block_start`, `content_block_delta`, `content_block_stop`, `message_delta`, `message_stop`, `turn_stop`

### Tool Results

```
CLI executes tool → sends type:"user" with tool_result blocks → CliBridge
  → extracts tool_results → emits request_tool_results → Gateway → UI
```

### Thinking

```
CLI HTTP → Proxy :30088 (injects thinking config) → Anthropic API
API SSE response → CLI → --sdk-url stream_event → CliBridge → UI
```

Thinking blocks appear as `content_block_start` with `type: "thinking"`, followed by `content_block_delta` with thinking text.

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

### Session Lifecycle Flows

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

## File Map

```
packages/
  gateway/
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

  runtime/
    src/
      index.ts              # Bun.serve, dual WS paths, ThinkingProxy setup
      manager.ts            # Session lifecycle, CLI WS routing
      session.ts            # CLI process spawn, interrupt, event tracking
      cli-bridge.ts         # WebSocket bridge for CLI NDJSON protocol
      thinking-proxy.ts     # HTTP proxy for thinking config injection

  sdk/                      # claudia-sdk (being replaced by runtime)

  shared/
    src/
      types.ts              # Shared protocol types
      config.ts             # claudia.json loader

  ui/
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

## Ports

| Port | Service | Description |
|------|---------|-------------|
| 30086 | Gateway | HTTP + WebSocket + SPA serving |
| 30087 | Runtime | Gateway WS + CLI WS (dual path) |
| 30088 | Thinking Proxy | HTTP proxy for thinking injection |

Port 30086 = SHA256("Claudia") → x7586 → 30086
