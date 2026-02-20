# Gateway Architecture

Deep-dive into the gateway's startup, message routing, and extension communication. For high-level overview, see [ARCHITECTURE.md](./ARCHITECTURE.md).

## Startup Sequence

```
┌─────────────┐     ┌─────────────┐     ┌─────────────────────┐
│  Watchdog    │     │   Gateway    │     │  Extension Hosts    │
│  :30085      │     │   :30086     │     │  (child processes)  │
└──────┬──────┘     └──────┬──────┘     └──────────┬──────────┘
       │                    │                        │
       │  Bun.spawn(gateway)│                        │
       ├───────────────────►│                        │
       │                    │                        │
       │                    │  1. loadConfig()       │
       │                    │  2. getDb() (SQLite)   │
       │                    │  3. new SessionManager  │
       │                    │  4. new ExtensionManager │
       │                    │  5. Bun.serve(:30086)  │
       │                    │                        │
       │                    │  start.ts runs async:  │
       │                    │  killOrphanHosts()     │
       │                    │                        │
       │                    │  For each enabled ext: │
       │                    │  Bun.spawn(bun --hot   │
       │                    │    extension-host/     │
       │                    │    src/index.ts        │
       │                    │    <module> <config>)  │
       │                    ├───────────────────────►│
       │                    │                        │
       │                    │  ◄── stdin/stdout ──►  │
       │                    │      NDJSON pipes      │
       │                    │                        │
       │                    │  {"type":"register",   │
       │                    │   "extension":{        │
       │                    │     "id":"voice",      │
       │                    │     "methods":[...],   │
       │                    │     "events":[...]}}   │
       │                    │◄───────────────────────┤
       │                    │                        │
       │                    │  extensions.           │
       │                    │   registerRemote()     │
       │                    │                        │
       │                    │  Repeat for: chat,     │
       │                    │  voice, imessage,      │
       │                    │  mission-control,      │
       │                    │  hooks, dominatrix     │
       │                    │                        │
       │                    │  6. connectToRuntime() │
       │                    │     ws://localhost:     │
       │                    │     30087/ws            │
       │                    │                        │
       │  /health 200 OK   │                        │
       │◄───────────────────┤                        │
       │                    │                        │
```

### Gateway Init Order (index.ts)

1. **Config** — `loadConfig()` from `~/.claudia/claudia.json`
2. **Database** — SQLite via `getDb()` (workspaces + sessions)
3. **SessionManager** — Created with broadcast callbacks
4. **ExtensionManager** — Empty, extensions registered later
5. **Bun.serve** — HTTP + WebSocket on single port
6. **start.ts** (async) — Kill orphans, spawn extension hosts, connect to runtime

### Extension Host Spawn (start.ts)

```
For each extension in config where enabled=true:
  1. Resolve entrypoint: extensions/<id>/src/index.ts
  2. Spawn: bun --hot extension-host/src/index.ts <module-url> <config-json>
  3. Wait for "register" message on stdout (10s timeout)
  4. Call extensions.registerRemote(registration, host)
```

All extensions run out-of-process. The `extension-host` shim handles:

- NDJSON stdin/stdout protocol
- Console redirect (console.log → stderr, stdout reserved for protocol)
- HMR via `bun --hot` (process stays alive, module reloads)
- Parent liveness check (exits if reparented to PID 1)

---

## WebSocket Client Management

### Connection Lifecycle

```
Client                          Gateway
  │                                │
  │  GET /ws (upgrade)             │
  ├───────────────────────────────►│
  │                                │  Generate connectionId (UUID)
  │                                │  Store in clients Map
  │  gateway.welcome               │
  │  {connectionId: "conn-abc"}    │
  │◄───────────────────────────────┤
  │                                │
  │  subscribe                     │
  │  {events: ["stream.*",         │
  │   "voice.*"]}                  │
  ├───────────────────────────────►│  Add to client.subscriptions
  │                                │
  │  ... normal requests ...       │
  │                                │
  │  (tab closed / disconnect)     │
  │ ──────────── X ────────────────│  Remove from clients Map
  │                                │  Clean up voiceStreamOrigins
```

### Client State

```typescript
interface ClientState {
  id: string; // UUID, assigned on connect
  connectedAt: Date;
  subscriptions: Set<string>; // Event patterns: "stream.*", "voice.*", etc.
}

const clients = new Map<ServerWebSocket<ClientState>, ClientState>();
```

Each tab/connection gets its own `connectionId`. Subscriptions are per-connection.

---

## Request/Response Protocol

All communication uses a uniform envelope:

```typescript
// Client → Gateway (request)
{ type: "req", id: "req-123", method: "session.prompt", params: {...} }

// Gateway → Client (response)
{ type: "res", id: "req-123", ok: true, payload: {...} }

// Gateway → Client (event, pushed)
{ type: "event", event: "stream.{sessionId}.content_block_delta", payload: {...} }
```

### Request Routing (handleRequest)

```
method.split(".") → [namespace, action]

  session.*     → handleSessionMethod()      (prompt, history, switch, interrupt, ...)
  workspace.*   → handleWorkspaceMethod()    (list, get, create-session, ...)
  extension.*   → handleExtensionBuiltin()   (list)
  runtime.*     → handleRuntimeMethod()      (health-check, kill-session)
  method.*      → handleMethodBuiltin()      (list)
  subscribe     → addSubscriptions()
  unsubscribe   → removeSubscriptions()
  *             → extensions.handleMethod()  (voice.speak, dominatrix.snapshot, ...)
```

All built-in methods have Zod schemas. Validation happens at the gateway boundary — handlers can assume valid input.

---

## Full Message Flow: Prompt → Response → Voice

This traces a complete round trip from web client through to voice output.

```
 Web Client          Gateway             SessionManager        Runtime(:30087)      Claude CLI         Voice Extension
    │                   │                      │                    │                   │                    │
    │  req: session.    │                      │                    │                    │                    │
    │  prompt           │                      │                    │                    │                    │
    │  {sessionId,      │                      │                    │                    │                    │
    │   content,        │                      │                    │                    │                    │
    │   speakResponse:  │                      │                    │                    │                    │
    │   true}           │                      │                    │                    │                    │
    ├──────────────────►│                      │                    │                    │                    │
    │                   │                      │                    │                    │                    │
    │                   │  prompt(content,      │                    │                    │                    │
    │                   │   requestContext:{    │                    │                    │                    │
    │                   │    wantsVoice:true,   │                    │                    │                    │
    │                   │    connectionId:      │                    │                    │                    │
    │                   │     "conn-abc"})      │                    │                    │                    │
    │                   ├─────────────────────►│                    │                    │                    │
    │                   │                      │                    │                    │                    │
    │                   │                      │  Store in          │                    │                    │
    │                   │                      │  requestContext    │                    │                    │
    │                   │                      │  ByCcSessionId     │                    │                    │
    │                   │                      │                    │                    │                    │
    │                   │                      │  WS: session.      │                    │                    │
    │                   │                      │  prompt            │                    │                    │
    │                   │                      ├───────────────────►│                    │                    │
    │                   │                      │                    │                    │                    │
    │                   │                      │                    │  stdin NDJSON:     │                    │
    │                   │                      │                    │  {type:"user",     │                    │
    │                   │                      │                    │   message:{...}}   │                    │
    │                   │                      │                    ├───────────────────►│                    │
    │                   │                      │                    │                    │                    │
    │                   │                      │                    │                    │  (Claude thinks,   │
    │                   │                      │                    │                    │   calls tools,     │
    │                   │                      │                    │                    │   generates text)  │
    │                   │                      │                    │                    │                    │
    │                   │                      │                    │  stdout NDJSON:    │                    │
    │                   │                      │                    │  {type:            │                    │
    │                   │                      │                    │   "stream_event",  │                    │
    │                   │                      │                    │   event:{type:     │                    │
    │                   │                      │                    │    "content_block  │                    │
    │                   │                      │                    │     _start",...}}  │                    │
    │                   │                      │                    │◄───────────────────┤                    │
    │                   │                      │                    │                    │                    │
    │                   │                      │                    │  emit("sse",       │                    │
    │                   │                      │                    │   event)           │                    │
    │                   │                      │                    │                    │                    │
    │                   │                      │  WS event:         │                    │                    │
    │                   │                      │  stream.{id}.      │                    │                    │
    │                   │                      │  content_block_    │                    │                    │
    │                   │                      │  start             │                    │                    │
    │                   │                      │◄───────────────────┤                    │                    │
    │                   │                      │                    │                    │                    │
    │                   │                      │  ┌─── DUAL BROADCAST ───┐               │                    │
    │                   │                      │  │                      │               │                    │
    │                   │  broadcastEvent()    │  │  1. To WS clients    │               │                    │
    │  event: stream.   │◄─────────────────────┤  │  (subscription       │               │                    │
    │  {id}.content_    │                      │  │   matching)          │               │                    │
    │  block_start      │                      │  │                      │               │                    │
    │◄──────────────────┤                      │  │                      │               │                    │
    │                   │                      │  │                      │               │                    │
    │                   │  broadcastExtension() │  │  2. To extensions   │               │                    │
    │                   │                      │  │  (generic name +     │               │                    │
    │                   │                      │  │   speakResponse      │               │                    │
    │                   │                      │  │   flag injected)     │               │                    │
    │                   │                      │  └──────────────────────┘               │                    │
    │                   │                      │                    │                    │                    │
    │                   │  extensions.broadcast │                    │                    │                    │
    │                   │  ({type:"session.     │                    │                    │                    │
    │                   │   content_block_start"│                    │                    │                    │
    │                   │   payload:{...,       │                    │                    │                    │
    │                   │    speakResponse:     │                    │                    │                    │
    │                   │    true}})            │                    │                    │
    │                   ├──────────────────────────────────────────────────────────────►│
    │                   │                      │                    │                    │  (via stdin NDJSON │
    │                   │                      │                    │                    │   to ext host)     │
    │                   │                      │                    │                    │                    │
    │                   │                      │                    │                    │  Voice sees        │
    │                   │                      │                    │                    │  speakResponse=true│
    │                   │                      │                    │                    │  → startStream()   │
    │                   │                      │                    │                    │                    │
    │                   │  voice.stream_start   │                    │                    │                    │
    │                   │  {streamId:"s-xyz",   │                    │                    │                    │
    │                   │   sessionId:"..."}    │                    │                    │                    │
    │                   │◄─────────────────────────────────────────────────────────────────┤
    │                   │                      │                    │                    │  (via stdout NDJSON│
    │                   │                      │                    │                    │   from ext host)   │
    │                   │                      │                    │                    │                    │
    │                   │  emit callback:       │                    │                    │                    │
    │                   │  voiceStreamOrigins   │                    │                    │                    │
    │                   │  .set("s-xyz",        │                    │                    │                    │
    │                   │       "conn-abc")     │                    │                    │                    │
    │                   │                      │                    │                    │                    │
    │                   │  ... text deltas flow, voice buffers sentences ...             │                    │
    │                   │                      │                    │                    │                    │
    │                   │  voice.audio_chunk    │                    │                    │                    │
    │                   │  {streamId:"s-xyz",   │                    │                    │                    │
    │                   │   audio:"base64..."}  │                    │                    │                    │
    │                   │◄─────────────────────────────────────────────────────────────────┤
    │                   │                      │                    │                    │                    │
    │                   │  CONNECTION-SCOPED:   │                    │                    │                    │
    │                   │  streamId → "s-xyz"   │                    │                    │                    │
    │                   │  voiceStreamOrigins   │                    │                    │                    │
    │                   │  → "conn-abc"         │                    │                    │                    │
    │                   │  ONLY send to         │                    │                    │                    │
    │  voice.audio_     │  conn-abc             │                    │                    │                    │
    │  chunk            │                      │                    │                    │                    │
    │◄──────────────────┤                      │                    │                    │                    │
    │                   │                      │                    │                    │                    │
    │  (Other tabs      │                      │                    │                    │                    │
    │   do NOT receive  │                      │                    │                    │                    │
    │   this event)     │                      │                    │                    │                    │
    │                   │                      │                    │                    │                    │
```

---

## Event Broadcasting: Three Scopes

The gateway has three distinct broadcast mechanisms:

### 1. Client Broadcast (subscription-based)

```typescript
broadcastEvent(eventName, payload);
```

Sends to all connected WebSocket clients whose `subscriptions` match the event pattern. Patterns support:

- `"*"` — all events
- `"stream.*"` — prefix wildcard
- `"voice.audio_chunk"` — exact match

Used for: session stream events (`stream.{sessionId}.*`), general notifications.

### 2. Extension Broadcast (pattern-based)

```typescript
broadcastExtension(gatewayEvent)
  → extensions.broadcast(event)
    → For each remote host: host.sendEvent(event)  // stdin NDJSON
    → For each local handler: handler(event)
```

Sends to all extension hosts via stdio. Extensions subscribe with `ctx.on("session.*", handler)`. The extension host's internal event bus does pattern matching.

**Key detail**: Session events are renamed from `stream.{sessionId}.{type}` to `session.{type}` for extensions — they don't need to know the sessionId to subscribe.

### 3. Connection-Scoped Broadcast (voice)

```typescript
// In broadcastEvent():
if (eventName.startsWith("voice.") && targetConnectionId !== null) {
  // Send ONLY to the connection that initiated this voice stream
}
```

Voice audio events carry a `streamId`. The gateway tracks `streamId → connectionId` in `voiceStreamOrigins`. When a `voice.*` event has a known streamId, it's sent only to the originating connection.

---

## Voice Routing: The Multi-Tab Problem

### How Connection Scoping Works

```
voiceStreamOrigins: Map<streamId, connectionId>

1. Client sends prompt with speakResponse=true
2. SessionManager stores connectionId in requestContext
3. Voice extension starts stream → emits voice.stream_start {streamId, sessionId}
4. Gateway's emit callback:
   - Looks up connectionId via sessionManager.getConnectionIdForSession(sessionId)
   - Maps streamId → connectionId in voiceStreamOrigins
5. Subsequent voice.audio_chunk events → scoped to that connectionId
6. voice.stream_end → cleans up voiceStreamOrigins
```

### Design Note: connectionId Is Always Tracked

Every prompt stores the originating `connectionId` in `requestContext`, regardless of the `speakResponse` flag. This ensures voice scoping works correctly even when `autoSpeak` is enabled — audio routes to the tab that sent the prompt, not all tabs.

---

## Extension Host Communication (stdio NDJSON)

### Protocol

```
Gateway → Host (stdin):
  {"type":"req","id":"abc","method":"voice.speak","params":{...}}
  {"type":"event","event":"session.content_block_delta","payload":{...}}

Host → Gateway (stdout):
  {"type":"register","extension":{"id":"voice","methods":[...],"events":[...]}}
  {"type":"res","id":"abc","ok":true,"payload":{...}}
  {"type":"event","event":"voice.audio_chunk","payload":{...}}
  {"type":"error","error":"Fatal: ..."}
```

### Host Process Lifecycle

```
                  Gateway                    Extension Host
                     │                            │
                     │  Bun.spawn(bun --hot       │
                     │    ext-host <module>)       │
                     ├───────────────────────────►│
                     │                            │  import(module)
                     │                            │  factory(config) → extension
                     │                            │  extension.start(ctx)
                     │  {"type":"register",...}   │
                     │◄───────────────────────────┤
                     │                            │
                     │  ... normal operation ...   │
                     │                            │
                     │  (file change detected)     │
                     │                            │  import.meta.hot.dispose()
                     │                            │  → extension.stop()
                     │                            │  → eventHandlers.clear()
                     │                            │
                     │                            │  (module re-executes)
                     │                            │  → loadAndStart()
                     │                            │  → new extension registered
                     │  {"type":"register",...}   │  → stdin NOT re-bound
                     │◄───────────────────────────┤    (import.meta.hot.data
                     │                            │     .stdinBound = true)
                     │  extensions.registerRemote │
                     │  (overwrites previous)     │
                     │                            │
```

### Auto-Restart on Crash

```
Exit detected → handleExit()
  if (!killed && restartCount < 5):
    Wait 2s
    spawn() again
  else:
    Log error, give up
```

### Parent Liveness Check

Extension hosts poll `process.ppid` every 2 seconds. If the parent PID changes (gateway died and host got reparented to PID 1/launchd), the host self-terminates. This prevents orphan buildup when `bun --watch` restarts the gateway.

---

## Runtime Connection (SessionManager → Runtime)

```
SessionManager                     Runtime (:30087)
     │                                  │
     │  ws://localhost:30087/ws         │
     ├─────────────────────────────────►│
     │                                  │
     │  subscribe {events:              │
     │   ["stream.*"]}                  │
     ├─────────────────────────────────►│
     │                                  │
     │  session.create / session.resume │
     ├─────────────────────────────────►│
     │                                  │  Bun.spawn("claude", [
     │                                  │    "--print",
     │                                  │    "--output-format", "stream-json",
     │                                  │    "--input-format", "stream-json",
     │                                  │    "--include-partial-messages",
     │                                  │    "--model", model,
     │                                  │    "--session-id", id
     │                                  │  ])
     │                                  │
     │  session.prompt                  │
     ├─────────────────────────────────►│  stdin: {type:"user", message:{...}}
     │                                  │────────────────────────►  Claude CLI
     │                                  │
     │                                  │  stdout NDJSON stream:
     │                                  │◄────────────────────────  Claude CLI
     │  event: stream.{id}.             │
     │   content_block_delta            │
     │◄─────────────────────────────────┤
     │                                  │
     │  (on disconnect)                 │
     │  ── X ──────────────────────────│
     │                                  │
     │  Auto-reconnect after 2s        │
     │─────────────────────────────────►│
     │                                  │
```

The runtime is a separate persistent service. It:

- Survives gateway restarts (keeps Claude sessions alive)
- Dual-engine: CLI subprocess (stdin/stdout NDJSON) or Agent SDK (`query()` function) — configurable via `runtime.engine`
- Both engines emit identical stream events as `stream.{ccSessionId}.{eventType}`
- Handles thinking config (CLI: `control_request` on stdin, SDK: query options)

### Session Event Processing in SessionManager

When a runtime event arrives:

```
stream.{ccSessionId}.{eventType}
         │                │
         │                └─► Used for: client subscriptions (scoped to session)
         │
         └─► Mapped to: session.{eventType} for extension pattern matching

For each event:
  1. Look up requestContext by ccSessionId
  2. Inject speakResponse flag into payload (for voice extension)
  3. broadcastEvent() → WS clients (subscription matching)
  4. broadcastExtension() → all extension hosts (stdio)
  5. On message_stop + source: routeToSource() → specific extension
```

---

## Source Routing (Multi-Tenant Extensions)

Some extensions handle multiple external "sources" (iMessage conversations, etc.):

```
iMessage: "+15551234" sends text
  → imessage extension creates prompt with source="imessage/+15551234"
  → SessionManager stores source in requestContext
  → Claude responds
  → On message_stop: routeToSource("imessage/+15551234", event)
  → Gateway looks up prefix "imessage" → imessage extension host
  → Calls host.routeToSource(source, event)
  → iMessage extension sends reply to that phone number
```

Source format: `"prefix/id"` where prefix maps to an extension.

---

## Key Data Structures

### SessionManager.requestContextByCcSessionId

```typescript
Map<
  string,
  {
    wantsVoice: boolean; // Should voice extension speak this response?
    source: string | null; // Source routing key (e.g., "imessage/+15551234")
    connectionId: string | null; // WebSocket connection that initiated this prompt
    responseText: string; // Accumulated response text for source routing
  }
>;
```

Set during `prompt()`, read during event processing, cleared on `message_stop`.

### voiceStreamOrigins (gateway index.ts)

```typescript
Map<string, string>; // streamId → connectionId
```

Set when `voice.stream_start` is emitted. Used to scope `voice.*` events to the originating connection. Cleaned up on `voice.stream_end` and client disconnect.

### ExtensionManager Maps

```typescript
remoteHosts: Map<string, ExtensionHostProcess>; // id → host process
remoteRegistrations: Map<string, ExtensionRegistration>; // id → method/event metadata
sourceRoutes: Map<string, string>; // prefix → extensionId
remoteSourceRoutes: Map<string, ExtensionHostProcess>; // prefix → host process
```
