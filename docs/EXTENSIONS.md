# Extension Guide

How to build, configure, and run Claudia extensions.

## Overview

Extensions are the primary way to add features to Claudia. Every capability — web chat, voice, iMessage, Mission Control — is an extension. Extensions register schema-driven methods, subscribe to the event bus, and optionally serve web pages.

Extensions run **out-of-process** as isolated child processes. This survives extension code changes without restarting the gateway or dropping WebSocket connections.

Server entrypoint convention is strict: every extension must expose `extensions/<id>/src/index.ts`. Do not use alternate server entrypoint filenames.

## Quick Start

### 1. Create the extension package

extensions/my-feature/
├── package.json
└── src/
└── index.ts

````

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
    "@claudia/shared": "workspace:*",
    "zod": "^3.25.76"
  }
}
````

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
        name: "my-feature.do-thing",
        description: "Does the thing",
        inputSchema: z.object({
          input: z.string().min(1),
        }),
      },
      {
        name: "my-feature.health-check",
        description: "Health status for Mission Control",
        inputSchema: z.object({}),
      },
    ],
    events: ["my-feature.thing-done"],

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
        case "my-feature.do-thing": {
          const result = doTheThing(params.input as string);
          ctx.emit("my-feature.thing-done", { result });
          return { status: "ok", result };
        }
        case "my-feature.health-check": {
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
```

### 3. Add Extension Files

Gateway now resolves extensions dynamically from config keys using this convention:

- `extensions/<extension-id>/src/index.ts` (server entrypoint, required)
- `extensions/<extension-id>/src/routes.ts` (optional, UI routes)

Your extension ID in config must match the folder name.

Server entrypoint must always be `src/index.ts`.

### 4. Configure in claudia.json

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

### 5. Verify

```bash
# Check it loaded
bun run packages/cli/src/index.ts method.list | grep my-feature

# Call a method
bun run packages/cli/src/index.ts my-feature.do-thing --input "hello"

# Health check
bun run packages/cli/src/index.ts my-feature.health-check
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

Extensions define the server entrypoint in `src/index.ts` and export a factory function named `createXxxExtension`:

```typescript
export function createVoiceExtension(config: VoiceConfig = {}): ClaudiaExtension { ... }
export default createVoiceExtension;
```

The extension host auto-discovers factories by looking for exports matching `createXxxExtension` or a default export. Always provide both named and default exports.

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

Naming rule: Multi-word method segments must use kebab-case (for example `workspace.get-or-create`, `session.tool-result`).

Validation note: for out-of-process extensions, remote methods are currently invoked by name through the host process. Keep your `handleMethod` defensive and validate critical params inside the extension until host-side schema validation is added.

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

Every extension should expose a `{id}.health-check` method returning `HealthCheckResponse`. Mission Control discovers and renders these generically:

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
External message → extension → prompt_request event
  → session.prompt(content, source="imessage/2329")
  → Claude responds → message_stop
  → routeToSource("imessage/2329", response)
  → extension.handleSourceResponse() → sends reply
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
      // outOfProcess is optional; extensions run out-of-process by default.
      // If set to false, gateway logs a warning and still runs it out-of-process.
      outOfProcess: true,
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
  → loadConfig() interpolates ${ENV_VARS} from process.env / .env
  → gateway start.ts enumerates enabled extension IDs
  → resolves extensions/<id>/src/index.ts
  → Out-of-process: JSON.stringify(config) → extension host → factory(config)
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

## Out-of-Process Extensions (Extension Host)

### Why

When developing, `bun --watch` restarts the gateway on any code change. If voice extension code changes, the gateway restarts, killing all WebSocket connections. Out-of-process extensions run in separate child processes — gateway stays alive, connections survive.

### How It Works

```
Gateway (port 30086)
  ├── Child: bun --hot extension-host/src/index.ts <file:///.../extensions/<id>/src/index.ts> <config>
  ├── Child: bun --hot extension-host/src/index.ts <file:///.../extensions/<id>/src/index.ts> <config>
  └── (one host process per enabled extension)
        └── stdin/stdout NDJSON ←→ gateway
```

1. Gateway reads enabled extensions from config
2. Resolves each entrypoint as `extensions/<id>/src/index.ts`
3. Spawns `bun --hot packages/extension-host/src/index.ts <file-url> <config-json>`
4. Host dynamically imports the entrypoint, finds the factory, calls `factory(config)`
5. Host sends a `register` message with extension metadata (methods, events, sourceRoutes)
6. Gateway registers the remote extension — methods, events, and source routing work transparently

### NDJSON Protocol

Communication happens over stdin/stdout with newline-delimited JSON:

```
Gateway → Host (method call)
{"type":"req","id":"abc","method":"voice.speak","params":{"text":"hello"}}

Host → Gateway (response)
{"type":"res","id":"abc","ok":true,"payload":{"status":"ok"}}

Gateway → Host (event forwarding)
{"type":"event","event":"session.content_block_delta","payload":{...}}

Host → Gateway (event from extension)
{"type":"event","event":"voice.audio_chunk","payload":{...}}

Host → Gateway (registration on startup)
{"type":"register","extension":{"id":"voice","name":"Voice (TTS)","methods":[...],"events":[...],"sourceRoutes":[]}}
```

### Hot Module Reload

`bun --hot` does in-process module replacement — the process stays alive, so stdio pipes survive. When extension code changes:

1. Bun detects the file change
2. `import.meta.hot.dispose()` calls `extension.stop()` on the old instance
3. The module re-imports and re-creates the extension
4. Stdio connection to gateway is unbroken
5. New `register` message sent with updated metadata

### Auto-Restart

If the extension host crashes, the gateway automatically restarts it (up to 5 times with 2-second delays). Pending method calls are rejected with an error.

### Out-of-Process Readiness Checklist

Before enabling an extension, verify all of these:

1. Entry point exists at `extensions/<id>/src/index.ts` (required by gateway loader).
2. Runtime config comes from the factory `config` argument (or `ctx.config`), not module-level `loadConfig()`/`process.env` reads.
3. `start()`/`stop()` fully clean up timers, sockets, subprocesses, and event subscriptions so HMR does not leak state.
4. Keep server logic and route/page logic split: server code runs out-of-process while React routes still load in the gateway web shell.

### Enabling

Extensions are config-driven. Add them under `extensions` in your active config (`~/.claudia/claudia.json` or `CLAUDIA_CONFIG`).

If `enabled: true` and `extensions/<id>/src/index.ts` exists, gateway spawns that extension in its own host process. `outOfProcess` defaults to true behavior; `false` is ignored with a warning.

### Console Output

In the extension host, **stdout is reserved for NDJSON**. The host redirects `console.log/warn/error` to stderr. The shared logger writes to both console and file, so this happens automatically. Extension authors don't need to worry about it.

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

const allRoutes = [...missionControlRoutes, ...chatRoutes, ...myFeatureRoutes];
```

### Convention

- Chat owns `/` (workspaces, sessions)
- Other extensions use `/{extension-name}` paths
- Pages are React components using `@claudia/ui` hooks (`useGateway`, `useRouter`)

---

## Existing Extensions

| Extension       | ID                | Package                        | Out-of-Process | Web Pages                             | Source Routes |
| --------------- | ----------------- | ------------------------------ | -------------- | ------------------------------------- | ------------- |
| Chat            | `chat`            | `@claudia/ext-chat`            | Yes            | `/`, `/workspace/:id`, `/session/:id` | —             |
| Voice           | `voice`           | `@claudia/voice`               | Yes            | —                                     | —             |
| iMessage        | `imessage`        | `@claudia/ext-imessage`        | Yes            | —                                     | `imessage`    |
| Mission Control | `mission-control` | `@claudia/ext-mission-control` | Yes            | `/mission-control`, `/logs`           | —             |
| Hooks           | `hooks`           | `@claudia/ext-hooks`           | Yes            | —                                     | —             |

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

When a hook calls `ctx.emit("files", data)`, the gateway broadcasts `hook.{hookId}.files` to all subscribed WebSocket clients. The hook ID is derived from the filename (e.g., `git-status.ts` → `git-status`).

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

### UI Integration — Status Bar

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
    ├── index.ts           # Factory function + implementation
    ├── routes.ts          # Route declarations (if has UI)
    └── pages/             # React page components (if has UI)
        └── MyPage.tsx

.claudia/
└── hooks/                   # Workspace-level hook scripts (loaded by hooks extension)
    ├── git-status.ts        # Git status after each turn
    └── ...

packages/
├── shared/src/types.ts          # ClaudiaExtension, ExtensionContext, HookDefinition, etc.
├── shared/src/config.ts         # Config loading + env interpolation
├── gateway/src/start.ts         # Config-driven extension startup (out-of-process)
├── gateway/src/extensions.ts    # ExtensionManager (routing, events, lifecycle)
├── gateway/src/extension-host.ts  # ExtensionHostProcess (child process mgmt)
├── gateway/src/web/index.tsx    # SPA shell (route collection)
├── ui/src/components/StatusBar.tsx  # Hook output rendering (git badges, etc.)
└── extension-host/src/index.ts  # Generic host shim (dynamic import, NDJSON I/O)
```

---

## Testing

Extensions can be tested in isolation. See `extensions/mission-control/src/index.test.ts` for an example:

```typescript
import { describe, expect, test } from "bun:test";
import { createMyFeatureExtension } from "./index";

describe("my-feature", () => {
  test("handles do-thing method", async () => {
    const ext = createMyFeatureExtension({
      /* config */
    });
    await ext.start(mockContext);

    const result = await ext.handleMethod("my-feature.do-thing", { input: "hello" });
    expect(result).toEqual({ status: "ok", result: "..." });
  });
});
```

Use the CLI for integration testing against a running gateway:

```bash
bun run packages/cli/src/index.ts my-feature.health-check
bun run packages/cli/src/index.ts my-feature.do-thing --input "test"
```
