# Claudia Architecture

## System Overview

Claudia is a single-tier system: a **Gateway** that routes messages between clients and **Extensions** that contain all business logic. The gateway is a pure hub — it validates, routes, and fans out events but owns no domain logic. Extensions run as separate processes communicating over NDJSON stdio.

```
┌────────────────────────────────────────────────────────────────────┐
│                         Clients                                    │
│  Web UI · CLI · VS Code · macOS Menubar · iOS · iMessage           │
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
│  ┌──────────────────┐  ┌──────────────────┐                        │
│  │  Event Bus        │  │  Extension       │                        │
│  │  (sub-based WS,   │  │  Manager         │                        │
│  │   pattern-based   │  │  (method/event   │                        │
│  │   extensions)     │  │   routing,       │                        │
│  │                   │  │   ctx.call hub)  │                        │
│  └──────────────────┘  └──────────────────┘                        │
└────────┬───────────┬───────────┬───────────┬───────────────────────┘
         │           │           │           │  NDJSON stdio
    ┌────▼───┐  ┌────▼───┐  ┌───▼────┐  ┌───▼────┐
    │session │  │ voice  │  │  chat  │  │  ...   │
    │        │  │        │  │        │  │        │
    │SDK     │  │Cartesia│  │Web     │  │hooks,  │
    │engine, │  │TTS,    │  │pages,  │  │imsg,   │
    │CRUD,   │  │stream  │  │routes  │  │memory, │
    │history │  │audio   │  │        │  │ctrl   │
    └────────┘  └────────┘  └────────┘  └────────┘
```

## Gateway (port 30086)

The gateway is a pure message hub. Single Bun.serve instance handling HTTP, WebSocket, and static file serving.

### Request Handling

```
fetch(req):
  /ws      → WebSocket upgrade → handleMessage()
  /health  → JSON status (extensions, connections)
  /*       → SPA fallback (index.html, Tailwind + Bun bundling)

websocket:
  open     → register client, assign ID
  message  → parse JSON → validate schema → route to extension
  close    → cleanup client
```

### Gateway-Owned Methods

The gateway itself only owns discovery and subscription methods:

| Method                    | Purpose                     |
| ------------------------- | --------------------------- |
| `gateway.list_methods`    | All methods with schemas    |
| `gateway.list_extensions` | All loaded extensions       |
| `gateway.subscribe`       | Subscribe to event patterns |
| `gateway.unsubscribe`     | Remove subscriptions        |

Everything else is handled by extensions.

### Method Routing

All methods are namespaced by extension ID. The gateway routes by prefix to the owning extension:

```
session.send_prompt    → session extension
voice.speak            → voice extension
chat.health_check      → chat extension
gateway.list_methods   → gateway itself
```

### Event Fanout

Events flow through two channels:

- **WebSocket clients** — subscription-based. Clients subscribe to event patterns with wildcards (e.g., `session.*`, `*`). Events broadcast only to matching subscribers.
- **Extensions** — pattern-based. Extensions declare event patterns at registration time and receive matching events over their NDJSON stdio channel.

### Key Files

| File                    | Purpose                                               |
| ----------------------- | ----------------------------------------------------- |
| `src/index.ts`          | Bun.serve, WS handlers, event routing                 |
| `src/extensions.ts`     | ExtensionManager, method/event routing, ctx.call()    |
| `src/extension-host.ts` | ExtensionHostProcess, spawns extensions, NDJSON stdio |
| `src/start.ts`          | Config-driven extension loading                       |
| `src/db/`               | SQLite (migrations only, data owned by extensions)    |
| `src/web/`              | SPA shell (index.html + route collector)              |

## WebSocket Protocol

All client communication uses a single protocol:

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

### Schema Validation

All methods declare Zod schemas for input validation. The gateway validates params at the boundary before dispatching to extensions. Invalid requests receive clear error messages.

### Event Subscriptions

```typescript
// Subscribe to all session events
{ method: "gateway.subscribe", params: { events: ["session.*"] } }

// Subscribe to everything
{ method: "gateway.subscribe", params: { events: ["*"] } }
```

## Extension System

### Architecture

Extensions are out-of-process. The gateway spawns one child process per enabled extension:

```
bun --hot extensions/<id>/src/index.ts <config-json>
```

Each extension's `index.ts` is directly executable:

```typescript
import { runExtensionHost } from "@claudia/extension-host";
if (import.meta.main) runExtensionHost(createMyExtension);
```

Native HMR via `bun --hot` — code changes reload extensions without restarting the gateway or dropping WebSocket connections.

Communication between gateway and extension processes uses NDJSON over stdio (stdin/stdout pipes).

### Extension Loading

Extensions are config-driven from `~/.claudia/claudia.json`. The gateway resolves `extensions/<id>/src/index.ts` and starts one `ExtensionHostProcess` per enabled extension.

### Extension Interface

```typescript
interface ExtensionMethodDefinition {
  name: string;
  description: string;
  inputSchema: ZodTypeAny;
}

interface ClaudiaExtension {
  id: string;
  name: string;
  methods: ExtensionMethodDefinition[];
  events: string[];
  sourceRoutes?: string[];
  start(ctx: ExtensionContext): Promise<void>;
  stop(): Promise<void>;
  handleMethod(method: string, params: Record<string, unknown>): Promise<unknown>;
  health(): HealthCheckResponse;
}
```

### ExtensionContext

The context provided to each extension at startup:

- `on(pattern, handler)` — subscribe to gateway events (wildcard support)
- `emit(type, payload)` — emit events to the bus
- `call(method, params)` — inter-extension RPC via the gateway hub
- `config` — extension configuration
- `log` — scoped logger

### ctx.call() Hub

Extensions call each other through the gateway as a hub:

```
Extension A → ctx.call("session.send_prompt", {...})
  → gateway hub
  → Extension B handles method
  → response returns to Extension A
```

RPC metadata: `traceId`, `depth` (max 8), `deadlineMs`. Per-extension rate limit: 50 in-flight calls.

### Extensions

| Extension       | ID         | What It Does                                             |
| --------------- | ---------- | -------------------------------------------------------- |
| Session         | `session`  | SDK engine (Agent SDK query()), workspace CRUD, history  |
| Chat            | `chat`     | Web pages: /, /workspace/:id, /workspace/:id/session/:id |
| Voice           | `voice`    | Cartesia Sonic 3.0 TTS, streaming audio                  |
| iMessage        | `imessage` | iMessage bridge, auto-reply                              |
| Mission Control | `control`  | System dashboard, health checks                          |
| Hooks           | `hooks`    | Lightweight event-driven scripts                         |
| Memory          | `memory`   | Transcript ingestion + Libby processing                  |

### Client-Side Extensions (Routes)

Extensions can declare web pages:

```
extensions/<name>/src/
  index.ts       # Server: createMyExtension() → ClaudiaExtension
  routes.ts      # Client: export const myRoutes: Route[]
  pages/         # React page components
```

Routes use feature paths (e.g., `/control`); chat owns `/`. The web shell (`packages/gateway/src/web/index.tsx`) imports routes from all extensions and feeds them to the `Router` component.

### Health Checks

Every extension exposes a `{id}.health_check` method returning structured status:

```typescript
interface HealthCheckResponse {
  ok: boolean;
  status: "healthy" | "degraded" | "disconnected" | "error";
  label: string;
  metrics?: Array<{ label: string; value: string | number }>;
  actions?: Array<{ label: string; method: string; params?: Record<string, unknown> }>;
  items?: Array<{ id: string; label: string; status: string }>;
}
```

## Session Extension

The session extension owns all Claude interaction and workspace management. It is the most complex extension.

### SDK Engine

Uses `@anthropic-ai/claude-agent-sdk` `query()` function — an async generator that yields `SDKMessage` types.

Multi-turn conversations use a push-based `MessageChannel` (async iterable) that stays open for the session lifetime:

```typescript
const channel = new MessageChannel();
const q = query({ prompt: channel, options: { ... } });

// Each prompt pushes into the channel
channel.push({ role: "user", content: "Hello" });

// query yields messages as they stream back
for await (const msg of q) {
  routeMessage(msg);
}
```

### SDK Message Routing

| SDK Message Type | Action                                                    |
| ---------------- | --------------------------------------------------------- |
| `stream_event`   | Unwrap inner `event`, emit as SSE                         |
| `assistant`      | Log only                                                  |
| `user`           | Extract `tool_result` blocks, emit `request_tool_results` |
| `result`         | Emit `turn_stop` with usage/cost                          |
| `system`         | Handle compaction events                                  |
| `tool_progress`  | Emit tool_progress                                        |

### Workspace Registry

Workspace and session metadata stored in SQLite (WAL mode). Session source-of-truth is the filesystem — session history lives in `~/.claude/projects/{dash-encoded-cwd}/*.jsonl`.

### History Parsing

Session history is parsed from JSONL files on disk with pagination. Uses load-all-then-slice (required because tool results in user messages backfill earlier assistant tool_use blocks):

```
Request:  { method: "session.history", params: { sessionId: "...", limit: 50, offset: 0 } }
Response: { messages: [...50], total: 4077, hasMore: true, offset: 0 }
```

### Session Lifecycle

1. **Create**: client calls `session.create_session` with `cwd`
2. **First prompt**: `session.send_prompt` starts SDK `query()` with `sessionId`
3. **Resume**: auto-resume with `cwd` when session not in memory
4. **History**: parsed from JSONL files on disk
5. **Interrupt**: `query.interrupt()` + synthetic stop events for immediate UI update

### Thinking Effort Levels

| Effort   | Tokens |
| -------- | ------ |
| `low`    | 4,000  |
| `medium` | 8,000  |
| `high`   | 16,000 |
| `max`    | 32,000 |

## Data Flow

### Prompts (User → Claude)

```
Browser → Gateway WS → session extension (NDJSON stdio) → SDK query() → Claude API
```

Attachments are sent as Anthropic API content blocks:

- Images: `{ type: "image", source: { type: "base64", media_type, data } }`
- Files: `{ type: "document", source: { type: "base64", media_type, data } }`

### Streaming (Claude → User)

```
Claude API → Agent SDK → session extension → gateway event bus → WS clients
```

SSE event types: `message_start`, `content_block_start`, `content_block_delta`, `content_block_stop`, `message_delta`, `message_stop`, `turn_stop`

### Voice

```
session events → voice extension (via event bus) → Cartesia TTS → audio chunks
  → gateway → scoped to originating WS connection
```

### Source Routing

For extensions bridging external systems (e.g., iMessage):

```
iMessage from +1234 → imessage extension → ctx.call("session.send_prompt", ...)
  → Claude responds → message_stop event
  → imessage extension receives event → sends reply to chat
```

## Client-Side Router

Zero-dependency pushState router in `packages/ui/src/router.tsx` (~75 lines):

- `matchPath(pattern, pathname)` — regex `:param` matching
- `Router` component — iterates routes, first match wins
- `navigate(path)` — pushState + dispatch popstate
- `Link` component — respects modifier keys
- `useRouter()` hook — current pathname, params, navigate

The gateway's `"/*"` route serves `index.html` for all paths, enabling clean URLs.

## Watchdog (port 30085)

Standalone process supervisor that manages the gateway as a direct child process via `Bun.spawn`.

```
Watchdog (port 30085)
  ├── Bun.spawn → Gateway (port 30086)  stdout/stderr → ~/.claudia/logs/gateway.log
  ├── Health monitor (5s interval, 6 consecutive failures → restart)
  ├── Orphan detection via lsof before restarts
  ├── Web dashboard with log viewer + service status
  └── Diagnose & Fix (spawns Claude to auto-fix errors)
```

### Key Design Decisions

- **Direct child process** — No tmux, no screen. Watchdog owns the full process lifecycle.
- **SIGINT/SIGTERM** kills children — clean shutdown, no orphans.
- **Zero monorepo imports** — watchdog is self-contained so it keeps running even when gateway/shared packages have build errors.
- **Orphan port detection** — Before starting a service, `lsof` checks for processes already bound to the port and kills them.

### HTTP API

| Endpoint              | Method | Description                            |
| --------------------- | ------ | -------------------------------------- |
| `/status`             | GET    | JSON status of all services            |
| `/api/logs`           | GET    | List log files                         |
| `/api/logs/:filename` | GET    | Tail a log file (supports pagination)  |
| `/restart/:id`        | POST   | Restart a service                      |
| `/diagnose`           | POST   | Start autonomous diagnosis with Claude |
| `/*`                  | GET    | Dashboard SPA                          |

## Ports

| Port  | Service  | Description                         |
| ----- | -------- | ----------------------------------- |
| 30085 | Watchdog | Process supervisor + dashboard      |
| 30086 | Gateway  | HTTP + WebSocket + SPA + Extensions |

Port 30086 = SHA256("Claudia") → x7586 → 30086

## File Map

```
packages/
  gateway/              # Pure hub — routes messages, no business logic
    src/
      index.ts            Bun.serve, WS handlers, event routing
      start.ts            Config-driven extension loading
      extensions.ts       ExtensionManager, method/event routing, ctx.call()
      extension-host.ts   ExtensionHostProcess, spawns extensions, NDJSON stdio
      db/                 SQLite (migrations)
      web/                SPA shell (index.html + route collector)

  watchdog/             # Process supervisor for gateway
    src/
      index.ts            Bun.serve on port 30085, health monitor, startup
      services.ts         Bun.spawn child processes, health checks, auto-restart
      dashboard/          Vanilla TypeScript dashboard UI

  extension-host/       # runExtensionHost() — NDJSON stdio bridge (imported by extensions)
    src/
      index.ts            Dynamic import, NDJSON stdio, parent PID watchdog

  cli/                  # Schema-driven CLI with method discovery
    src/
      index.ts            Method discovery, param validation, type coercion

  shared/               # Types, config, protocol
    src/
      types.ts            Extension, session, workspace types
      protocol.ts         WebSocket protocol types (req/res/event)
      config.ts           claudia.json loader with env var interpolation

  ui/                   # React components + router
    src/
      router.tsx          Client-side pushState router
      hooks/              useGateway, useAudioPlayback
      components/         ClaudiaChat, MessageList, WorkspaceList, SessionList

  memory-mcp/           # MCP server for persistent memory system

extensions/
  session/src/          # Session lifecycle, SDK engine, workspace CRUD
  chat/src/             # Web pages: /, /workspace/:id, /workspace/:id/session/:id
  voice/src/            # Cartesia Sonic 3.0 TTS, streaming audio
  imessage/src/         # iMessage bridge, auto-reply
  control/src/          # System dashboard, health checks
  hooks/src/            # Event-driven scripts
  memory/src/           # Transcript ingestion + Libby processing

clients/
  ios/                  # Native Swift voice mode app
  menubar/              # macOS menubar app (SwiftUI)
  vscode/               # VS Code extension with sidebar chat

scripts/
  smoke.ts              # Quick smoke test (health + method.list)
  e2e-smoke.ts          # Full E2E test with model call

skills/                 # Claude Code skills (meditation, stories, TTS tools)
```
