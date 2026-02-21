# Extension Guide

How to build, configure, and run Claudia extensions.

## Overview

Extensions are the primary way to add features to Claudia. Every capability — web chat, voice, iMessage, Mission Control — is an extension. Extensions register schema-driven methods, subscribe to the event bus, and optionally serve web pages.

Extensions are **directly executable** — each extension is its own entry point that the gateway spawns as a child process. This means native HMR via `bun --hot`, no indirection, and zero-downtime code reloads without dropping WebSocket connections.

Server entrypoint convention is strict: every extension must expose `extensions/<id>/src/index.ts`. Do not use alternate server entrypoint filenames.

## Quick Start

### 1. Create the extension package

```
extensions/my-feature/
├── package.json
└── src/
    └── index.ts
```

```json
{
  "name": "@claudia/ext-my-feature",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": "./src/index.ts"
  },
  "dependencies": {
    "@claudia/extension-host": "workspace:*",
    "@claudia/shared": "workspace:*",
    "zod": "^3.25.76"
  }
}
```

The `@claudia/extension-host` dependency provides `runExtensionHost()` — the function that wires your extension into the NDJSON stdio protocol. Every extension needs it.

### 2. Implement the extension

```typescript
import { z } from "zod";
import type { ClaudiaExtension, ExtensionContext, HealthCheckResponse } from "@claudia/shared";

export function createMyFeatureExtension(config: MyFeatureConfig = {}): ClaudiaExtension {
  let ctx: ExtensionContext;

  return {
    id: "my-feature",
    name: "My Feature",
    methods: [
      {
        name: "my-feature.do_thing",
        description: "Does the thing",
        inputSchema: z.object({
          input: z.string().min(1),
        }),
      },
      {
        name: "my-feature.health_check",
        description: "Health status for Mission Control",
        inputSchema: z.object({}),
      },
    ],
    events: ["my-feature.thing_done"],

    async start(context) {
      ctx = context;
      ctx.log.info("My Feature started");

      // Subscribe to gateway events
      ctx.on("session.message_stop", async (event) => {
        // React to session completion
      });
    },

    async stop() {
      // Cleanup resources
    },

    async handleMethod(method, params) {
      switch (method) {
        case "my-feature.do_thing": {
          const result = doTheThing(params.input as string);
          ctx.emit("my-feature.thing_done", { result });
          return { status: "ok", result };
        }
        case "my-feature.health_check": {
          const response: HealthCheckResponse = {
            ok: true,
            status: "healthy",
            label: "My Feature",
            metrics: [{ label: "Status", value: "running" }],
          };
          return response;
        }
        default:
          throw new Error(`Unknown method: ${method}`);
      }
    },

    health() {
      return { ok: true };
    },
  };
}

export default createMyFeatureExtension;

// ── Direct execution with HMR ────────────────────────────────
import { runExtensionHost } from "@claudia/extension-host";
if (import.meta.main) runExtensionHost(createMyFeatureExtension);
```

The last two lines are critical. `runExtensionHost()` handles the entire stdio protocol — console redirection, NDJSON I/O, event bus, `ctx.call()`, parent liveness detection, and HMR lifecycle. The `import.meta.main` guard ensures it only runs when the file is executed directly (not when imported for testing).

### 3. Configure in claudia.json

```json5
// ~/.claudia/claudia.json
{
  extensions: {
    "my-feature": {
      enabled: true,
      config: {
        // Extension-specific config
      },
    },
  },
}
```

Your extension ID in config must match the folder name under `extensions/`.

### 4. Verify

```bash
# Check it loaded
bun run packages/cli/src/index.ts method.list | grep my-feature

# Call a method
bun run packages/cli/src/index.ts my-feature.do_thing --input "hello"

# Health check
bun run packages/cli/src/index.ts my-feature.health_check
```

---

## Extension Interface

All extensions implement `ClaudiaExtension` from `@claudia/shared`:

```typescript
interface ClaudiaExtension {
  id: string; // Unique ID: "voice", "imessage"
  name: string; // Display name: "Voice (TTS)"
  methods: ExtensionMethodDefinition[];
  events: string[]; // Events this extension emits
  sourceRoutes?: string[]; // Source prefixes for routing (e.g., ["imessage"])

  start(ctx: ExtensionContext): Promise<void>;
  stop(): Promise<void>;
  handleMethod(method: string, params: Record<string, unknown>): Promise<unknown>;
  handleSourceResponse?(source: string, event: GatewayEvent): Promise<void>;
  health(): { ok: boolean; details?: Record<string, unknown> };
}
```

### Factory Function

Extensions export a factory function named `createXxxExtension` and wire it into `runExtensionHost()`:

```typescript
export function createVoiceExtension(config: VoiceConfig = {}): ClaudiaExtension { ... }
export default createVoiceExtension;

// Direct execution — gateway spawns this file directly
import { runExtensionHost } from "@claudia/extension-host";
if (import.meta.main) runExtensionHost(createVoiceExtension);
```

The factory is passed directly to `runExtensionHost()` — no dynamic import, no discovery, no reflection. Always provide both named and default exports (named for testing imports, default as convention).

### ExtensionContext

The context object passed to `start()` is the extension's bridge to the gateway:

```typescript
interface ExtensionContext {
  /** Subscribe to gateway events */
  on(pattern: string, handler: (event: GatewayEvent) => void | Promise<void>): () => void;
  /** Emit an event to the gateway */
  emit(type: string, payload: unknown, options?: { source?: string }): void;
  /** Call another extension's method through the gateway hub */
  call(method: string, params?: Record<string, unknown>): Promise<unknown>;
  /** The originating WebSocket connection ID (set per-request by gateway envelope) */
  connectionId: string | null;
  /** Extension configuration */
  config: Record<string, unknown>;
  /** Logger — writes to console + file at ~/.claudia/logs/{extensionId}.log */
  log: {
    info(msg: string, meta?: unknown): void;
    warn(msg: string, meta?: unknown): void;
    error(msg: string, meta?: unknown): void;
  };
}
```

### ctx.call() — Cross-Extension Calls

Extensions can call methods on other extensions through the gateway hub:

```typescript
async start(ctx) {
  // Call the session extension to send a prompt
  const result = await ctx.call("session.send_prompt", {
    sessionId: "abc",
    content: "Hello from my extension",
  });

  // Call voice extension to speak
  await ctx.call("voice.speak", { text: "Processing complete" });
}
```

Calls route through the gateway's `ExtensionManager.handleMethod()`, so they go through the same schema validation and routing as client requests. The gateway enforces safety guardrails:

- **Max depth: 8** — prevents infinite call cycles (A calls B calls A...)
- **Deadline propagation** — the original request's deadline carries through the chain
- **Per-extension in-flight cap: 50** — prevents a runaway extension from flooding the hub
- **Trace ID** — all calls in a chain share a trace ID for debugging

The `connectionId` from the originating request is automatically propagated, so downstream extensions know which client triggered the chain.

### Methods (Schema-Driven)

Every method declares a Zod input schema. The gateway validates at the boundary — handlers can assume valid input:

```typescript
{
  name: "voice.speak",           // Format: {extensionId}.{method}
  description: "Synthesize text to speech",
  inputSchema: z.object({
    text: z.string().min(1),
    voice: z.string().optional(),
  }),
}
```

Methods are discoverable via `method.list` and auto-generate CLI help.

Naming rule: Multi-word method segments must use snake_case (for example `workspace.get_or_create`, `session.tool_result`).

### Events

Extensions emit events via `ctx.emit()` and subscribe via `ctx.on()`:

```typescript
// Emit to the gateway event bus (reaches all clients + extensions)
ctx.emit("voice.audio_chunk", { audio: base64, streamId });

// Subscribe to events (supports wildcards)
ctx.on("session.content_block_delta", handler); // Exact match
ctx.on("session.*", handler); // Prefix wildcard
ctx.on("*", handler); // All events
```

The `on()` call returns an unsubscribe function. Call it in `stop()`:

```typescript
const unsubs: (() => void)[] = [];

async start(ctx) {
  unsubs.push(ctx.on("session.*", handler));
},

async stop() {
  unsubs.forEach(fn => fn());
}
```

### Health Check

Every extension should expose a `{id}.health_check` method returning `HealthCheckResponse`. Mission Control discovers and renders these generically:

```typescript
interface HealthCheckResponse {
  ok: boolean;
  status: "healthy" | "degraded" | "disconnected" | "error";
  label: string; // Card title
  metrics?: { label: string; value: string | number }[];
  actions?: HealthAction[]; // Buttons (kill, restart, etc.)
  items?: HealthItem[]; // Per-resource rows (sessions, connections)
}
```

### Source Routing

For extensions bridging external systems (iMessage, Slack, etc.), source routing enables round-trip responses:

1. Set `sourceRoutes: ["imessage"]` on the extension
2. Implement `handleSourceResponse(source, event)`
3. When an external message arrives, emit a `prompt_request` event with `source: "imessage/chatId"`
4. The gateway routes the response back via `handleSourceResponse`

```
External message -> extension -> prompt_request event
  -> session.prompt(content, source="imessage/2329")
  -> Claude responds -> message_stop
  -> routeToSource("imessage/2329", response)
  -> extension.handleSourceResponse() -> sends reply
```

---

## Configuration

### claudia.json

Extension config lives in `~/.claudia/claudia.json` (JSON5 format):

```json5
{
  extensions: {
    voice: {
      enabled: true,
      sourceRoutes: ["imessage"], // Optional: override source routes
      config: {
        apiKey: "${CARTESIA_API_KEY}", // Env var interpolation
        voiceId: "${CARTESIA_VOICE_ID}",
        model: "sonic-3",
        autoSpeak: true,
        streaming: true,
        emotions: ["positivity:high", "curiosity"],
        speed: 1.0,
      },
    },
  },
}
```

### Config Flow

```
~/.claudia/claudia.json
  -> loadConfig() interpolates ${ENV_VARS} from process.env / .env
  -> gateway start.ts enumerates enabled extension IDs
  -> resolves extensions/<id>/src/index.ts
  -> spawns: bun --hot extensions/<id>/src/index.ts <config-json>
  -> extension calls runExtensionHost(factory) -> factory(config)
  -> host sends register message with metadata (methods, events, sourceRoutes)
  -> gateway registers the remote extension
```

**Important**: Don't read `process.env` in your extension defaults. The config object passed to your factory already has interpolated values. Reading `process.env` directly breaks out-of-process mode because the child process may not have the same environment.

```typescript
// BAD — breaks in extension host
const DEFAULT_CONFIG = {
  apiKey: process.env.MY_API_KEY || "", // Empty in child process!
};

// GOOD — config comes from the factory parameter
export function createMyExtension(config: MyConfig = {}): ClaudiaExtension {
  const cfg = { ...DEFAULTS, ...config }; // Config has interpolated values
}
```

### Environment Variables

Put secrets in a `.env` file at the project root (gitignored). Bun auto-loads it:

```bash
# .env
CARTESIA_API_KEY=sk-...
CARTESIA_VOICE_ID=931fb722-...
```

Reference them in `claudia.json` via `${VAR_NAME}` syntax.

---

## Out-of-Process Extensions

### Why

When developing, `bun --watch` restarts the gateway on any code change. If voice extension code changes, the gateway restarts, killing all WebSocket connections. Out-of-process extensions run in separate child processes — gateway stays alive, connections survive.

### How It Works

```
Gateway (port 30086)
  |-- Child: bun --hot extensions/voice/src/index.ts <config-json>
  |-- Child: bun --hot extensions/imessage/src/index.ts <config-json>
  |-- Child: bun --hot extensions/chat/src/index.ts <config-json>
  `-- (one process per enabled extension)
        `-- stdin/stdout NDJSON <-> gateway
```

Each extension is directly executable. The gateway:

1. Reads enabled extensions from config
2. Resolves each entrypoint as `extensions/<id>/src/index.ts`
3. Spawns `bun --hot extensions/<id>/src/index.ts <config-json>`
4. The extension's `runExtensionHost(factory)` call boots the NDJSON protocol, creates the extension via `factory(config)`, and calls `extension.start(ctx)`
5. The host sends a `register` message with extension metadata (methods, events, sourceRoutes)
6. Gateway registers the remote extension — methods, events, and source routing work transparently

There is no generic host shim or dynamic import layer. The extension IS the process entry point. `runExtensionHost()` (from `@claudia/extension-host`) handles the stdio protocol, console redirection, event bus bridging, parent liveness detection, and HMR lifecycle.

### NDJSON Protocol

Communication happens over stdin/stdout with newline-delimited JSON:

```
Gateway -> Host (method call)
{"type":"req","id":"abc","method":"voice.speak","params":{"text":"hello"}}

Host -> Gateway (response)
{"type":"res","id":"abc","ok":true,"payload":{"status":"ok"}}

Gateway -> Host (event forwarding)
{"type":"event","event":"session.content_block_delta","payload":{...}}

Host -> Gateway (event from extension)
{"type":"event","event":"voice.audio_chunk","payload":{...}}

Host -> Gateway (cross-extension call via ctx.call)
{"type":"call","id":"def","method":"session.send_prompt","params":{...},"depth":1,"traceId":"..."}

Gateway -> Host (call response)
{"type":"call_res","id":"def","ok":true,"payload":{...}}

Host -> Gateway (registration on startup)
{"type":"register","extension":{"id":"voice","name":"Voice (TTS)","methods":[...],"events":[...],"sourceRoutes":[]}}
```

### Hot Module Reload

Since the extension IS the entry point, `bun --hot` covers all code changes natively. No file watchers, no cache busting, no indirection. Edit, save, it reloads.

When extension code changes:

1. Bun detects the file change
2. `import.meta.hot.dispose()` calls `extension.stop()` on the old instance
3. The module re-executes — `runExtensionHost()` re-creates the extension via the factory
4. Stdio connection to gateway is unbroken (the process stays alive)
5. New `register` message sent with updated metadata
6. Gateway re-registers the extension (old registration is cleaned up automatically)

The `runExtensionHost()` implementation tracks stdin binding across HMR cycles via `import.meta.hot.data` to avoid duplicate listeners.

### Auto-Restart

If the extension process crashes, the gateway automatically restarts it (up to 5 times with 2-second delays). Pending method calls are rejected with an error.

### Orphan Detection

On startup, the gateway kills orphaned extension host processes from previous instances. When `bun --watch` restarts the gateway via SIGKILL, cleanup handlers don't run, so child processes can be orphaned. The gateway uses `pgrep -f "extensions/.*/src/index.ts"` to find and terminate them.

Extension hosts also self-monitor: they poll `process.ppid` every 2 seconds and exit if the parent PID changes (indicating they were reparented to PID 1/launchd).

### Out-of-Process Readiness Checklist

Before enabling an extension, verify all of these:

1. Entry point exists at `extensions/<id>/src/index.ts` with the `runExtensionHost()` call at the bottom.
2. `package.json` includes `"@claudia/extension-host": "workspace:*"` in dependencies.
3. Runtime config comes from the factory `config` argument (or `ctx.config`), not module-level `loadConfig()`/`process.env` reads.
4. `start()`/`stop()` fully clean up timers, sockets, subprocesses, and event subscriptions so HMR does not leak state.
5. Keep server logic and route/page logic split: server code runs out-of-process while React routes still load in the gateway web shell.

### Console Output

In the extension host, **stdout is reserved for NDJSON**. `runExtensionHost()` redirects `console.log/warn/error` to stderr automatically. The shared logger writes to both console and file, so this happens transparently. Extension authors don't need to worry about it.

---

## WebSocket Client Protocol

Any client connecting to the gateway WebSocket (`ws://localhost:30086/ws`) must implement the ping/pong protocol to stay alive. This applies to browser UIs, Chrome extensions, native apps — anything with a WebSocket connection.

### Ping/Pong (Required)

The gateway sends ping messages every 30 seconds. Clients that miss 2 consecutive pings (60s without a pong) are pruned — their connection is closed and a `client.disconnected` event is broadcast to all extensions.

```typescript
// Gateway -> Client (every 30s)
{ "type": "ping", "id": "uuid", "timestamp": 1234567890 }

// Client -> Gateway (must respond)
{ "type": "pong", "id": "uuid" }
```

Implementation is simple — intercept pings before your normal message handler:

```typescript
ws.onmessage = (event) => {
  const data = JSON.parse(event.data);

  if (data.type === "ping") {
    ws.send(JSON.stringify({ type: "pong", id: data.id }));
    return;
  }

  // ... handle other messages
};
```

### Connection ID

Every WebSocket connection is assigned a unique `connectionId` by the gateway (sent in the `gateway.welcome` event on connect). This ID is stamped on the request and event envelopes as they flow through the system, so extensions can identify which connection originated a request or event.

```typescript
// Sent on connect
{ "type": "event", "event": "gateway.welcome", "payload": { "connectionId": "abc-123" } }

// Requests carry connectionId through the pipeline
{ "type": "req", "id": "...", "method": "dominatrix.register", "params": {...}, "connectionId": "abc-123" }

// Events also carry connectionId
{ "type": "event", "event": "client.disconnected", "payload": {}, "connectionId": "abc-123" }
```

Extensions receive `connectionId` via `params._connectionId` for method calls and `event.connectionId` for events. This enables connection-scoped routing (e.g., voice audio only goes to the tab that requested it).

### Exclusive Subscriptions

Standard subscriptions broadcast events to all matching clients. Exclusive subscriptions ensure only the **last subscriber** receives matching events — previous exclusive subscribers are silently replaced.

```typescript
// Standard — all subscribers get the event
{ "type": "req", "method": "subscribe", "params": { "events": ["session.*"] } }

// Exclusive — last subscriber wins
{ "type": "req", "method": "subscribe", "params": { "events": ["dominatrix.command"], "exclusive": true } }
```

Use case: multiple Chrome profiles each have a DOMINATRIX extension subscribed to `dominatrix.command`. With exclusive subscriptions, only the last-focused profile handles commands. Clicking a different Chrome window re-subscribes that profile as the exclusive handler.

### Client Disconnect Events

When a WebSocket connection closes (or is pruned by ping timeout), the gateway broadcasts a `client.disconnected` event to all extensions:

```typescript
{ "type": "event", "event": "client.disconnected", "payload": {}, "connectionId": "abc-123" }
```

Extensions that track connected clients (like DOMINATRIX tracking Chrome extension instances) use this to clean up stale entries automatically.

---

## Web Pages (Client-Side Routes)

Extensions can serve web pages via the gateway's SPA.

### Add routes.ts

```typescript
// extensions/my-feature/src/routes.ts
import type { Route } from "@claudia/ui";
import { MyPage } from "./pages/MyPage";

export const myFeatureRoutes: Route[] = [
  { path: "/my-feature", component: MyPage, label: "My Feature" },
];
```

### Export from package.json

```json
{
  "exports": {
    ".": "./src/index.ts",
    "./routes": "./src/routes.ts"
  },
  "dependencies": {
    "@claudia/extension-host": "workspace:*",
    "@claudia/shared": "workspace:*",
    "@claudia/ui": "workspace:*",
    "zod": "^3.25.76"
  }
}
```

### Register in the web shell

Add to `packages/gateway/src/web/index.tsx`:

```typescript
import { myFeatureRoutes } from "@claudia/ext-my-feature/routes";

const allRoutes = [...controlRoutes, ...chatRoutes, ...myFeatureRoutes];
```

### Convention

- Chat owns `/` (workspaces, sessions)
- Other extensions use `/{extension-name}` paths
- Pages are React components using `@claudia/ui` hooks (`useGateway`, `useRouter`)

---

## Existing Extensions

| Extension       | ID           | Package                   | Web Pages                             | Source Routes |
| --------------- | ------------ | ------------------------- | ------------------------------------- | ------------- |
| Chat            | `chat`       | `@claudia/ext-chat`       | `/`, `/workspace/:id`, `/session/:id` | --            |
| Voice           | `voice`      | `@claudia/voice`          | --                                    | --            |
| iMessage        | `imessage`   | `@claudia/ext-imessage`   | --                                    | `imessage`    |
| Mission Control | `control`    | `@claudia/ext-control`    | `/control`, `/logs`                   | --            |
| Hooks           | `hooks`      | `@claudia/ext-hooks`      | --                                    | --            |
| DOMINATRIX      | `dominatrix` | `@claudia/ext-dominatrix` | --                                    | --            |

All extensions run out-of-process. There is no in-process mode.

---

## Hooks

Hooks are lightweight event-driven scripts that run inside the **hooks extension**. Instead of building a full extension for simple reactive features, drop a `.ts` file into a hooks directory and it will be loaded automatically.

### How It Works

The hooks extension (`extensions/hooks/`) loads hooks from:

1. `~/.claudia/hooks/` — user-level hooks (apply to all workspaces)
2. `<workspace>/.claudia/hooks/` — workspace-level hooks for the active workspace

If multiple hook files share the same filename (same hook ID), workspace hooks override user hooks.

Each `.ts` or `.js` file must default-export a `HookDefinition`:

```typescript
import type { HookDefinition } from "@claudia/shared";

export default {
  event: "session.message_stop", // or an array: ["session.message_stop", "session.history_loaded"]
  description: "What this hook does",

  async handler(ctx, payload) {
    // ctx: HookContext with emit(), workspace, sessionId, log
    // payload: optional event payload from the gateway
  },
} satisfies HookDefinition;
```

### HookContext

Every handler receives a `HookContext`:

```typescript
interface HookContext {
  /** Emit an event (namespaced as hook.{hookId}.{eventName}) */
  emit(event: string, payload: unknown): void;
  /** Current workspace info */
  workspace: { cwd: string } | null;
  /** Current session ID */
  sessionId: string | null;
  /** Logger */
  log: {
    info(msg: string, meta?: unknown): void;
    warn(msg: string, meta?: unknown): void;
    error(msg: string, meta?: unknown): void;
  };
}
```

When a hook calls `ctx.emit("files", data)`, the gateway broadcasts `hook.{hookId}.files` to all subscribed WebSocket clients. The hook ID is derived from the filename (e.g., `git-status.ts` -> `git-status`).

### Available Events

Hooks can subscribe to any gateway event. Common ones:

| Event                         | When it fires                                           |
| ----------------------------- | ------------------------------------------------------- |
| `session.message_stop`        | After Claude finishes a response                        |
| `session.message_start`       | When Claude starts responding                           |
| `session.content_block_delta` | Each streaming text chunk                               |
| `session.history_loaded`      | When a client loads session history (page load/refresh) |
| `session.*`                   | Wildcard for all session events                         |

Pattern matching is first-match per hook. Exact patterns are evaluated before wildcard patterns, and `*` is evaluated last. A hook runs at most once per incoming event even if multiple patterns match.

### UI Integration -- Status Bar

Hook output is rendered in the **StatusBar** component, a compact bar between the chat messages and input area. The UI subscribes to `hook.*` events and stores the latest payload per hook ID in `hookState`.

The StatusBar currently renders:

- **Git branch** — icon + branch name (always visible when hook data exists)
- **Change badges** — `+N` (green), `~N` (amber), `-N` (red), `!N` (purple)
- **Expandable file list** — click badges to see individual changed files

To add a new hook with UI rendering, emit data via `ctx.emit()` and add a corresponding renderer in `StatusBar.tsx`.

### Example: git-status Hook

```typescript
// .claudia/hooks/git-status.ts
import type { HookDefinition } from "@claudia/shared";

interface GitStatusPayload {
  branch: string;
  modified: number;
  added: number;
  deleted: number;
  untracked: number;
  total: number;
  files: { status: string; path: string }[];
}

export default {
  event: ["session.message_stop", "session.history_loaded"],
  description: "Show git file changes after each turn",

  async handler(ctx) {
    const cwd = ctx.workspace?.cwd;
    if (!cwd) return;

    // Run git commands and parse porcelain output...
    const payload: GitStatusPayload = {
      branch: "main",
      modified: 0,
      added: 0,
      deleted: 0,
      untracked: 0,
      total: 0,
      files: [],
    };

    ctx.emit("files", payload);
  },
} satisfies HookDefinition;
```

If the workspace CWD is not a git repository, the hook exits early and emits nothing.

Hook handler signature is `handler(ctx, payload?)`: `ctx` is required and `payload` is optional.

### Configuration

Enable the hooks extension in `~/.claudia/claudia.json`:

```json5
{
  extensions: {
    hooks: {
      enabled: true,
      config: {
        // Optional: additional directories to scan
        // extraDirs: ["/path/to/more/hooks"]
      },
    },
  },
}
```

### Hook Ideas

- **Cost tracker** — accumulate API usage from `session.message_stop` payloads, display running total
- **Build status** — run `tsc --noEmit` after changes, show pass/fail
- **Test runner** — run relevant tests after file changes
- **Session timer** — track time spent per session

---

## File Structure

```
extensions/<name>/
├── package.json           # Exports: . -> ./src/index.ts, ./routes (if has UI)
└── src/
    ├── index.ts           # Factory + implementation + runExtensionHost() call
    ├── routes.ts          # Route declarations (if has UI)
    └── pages/             # React page components (if has UI)
        └── MyPage.tsx

.claudia/
└── hooks/                   # Workspace-level hook scripts (loaded by hooks extension)
    ├── git-status.ts        # Git status after each turn
    └── ...

packages/
├── shared/src/types.ts              # ClaudiaExtension, ExtensionContext, HookDefinition, etc.
├── shared/src/config.ts             # Config loading + env interpolation
├── gateway/src/start.ts             # Config-driven extension startup (spawns extensions directly)
├── gateway/src/extensions.ts        # ExtensionManager (routing, events, lifecycle)
├── gateway/src/extension-host.ts    # ExtensionHostProcess (child process management)
├── gateway/src/web/index.tsx        # SPA shell (route collection)
├── ui/src/components/StatusBar.tsx  # Hook output rendering (git badges, etc.)
└── extension-host/src/index.ts      # runExtensionHost() — NDJSON stdio protocol + HMR lifecycle
```

---

## Testing

Extensions can be tested in isolation. See `extensions/control/src/index.test.ts` for an example:

```typescript
import { describe, expect, test } from "bun:test";
import { createMyFeatureExtension } from "./index";

describe("my-feature", () => {
  test("handles do-thing method", async () => {
    const ext = createMyFeatureExtension({
      /* config */
    });
    await ext.start(mockContext);

    const result = await ext.handleMethod("my-feature.do_thing", { input: "hello" });
    expect(result).toEqual({ status: "ok", result: "..." });
  });
});
```

Use the CLI for integration testing against a running gateway:

```bash
bun run packages/cli/src/index.ts my-feature.health_check
bun run packages/cli/src/index.ts my-feature.do_thing --input "test"
```
