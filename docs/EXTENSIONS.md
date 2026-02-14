# Extension Guide

How to build, configure, and run Claudia extensions.

## Overview

Extensions are the primary way to add features to Claudia. Every capability — web chat, voice, iMessage, Mission Control — is an extension. Extensions register schema-driven methods, subscribe to the event bus, and optionally serve web pages.

Extensions can run **in-process** (loaded directly into the gateway) or **out-of-process** (as isolated child processes). Out-of-process extensions survive code changes without restarting the gateway or dropping WebSocket connections.

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
    "./extension": "./src/index.ts"
  },
  "dependencies": {
    "@claudia/shared": "workspace:*",
    "zod": "^3.25.76"
  }
}
```

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

### 3. Register in the gateway

Add to `packages/gateway/src/start.ts`:

```typescript
import { createMyFeatureExtension } from "@claudia/ext-my-feature/extension";

// In EXTENSION_FACTORIES:
"my-feature": (config) => createMyFeatureExtension(config),

// In MODULE_SPECIFIERS (if supporting out-of-process):
"my-feature": "@claudia/ext-my-feature",
```

Add to `packages/gateway/package.json` dependencies:

```json
"@claudia/ext-my-feature": "workspace:*"
```

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

Extensions export a factory function named `createXxxExtension`:

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
      outOfProcess: true, // Run as isolated child process
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
  → gateway start.ts reads extension configs
  → In-process: factory(config) directly
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
  ├── In-process: chat, mission-control (stable, have web pages)
  └── Child: bun --hot extension-host/src/index.ts @claudia/voice <config>
        └── stdin/stdout NDJSON ←→ gateway
```

1. Gateway reads `outOfProcess: true` from config
2. Spawns `bun --hot packages/extension-host/src/index.ts <module> <config-json>`
3. Host dynamically imports the module, finds the factory, calls `factory(config)`
4. Host sends a `register` message with extension metadata (methods, events, sourceRoutes)
5. Gateway registers the remote extension — methods, events, and source routing work transparently

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

### Enabling

Set `outOfProcess: true` in the extension config and add the module specifier to `MODULE_SPECIFIERS` in `start.ts`:

```typescript
const MODULE_SPECIFIERS: Record<string, string> = {
  voice: "@claudia/voice",
  imessage: "@claudia/ext-imessage",
};
```

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
    "./routes": "./src/routes.ts",
    "./extension": "./src/index.ts"
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

| Extension       | ID                | Package                        | Out-of-Process     | Web Pages                             | Source Routes |
| --------------- | ----------------- | ------------------------------ | ------------------ | ------------------------------------- | ------------- |
| Chat            | `chat`            | `@claudia/ext-chat`            | No (has web pages) | `/`, `/workspace/:id`, `/session/:id` | —             |
| Voice           | `voice`           | `@claudia/voice`               | Yes                | —                                     | —             |
| iMessage        | `imessage`        | `@claudia/ext-imessage`        | Supported          | —                                     | `imessage`    |
| Mission Control | `mission-control` | `@claudia/ext-mission-control` | No (has web pages) | `/mission-control`, `/logs`           | —             |

---

## File Structure

```
extensions/<name>/
├── package.json           # Exports: ./extension, ./routes (if has UI)
└── src/
    ├── index.ts           # Factory function + implementation
    ├── routes.ts          # Route declarations (if has UI)
    └── pages/             # React page components (if has UI)
        └── MyPage.tsx

packages/
├── shared/src/types.ts          # ClaudiaExtension, ExtensionContext, etc.
├── shared/src/config.ts         # Config loading + env interpolation
├── gateway/src/start.ts         # Extension factory registry + startup
├── gateway/src/extensions.ts    # ExtensionManager (routing, events, lifecycle)
├── gateway/src/extension-host.ts  # ExtensionHostProcess (child process mgmt)
├── gateway/src/web/index.tsx    # SPA shell (route collection)
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
