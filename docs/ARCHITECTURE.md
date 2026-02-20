# Claudia Architecture

## System Overview

Claudia is a two-tier system: a **Gateway** that serves clients and a **Runtime** that manages Claude sessions. The Gateway handles HTTP, WebSocket, and web UI on port 30086. The Runtime manages sessions via a configurable engine — either CLI subprocess (stdin/stdout pipes) or Agent SDK (`query()` function) — on port 30087.

```
┌────────────────────────────────────────────────────────────────────┐
│                     Clients                                        │
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
│  Bun.serve with single WebSocket path:                             │
│    /ws      → Gateway clients (control plane)                      │
│    /health  → JSON status endpoint                                 │
│                                                                    │
│  ┌───────────────┐  ┌──────────────────────────────────────────┐   │
│  │  Session       │  │  Session Engine (per session)             │   │
│  │  Manager       │  │                                          │   │
│  │               │  │  CLI engine:  Bun.spawn + stdio pipes     │   │
│  │  create/      │  │  SDK engine:  query() async generator     │   │
│  │  resume/      │  │                                          │   │
│  │  prompt/      │  │  Both emit identical StreamEvents         │   │
│  │  interrupt    │  │  via EventEmitter → Manager → Gateway     │   │
│  └───────────────┘  └──────────────────────────────────────────┘   │
└───────────┬────────────────────────────────────────────────────────┘
            │ engine: "cli" (default)          │ engine: "sdk"
            ▼                                  ▼
┌───────────────────────┐    ┌────────────────────────────────────┐
│   CLI Engine          │    │   SDK Engine                       │
│   (RuntimeSession)    │    │   (SDKSession)                     │
│                       │    │                                    │
│  Bun.spawn → CLI      │    │  @anthropic-ai/claude-agent-sdk    │
│  stdin:  NDJSON in    │    │  query() → async generator         │
│  stdout: NDJSON out   │    │  MessageChannel → push-based       │
│                       │    │    async iterable for multi-turn   │
│  Flags:               │    │                                    │
│  --output-format      │    │  Options:                          │
│    stream-json        │    │  sessionId / resume                │
│  --input-format       │    │  systemPrompt, model               │
│    stream-json        │    │  thinking, permissionMode          │
│  --include-partial-   │    │  canUseTool callback               │
│    messages            │    │                                    │
│  --permission-mode    │    │  Control:                          │
│    bypassPermissions  │    │  query.interrupt()                 │
│  --session-id/--resume│    │  query.setPermissionMode()         │
└───────────┬───────────┘    └──────────────┬─────────────────────┘
            │                               │
            └───────────┬───────────────────┘
                        ▼
              ┌────────────────────────┐
              │    Anthropic API       │
              │                        │
              │  Both engines talk to  │
              │  API via Claude Code   │
              │  (CLI spawns it        │
              │  directly, SDK wraps   │
              │  the same CLI)         │
              └────────────────────────┘
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
│    message → parse JSON → validate schema → route to handler   │
│    close   → cleanup client                                    │
│                                                                │
│  development:                                                  │
│    hmr: true (hot module reload + dispose hooks)               │
└──────────────────────────────────────────────────────────────┘
```

The SPA (`packages/gateway/src/web/index.html`) is imported directly by the gateway via Bun's HTML import. Bun handles bundling, CSS (Tailwind via `bun-plugin-tailwind`), and asset serving automatically.

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

#### Schema Validation

All methods declare Zod schemas for input validation. The gateway validates params at the boundary before dispatching to handlers. Invalid requests receive clear error messages listing missing or invalid params.

#### Method Routing

Methods are namespaced. The gateway routes by prefix:

| Prefix        | Handler          | Methods                                                 |
| ------------- | ---------------- | ------------------------------------------------------- |
| `session.*`   | SessionManager   | prompt, history, switch, list, info, interrupt, reset   |
| `workspace.*` | SessionManager   | list, get, get-or-create, create-session, list-sessions |
| `method.*`    | Gateway          | list (returns all methods with schemas)                 |
| `subscribe`   | Client state     | Subscribe to event patterns                             |
| `unsubscribe` | Client state     | Remove subscriptions                                    |
| `*`           | ExtensionManager | Any method registered by an extension                   |

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

The Runtime is a persistent Bun.serve instance managing Claude sessions. It accepts a single type of WebSocket connection:

- **Gateway connections** (`/ws`) — Control plane using the same req/res/event protocol

### Dual-Engine Architecture

The Runtime supports two interchangeable session engines, configured via `runtime.engine` in `~/.claudia/claudia.json`:

| Engine            | Class            | How It Works                                                            | Config Value |
| ----------------- | ---------------- | ----------------------------------------------------------------------- | ------------ |
| **CLI** (default) | `RuntimeSession` | `Bun.spawn` → Claude Code CLI subprocess with stdin/stdout NDJSON pipes | `"cli"`      |
| **SDK**           | `SDKSession`     | `@anthropic-ai/claude-agent-sdk` `query()` async generator              | `"sdk"`      |

Both engines implement the same public interface (`start`, `prompt`, `interrupt`, `close`, `setPermissionMode`, `sendToolResult`) and emit identical events through `EventEmitter`. The gateway sees no difference — switching engines requires only a config change.

```json
// ~/.claudia/claudia.json
{
  "runtime": {
    "engine": "sdk" // or "cli" (default)
  }
}
```

The `RuntimeSessionManager` reads the engine config and routes `create()`/`resume()` to the correct factory:

```typescript
const session = this.engine === "sdk" ? createSDKSession(options) : createRuntimeSession(options);
```

### CLI Engine (RuntimeSession)

Spawns a Claude Code CLI process using `Bun.spawn` with `stdin: "pipe"` and `stdout: "pipe"`. All communication flows through these pipes as NDJSON (newline-delimited JSON):

```
Runtime                              CLI Process
  │                                      │
  │──── stdin (NDJSON) ─────────────────►│
  │  { type: "user", message: {...} }    │
  │  { type: "control_request", ... }    │
  │                                      │
  │◄──── stdout (NDJSON) ───────────────│
  │  { type: "stream_event", ... }       │
  │  { type: "user", ... }              │
  │  { type: "result", ... }            │
  │  { type: "system", ... }            │
  │  { type: "keep_alive" }             │
```

#### Stdin Messages (Runtime → CLI)

| Message Type    | Format                                                                                                                     | Purpose                               |
| --------------- | -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| Prompt          | `{ type: "user", message: { role: "user", content: "..." } }`                                                              | Send user message to Claude           |
| Interrupt       | `{ type: "control_request", request_id: "uuid", request: { subtype: "interrupt" } }`                                       | Gracefully interrupt current response |
| Thinking config | `{ type: "control_request", request_id: "uuid", request: { subtype: "set_max_thinking_tokens", max_thinking_tokens: N } }` | Configure thinking tokens             |

#### Stdout Messages (CLI → Runtime)

| CLI Message Type   | Action                                                       | Description                                            |
| ------------------ | ------------------------------------------------------------ | ------------------------------------------------------ |
| `stream_event`     | Unwrap inner `event`, emit as SSE                            | Real-time streaming deltas (text, thinking, tool use)  |
| `assistant`        | Log only                                                     | Complete assistant message (streaming already handled) |
| `user`             | Extract `tool_result` blocks, emit as `request_tool_results` | Tool execution results from CLI                        |
| `result`           | Emit `turn_stop` with usage/cost                             | Agent turn completed                                   |
| `control_response` | Log                                                          | Confirmation of control requests we sent               |
| `system`           | Log                                                          | Initialization with capabilities                       |
| `keep_alive`       | Ignore                                                       | Heartbeat                                              |

#### Stdout Buffering

Stdout arrives as raw byte chunks, not line-delimited. The session maintains a `stdoutBuffer` string, appends decoded chunks, and splits by newline to extract complete NDJSON lines:

```typescript
this.stdoutBuffer += decoder.decode(value, { stream: true });
while ((newlineIndex = this.stdoutBuffer.indexOf("\n")) !== -1) {
  const line = this.stdoutBuffer.slice(0, newlineIndex).trim();
  this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1);
  if (line.length > 0) this.handleCliLine(line);
}
```

#### Thinking Configuration (CLI)

Thinking is enabled via `control_request` messages sent on stdin immediately after process spawn:

```
Session spawns CLI → sendThinkingConfig(effort) → stdin control_request
                                                    → CLI acknowledges via control_response on stdout
                                                    → CLI includes thinking in API requests
                                                    → Thinking blocks stream back in stream_event messages
```

### SDK Engine (SDKSession)

Uses the `@anthropic-ai/claude-agent-sdk` package to run Claude via the `query()` function — an async generator that yields `SDKMessage` types. The SDK internally spawns and manages the Claude Code CLI, but exposes a clean programmatic interface.

#### MessageChannel Pattern

Multi-turn conversations use a `MessageChannel` — a push-based `AsyncIterable<SDKUserMessage>` that stays open for the session lifetime:

```typescript
// MessageChannel is the "prompt source" for query()
const channel = new MessageChannel();

// query() consumes the channel as its prompt source
const q = query({ prompt: channel, options: { ... } });

// Each prompt() call pushes into the channel
channel.push({ role: "user", content: "Hello" });

// query yields messages as they stream back
for await (const msg of q) {
  routeMessage(msg);  // Same routing logic as CLI engine
}
```

#### SDK Query Options

```typescript
const options = {
  sessionId: isResume ? undefined : this.id,
  resume: isResume ? this.id : undefined,
  cwd,
  model,
  systemPrompt,
  thinking: { type: "enabled", budgetTokens: THINKING_TOKENS[effort] },
  permissionMode: "bypassPermissions",
  canUseTool: async () => ({ behavior: "allow" }), // Auto-approve all tools
  includePartialMessages: true,
};
```

#### SDK Message Routing

The SDK yields `SDKMessage` types that map directly to our event system:

| SDK Message Type | Action                                                    | Same as CLI? |
| ---------------- | --------------------------------------------------------- | ------------ |
| `stream_event`   | Unwrap inner `event`, emit as SSE                         | ✅ Identical |
| `assistant`      | Log only                                                  | ✅ Identical |
| `user`           | Extract `tool_result` blocks, emit `request_tool_results` | ✅ Identical |
| `result`         | Emit `turn_stop` with usage/cost                          | ✅ Identical |
| `system`         | Handle compaction events                                  | ✅ Identical |
| `tool_progress`  | Emit tool_progress                                        | ✅ Identical |

No `control_response` or `keep_alive` — the SDK handles those internally.

#### SDK Control Methods

| Operation      | CLI Engine                           | SDK Engine                             |
| -------------- | ------------------------------------ | -------------------------------------- |
| Prompt         | `sendToStdin(user msg)`              | `messageChannel.push(user msg)`        |
| Interrupt      | `control_request` on stdin           | `query.interrupt()`                    |
| Set permission | `control_request` on stdin           | `query.setPermissionMode(mode)`        |
| Tool result    | `user msg` with tool_result on stdin | `messageChannel.push(tool_result msg)` |
| Close          | `proc.kill()`                        | `query.close()` + `channel.close()`    |

### Shared Patterns (Both Engines)

#### Thinking Effort Levels

| Effort   | Tokens |
| -------- | ------ |
| `low`    | 4,000  |
| `medium` | 8,000  |
| `high`   | 16,000 |
| `max`    | 32,000 |

#### stream_event Unwrapping

Both engines receive Anthropic SSE events wrapped in `stream_event` envelopes. We unwrap to preserve the standard format:

```typescript
// Engine receives: { type: "stream_event", event: { type: "content_block_delta", ... } }
// We emit:         { type: "content_block_delta", ... }  ← Same format for all consumers
```

#### Tool Results from User Messages

After Claude executes tools, results arrive as `type: "user"` messages with `tool_result` content blocks. We extract these and emit `request_tool_results` events so the UI can display tool output:

```typescript
// Engine receives: { type: "user", message: { role: "user", content: [{ type: "tool_result", ... }] } }
// We emit:         { type: "request_tool_results", tool_results: [{ tool_use_id, content, is_error }] }
```

#### Interactive Tool Handling

Both engines auto-approve `ExitPlanMode` and `EnterPlanMode` tools, and forward `AskUserQuestion` to the UI as `request_tool_results` events for user interaction.

### Session Lifecycle

1. **Create**: Gateway sends `workspace.create-session` → Runtime creates session (lazy start — no process/query spawned yet)
2. **First prompt**: `session.prompt` → `ensureProcess()`/`ensureQuery()` starts the engine with `sessionId`
3. **Resume**: `session.prompt` to existing session → engine starts with `resume` flag
4. **Auto-resume**: If session not running (runtime restarted), auto-spawns on next prompt with `cwd` from gateway
5. **Interrupt**: Gateway sends `session.interrupt` → engine-specific interrupt + synthetic stop events for immediate UI update
6. **Close**: Engine-specific cleanup (kill process or close query)

### Interrupt Flow

Interrupts use a hybrid approach for responsiveness:

```
User presses ESC → Gateway → Runtime → session.interrupt()
  ├── CLI:  sendToStdin(control_request: interrupt)  OR  SDK: query.interrupt()
  └── emitSyntheticStops()  → Immediate UI update (content_block_stop, message_stop, turn_stop)
```

The synthetic events ensure the UI reflects the abort immediately, even if the engine takes a moment to process the interrupt.

## Data Flow

### Prompts (User → Claude)

```
Browser → Gateway WS → Runtime WS → Session Engine → Claude
  CLI engine:  prompt → stdin (NDJSON user message)
  SDK engine:  prompt → messageChannel.push(SDKUserMessage)
```

Attachments are sent as Anthropic API content blocks:

- Images: `{ type: "image", source: { type: "base64", media_type, data } }`
- Files: `{ type: "document", source: { type: "base64", media_type, data } }`

### Streaming (Claude → User)

```
Anthropic API → Claude Code → Session Engine → unwrap to SSE event
  → Manager EventEmitter → Runtime WS → Gateway WS → UI
```

SSE event types: `message_start`, `content_block_start`, `content_block_delta`, `content_block_stop`, `message_delta`, `message_stop`, `turn_stop`

### Tool Results

```
Claude executes tool → sends type:"user" with tool_result blocks
  → Session engine extracts tool_results → emits request_tool_results → Gateway → UI
```

### Thinking

```
CLI:  Session spawns CLI → control_request(set_max_thinking_tokens) on stdin
SDK:  Query options include thinking: { type: "enabled", budgetTokens: N }

Both: thinking blocks stream back as stream_event → engine unwraps → Gateway → UI
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

1. **VS Code flow**: `workspace.get-or-create(cwd)` → discovers existing sessions from JSONL files → loads active session
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

Extensions are loaded from config (`~/.claudia/claudia.json`) by extension ID and run out-of-process via `packages/extension-host`. Gateway resolves `extensions/<id>/src/index.ts` and starts one host child process per enabled extension.

### Server-Side Extensions

Extensions register schema-driven methods and events, subscribe to the event bus:

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
  handleSourceResponse?(source: string, event: GatewayEvent): Promise<void>;
  health(): HealthCheckResponse;
}
```

**ExtensionContext** provides:

- `on(pattern, handler)` — subscribe to gateway events (wildcard support)
- `emit(type, payload)` — emit events to the bus
- `config` — extension configuration
- `log` — scoped logger

### Health Checks

Every extension exposes a `{id}.health-check` method returning structured status:

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

### Client-Side Extensions (Routes)

Extensions can also declare web pages:

```
extensions/<name>/src/
  index.ts       # Server: createMyExtension() → ClaudiaExtension
  routes.ts      # Client: export const myRoutes: Route[]
  pages/         # React page components
```

Routes typically use feature paths (for example `/mission-control`); chat owns `/`. There is no required `/ext/<name>` prefix.

The web shell (`packages/gateway/src/web/index.tsx`) imports routes from all extensions and feeds them to the `Router` component from `packages/ui`.

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
      index.ts              # Bun.serve, WS handlers, request routing, schema validation
      start.ts              # Config-driven extension startup (out-of-process)
      session-manager.ts    # Workspace/session lifecycle, history
      extensions.ts         # Extension registration, method/event dispatch, param validation
      parse-session.ts      # JSONL → Message[] with pagination
      web/
        index.html          # SPA shell (imported by gateway)
        index.tsx           # Route collector (~30 lines)
      db/
        index.ts            # SQLite connection
        schema.ts           # Table definitions
        models/
          workspace.ts      # Workspace CRUD
          session.ts        # Session CRUD

  runtime/
    src/
      index.ts              # Bun.serve, single WS path (/ws), health endpoint
      manager.ts            # Session lifecycle, engine selection, event forwarding, auto-resume
      session.ts            # CLI engine — Bun.spawn + stdio NDJSON routing + thinking config
      sdk-session.ts        # SDK engine — Agent SDK query() + MessageChannel + event routing
      SYSTEM_PROMPT.md      # Headless mode addendum appended to every session prompt

  cli/
    src/
      index.ts              # Schema-driven CLI, method discovery, param validation

  shared/
    src/
      types.ts              # Shared types (extensions, sessions, workspaces)
      protocol.ts           # WebSocket protocol types (req/res/event)
      config.ts             # claudia.json loader with env var interpolation
      index.ts              # Re-exports

  ui/
    src/
      router.tsx            # Client-side pushState router
      hooks/
        useGateway.ts       # WebSocket connection + state management
        useAudioPlayback.ts # Timeline-based audio scheduling (Web Audio API)
      components/
        ClaudiaChat.tsx     # Main chat interface
        MessageList.tsx     # Message rendering with pagination
        WorkspaceList.tsx   # Workspace browser
        SessionList.tsx     # Session browser
      contexts/
        WorkspaceContext.tsx # CWD context for path stripping

  watchdog/
    src/
      index.ts              # Bun.serve on port 30085, health monitor loop, startup
      services.ts           # Bun.spawn child processes, health checks, auto-restart
      constants.ts          # Ports, intervals, paths
      logger.ts             # Log rotation
      status.ts             # Status aggregation
      client-health.ts      # Web UI error monitoring
      diagnose.ts           # Auto-fix with Claude CLI
      logs.ts               # Log file API
      dashboard/            # Vanilla TypeScript dashboard UI

  extension-host/
    src/
      index.ts              # Generic shim: dynamic import, NDJSON stdio, parent PID watchdog

  memory-mcp/
    src/
      index.ts              # MCP server for persistent memory system

extensions/
  chat/src/                 # Chat extension (server + web pages)
    index.ts                # Chat server extension entrypoint
    routes.ts               # /, /workspace/:id, /session/:id
    pages/                  # WorkspacesPage, WorkspacePage, SessionPage
    app.ts                  # GATEWAY_URL + PlatformBridge
  voice/src/
    index.ts                # Cartesia TTS extension (streaming)
    cartesia-stream.ts      # Cartesia Sonic 3.0 WebSocket client
    elevenlabs-stream.ts    # ElevenLabs WebSocket client (legacy)
    sentence-chunker.ts     # Text → sentence queue for TTS
    audio-store.ts          # Audio saving + PCM-to-WAV conversion
  imessage/src/
    index.ts                # iMessage bridge extension
    imsg-client.ts          # imsg CLI wrapper
  mission-control/src/
    index.ts                # System dashboard extension
    routes.ts               # /mission-control
    pages/                  # MissionControlPage

scripts/
  smoke.ts                  # Quick smoke test (health + method.list)
  e2e-smoke.ts              # Full E2E test with model call

skills/
  creating-bedtime-stories/ # Bedtime story generation + ElevenLabs TTS
  guiding-meditation/       # Guided meditation generation + ElevenLabs TTS
  chunking-text-for-tts/    # Text chunking for TTS processing
```

## Watchdog (port 30085)

The watchdog is a standalone process supervisor that manages gateway and runtime as direct child processes via `Bun.spawn`. It provides health monitoring, auto-restart with exponential backoff, and a web dashboard.

```
Watchdog (port 30085)
  ├── Bun.spawn → Gateway (port 30086)  stdout/stderr → ~/.claudia/logs/gateway.log
  ├── Bun.spawn → Runtime (port 30087)  stdout/stderr → ~/.claudia/logs/runtime.log
  ├── Health monitor (5s interval, 6 consecutive failures → restart)
  ├── Orphan detection via lsof before restarts
  ├── Web dashboard with log viewer + service status
  └── Diagnose & Fix (spawns Claude to auto-fix errors)
```

### Key Design Decisions

- **Direct child processes** — No tmux, no screen. Watchdog owns the full process lifecycle.
- **SIGINT/SIGTERM** kills children — clean shutdown, no orphans.
- **Zero monorepo imports** — watchdog is self-contained so it keeps running even when gateway/shared packages have build errors.
- **Orphan port detection** — Before starting a service, `lsof` checks for processes already bound to the port and kills them.

### HTTP API

| Endpoint              | Method | Description                            |
| --------------------- | ------ | -------------------------------------- |
| `/status`             | GET    | JSON status of all services            |
| `/api/logs`           | GET    | List log files                         |
| `/api/logs/:filename` | GET    | Tail a log file (supports pagination)  |
| `/restart/:id`        | POST   | Restart a service (gateway or runtime) |
| `/diagnose`           | POST   | Start autonomous diagnosis with Claude |
| `/*`                  | GET    | Dashboard SPA                          |

## Ports

| Port  | Service  | Description                                         |
| ----- | -------- | --------------------------------------------------- |
| 30085 | Watchdog | Process supervisor + dashboard                      |
| 30086 | Gateway  | HTTP + WebSocket + SPA serving                      |
| 30087 | Runtime  | Gateway WS + health check (dual-engine: CLI or SDK) |

Port 30086 = SHA256("Claudia") → x7586 → 30086
