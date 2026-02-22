# Gateway Architecture

Deep-dive into the gateway's startup, message routing, and extension communication. For high-level overview, see [ARCHITECTURE.md](./ARCHITECTURE.md).

## Startup Sequence

```
┌─────────────┐     ┌─────────────────────┐
│   Gateway    │     │  Extension Hosts    │
│   :30086     │     │  (child processes)  │
└──────┬──────┘     └──────────┬──────────┘
       │                        │
       │  1. loadConfig()       │
       │  2. getDb() (SQLite)   │
       │  3. new ExtensionManager│
       │  4. Bun.serve(:30086)  │
       │                        │
       │  start.ts runs async:  │
       │  killOrphanHosts()     │
       │                        │
       │  For each enabled ext: │
       │  Bun.spawn(bun --hot   │
       │    extensions/<id>/    │
       │    src/index.ts        │
       │    <config-json>)      │
       ├───────────────────────►│
       │                        │
       │  ◄── stdin/stdout ──►  │
       │      NDJSON pipes      │
       │                        │
       │  {"type":"register",   │
       │   "extension":{        │
       │     "id":"voice",      │
       │     "methods":[...],   │
       │     "events":[...]}}   │
       │◄───────────────────────┤
       │                        │
       │  extensions.           │
       │   registerRemote()     │
       │                        │
       │  Repeat for: session,  │
       │  chat, voice, imessage,│
       │  control, codex,       │
       │  hooks, memory         │
       │                        │
       │  /health 200 OK        │
       │                        │
```

### Gateway Init Order (index.ts)

1. **Config** -- `loadConfig()` from `~/.claudia/claudia.json`
2. **Database** -- SQLite via `getDb()` (migrations only, data owned by extensions)
3. **ExtensionManager** -- Empty, extensions registered later
4. **Bun.serve** -- HTTP + WebSocket on single port
5. **start.ts** (async) -- Kill orphans, spawn extension hosts

### Extension Host Spawn (start.ts)

```
For each extension in config where enabled=true:
  1. Resolve entrypoint: extensions/<id>/src/index.ts
  2. Spawn: bun --hot (or bun run if hot:false) extensions/<id>/src/index.ts <config-json>
  3. Wait for "register" message on stdout (10s timeout)
  4. Call extensions.registerRemote(registration, host)
```

Each extension process runs directly with `bun --hot` (native HMR) by default. Extensions with `hot: false` in config use `bun run` instead and can be restarted via `gateway.restart_extension`. The extension imports `runExtensionHost()` from `packages/extension-host` which provides the NDJSON bridge:

- NDJSON stdin/stdout protocol
- Console redirect (console.log -> stderr, stdout reserved for protocol)
- HMR via `bun --hot` (process stays alive, module reloads)
- Parent liveness check (exits if reparented to PID 1)

---

## WebSocket Client Management

### Connection Lifecycle

```
Client                          Gateway
  |                                |
  |  GET /ws (upgrade)             |
  |------------------------------->|
  |                                |  Generate connectionId (UUID)
  |                                |  Store in clients Map
  |  gateway.welcome               |
  |  {connectionId: "conn-abc"}    |
  |<-------------------------------|
  |                                |
  |  subscribe                     |
  |  {events: ["stream.*",         |
  |   "voice.*"]}                  |
  |------------------------------->|  Add to client.subscriptions
  |                                |
  |  ... normal requests ...       |
  |                                |
  |  (tab closed / disconnect)     |
  | ------------ X ----------------|  Remove from clients Map
  |                                |  Clean up voiceStreamOrigins
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
// Client -> Gateway (request)
{ type: "req", id: "req-123", method: "session.send_prompt", params: {...} }

// Gateway -> Client (response)
{ type: "res", id: "req-123", ok: true, payload: {...} }

// Gateway -> Client (event, pushed)
{ type: "event", event: "stream.{sessionId}.content_block_delta", payload: {...} }
```

---

## Method Routing

```
method.split(".") -> [namespace, action]

  gateway.*    -> built-in methods (list_methods, list_extensions, subscribe, unsubscribe)
  *.*          -> ExtensionManager routes to remote host by prefix

Examples:
  session.send_prompt      -> look up "session" in remoteHosts -> session extension
  voice.speak              -> look up "voice" in remoteHosts -> voice extension
  imessage.send            -> look up "imessage" in remoteHosts -> imessage extension
  control.health   -> look up "control" in remoteHosts -> control extension
```

All built-in `gateway.*` methods have Zod schemas. Extension methods have schemas declared by the extension and validated at the gateway boundary -- handlers can assume valid input.

---

## Event Broadcasting: Three Scopes

The gateway has three distinct broadcast mechanisms:

### 1. Client Broadcast (subscription-based)

```typescript
broadcastEvent(eventName, payload);
```

Sends to all connected WebSocket clients whose `subscriptions` match the event pattern. Patterns support:

- `"*"` -- all events
- `"stream.*"` -- prefix wildcard
- `"voice.audio_chunk"` -- exact match

Used for: session stream events (`stream.{sessionId}.*`), general notifications.

### 2. Extension Broadcast (pattern-based)

```typescript
broadcastExtension(gatewayEvent)
  -> extensions.broadcast(event)
    -> For each remote host: host.sendEvent(event)  // stdin NDJSON
```

Sends to all extension hosts via stdio. Extensions subscribe with `ctx.on("session.*", handler)`. The extension host's internal event bus does pattern matching.

**Key detail**: Session events are renamed from `stream.{sessionId}.{type}` to `session.{type}` for extensions -- they don't need to know the sessionId to subscribe.

### 3. Connection-Scoped Broadcast (voice)

```typescript
// In broadcastEvent():
if (eventName.startsWith("voice.") && targetConnectionId !== null) {
  // Send ONLY to the connection that initiated this voice stream
}
```

Voice audio events carry a `streamId`. The gateway tracks `streamId -> connectionId` in `voiceStreamOrigins`. When a `voice.*` event has a known streamId, it's sent only to the originating connection.

---

## Voice Routing: The Multi-Tab Problem

### How Connection Scoping Works

```
voiceStreamOrigins: Map<streamId, connectionId>

1. Client sends prompt with speakResponse=true
2. Session extension stores connectionId in requestContext
3. Voice extension starts stream -> emits voice.stream_start {streamId, sessionId}
4. Gateway's emit callback:
   - Looks up connectionId from the event payload
   - Maps streamId -> connectionId in voiceStreamOrigins
5. Subsequent voice.audio_chunk events -> scoped to that connectionId
6. voice.stream_end -> cleans up voiceStreamOrigins
```

### Design Note: connectionId Is Always Tracked

Every prompt stores the originating `connectionId` in `requestContext`, regardless of the `speakResponse` flag. This ensures voice scoping works correctly even when `autoSpeak` is enabled -- audio routes to the tab that sent the prompt, not all tabs.

---

## Extension Host Communication (stdio NDJSON)

### Protocol

```
Gateway -> Host (stdin):
  {"type":"req","id":"abc","method":"voice.speak","params":{...}}
  {"type":"event","event":"session.content_block_delta","payload":{...}}

Host -> Gateway (stdout):
  {"type":"register","extension":{"id":"voice","methods":[...],"events":[...]}}
  {"type":"res","id":"abc","ok":true,"payload":{...}}
  {"type":"event","event":"voice.audio_chunk","payload":{...}}
  {"type":"error","error":"Fatal: ..."}
```

### Direct Execution with Native HMR

Extensions run directly as `bun --hot extensions/<id>/src/index.ts <config>`. Each extension's entrypoint imports `runExtensionHost()` from `packages/extension-host`, which sets up the NDJSON bridge over stdin/stdout. This means:

- No separate generic shim process -- the extension IS the process
- `bun --hot` provides native HMR (process stays alive, module reloads)
- On HMR reload, the extension re-registers with the gateway (new methods/events)
- stdin listener is NOT re-bound on reload (`import.meta.hot.data.stdinBound` flag)

### HMR Lifecycle

```
                  Gateway                    Extension Process
                     |                            |
                     |  Bun.spawn(bun --hot       |
                     |    extensions/<id>/         |
                     |    src/index.ts <config>)   |
                     |--->                         |
                     |                            |  runExtensionHost()
                     |                            |  factory(config) -> extension
                     |                            |  extension.start(ctx)
                     |  {"type":"register",...}   |
                     |<---------------------------|
                     |                            |
                     |  ... normal operation ...   |
                     |                            |
                     |  (file change detected)     |
                     |                            |  import.meta.hot.dispose()
                     |                            |  -> extension.stop()
                     |                            |  -> eventHandlers.clear()
                     |                            |
                     |                            |  (module re-executes)
                     |                            |  -> loadAndStart()
                     |                            |  -> new extension registered
                     |  {"type":"register",...}   |  -> stdin NOT re-bound
                     |<---------------------------|    (import.meta.hot.data
                     |                            |     .stdinBound = true)
                     |  extensions.registerRemote |
                     |  (overwrites previous)     |
                     |                            |
```

### Auto-Restart on Crash

```
Exit detected -> handleExit()
  if (!killed && restartCount < 5):
    Wait 2s
    spawn() again
  else:
    Log error, give up
```

### Parent Liveness Check

Extension hosts poll `process.ppid` every 2 seconds. If the parent PID changes (gateway died and host got reparented to PID 1/launchd), the host self-terminates. This prevents orphan buildup when `bun --watch` restarts the gateway.

---

## ctx.call() Hub: Inter-Extension RPC

Extensions call each other through the gateway using `ctx.call()`:

```typescript
// Inside voice extension:
const history = await ctx.call("session.get_history", { sessionId });

// Inside imessage extension:
const result = await ctx.call("session.send_prompt", { sessionId, content, source });
```

The gateway acts as the RPC hub. When an extension calls `ctx.call()`:

1. Extension sends `{"type":"req", "method":"session.get_history", ...}` on stdout
2. Gateway receives it, routes to the target extension by prefix lookup
3. Target extension handles the method, returns response
4. Gateway relays response back to the calling extension on stdin

### RPC Metadata

Each `ctx.call()` carries metadata for observability and safety:

- **traceId** -- Propagated across the call chain for distributed tracing
- **depth** -- Incremented at each hop; gateway rejects calls exceeding max depth (prevents infinite loops)
- **deadlineMs** -- Absolute deadline for the entire call chain; gateway rejects calls past deadline

---

## Source Routing (Multi-Source Extensions)

Some extensions handle multiple external "sources" (iMessage conversations, etc.):

```
iMessage: "+15551234" sends text
  -> imessage extension creates prompt with source="imessage/+15551234"
  -> Session extension stores source in requestContext
  -> Claude responds
  -> On message_stop: routeToSource("imessage/+15551234", event)
  -> Gateway looks up prefix "imessage" -> imessage extension host
  -> Calls host.routeToSource(source, event)
  -> iMessage extension sends reply to that phone number
```

Source format: `"prefix/id"` where prefix maps to an extension.

---

## Full Message Flow: Prompt -> Response -> Voice

This traces a complete round trip from web client through to voice output.

```
 Web Client          Gateway             Session Extension        Claude SDK          Voice Extension
    |                   |                      |                    |                    |
    |  req: session.    |                      |                    |                    |
    |  send_prompt      |                      |                    |                    |
    |  {sessionId,      |                      |                    |                    |
    |   content,        |                      |                    |                    |
    |   speakResponse:  |                      |                    |                    |
    |   true}           |                      |                    |                    |
    |------------------>|                      |                    |                    |
    |                   |                      |                    |                    |
    |                   |  route by prefix:    |                    |                    |
    |                   |  "session" ->        |                    |                    |
    |                   |  session ext host    |                    |                    |
    |                   |--------------------->|                    |                    |
    |                   |                      |                    |                    |
    |                   |                      |  SDK query()       |                    |
    |                   |                      |  async generator   |                    |
    |                   |                      |------------------->|                    |
    |                   |                      |                    |                    |
    |                   |                      |  SDKMessage stream |                    |
    |                   |                      |<-------------------|                    |
    |                   |                      |                    |                    |
    |                   |  emit: stream.{id}.  |                    |                    |
    |                   |  content_block_start |                    |                    |
    |                   |<---------------------|                    |                    |
    |                   |                      |                    |                    |
    |                   |  --- DUAL BROADCAST ---|                  |                    |
    |                   |  |                     |                  |                    |
    |  event: stream.   |  |  1. To WS clients   |                  |                    |
    |  {id}.content_    |  |  (subscription       |                  |                    |
    |  block_start      |  |   matching)          |                  |                    |
    |<------------------|  |                      |                  |                    |
    |                   |  |  2. To extensions     |                  |                    |
    |                   |  |  (renamed to          |                  |                    |
    |                   |  |   session.{type})     |                  |                    |
    |                   |  |  + speakResponse flag |                  |                    |
    |                   |  |----------------------|----------------->|                    |
    |                   |                      |                    |                    |
    |                   |                      |                    |  Voice sees        |
    |                   |                      |                    |  speakResponse=true|
    |                   |                      |                    |  -> startStream()  |
    |                   |                      |                    |                    |
    |                   |  voice.stream_start   |                    |                    |
    |                   |  {streamId:"s-xyz",   |                    |                    |
    |                   |   sessionId:"..."}    |                    |                    |
    |                   |<--------------------------------------------------------------|
    |                   |                      |                    |                    |
    |                   |  voiceStreamOrigins   |                    |                    |
    |                   |  .set("s-xyz",        |                    |                    |
    |                   |       "conn-abc")     |                    |                    |
    |                   |                      |                    |                    |
    |                   |  ... text deltas flow, voice buffers sentences ...             |
    |                   |                      |                    |                    |
    |                   |  voice.audio_chunk    |                    |                    |
    |                   |  {streamId:"s-xyz",   |                    |                    |
    |                   |   audio:"base64..."}  |                    |                    |
    |                   |<--------------------------------------------------------------|
    |                   |                      |                    |                    |
    |                   |  CONNECTION-SCOPED:   |                    |                    |
    |                   |  streamId -> "s-xyz"  |                    |                    |
    |                   |  voiceStreamOrigins   |                    |                    |
    |                   |  -> "conn-abc"        |                    |                    |
    |                   |  ONLY send to         |                    |                    |
    |  voice.audio_     |  conn-abc             |                    |                    |
    |  chunk            |                      |                    |                    |
    |<------------------|                      |                    |                    |
    |                   |                      |                    |                    |
    |  (Other tabs      |                      |                    |                    |
    |   do NOT receive  |                      |                    |                    |
    |   this event)     |                      |                    |                    |
    |                   |                      |                    |                    |
```

---

## Key Data Structures

### voiceStreamOrigins (gateway index.ts)

```typescript
Map<string, string>; // streamId -> connectionId
```

Set when `voice.stream_start` is emitted. Used to scope `voice.*` events to the originating connection. Cleaned up on `voice.stream_end` and client disconnect.

### ExtensionManager Maps

```typescript
remoteHosts: Map<string, ExtensionHostProcess>; // id -> host process
remoteRegistrations: Map<string, ExtensionRegistration>; // id -> method/event metadata
sourceRoutes: Map<string, string>; // prefix -> extensionId
remoteSourceRoutes: Map<string, ExtensionHostProcess>; // prefix -> host process
```
