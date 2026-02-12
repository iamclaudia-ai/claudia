# Claudia API Reference (Audit)

Last updated: 2026-02-12

This document maps the APIs currently exposed by `packages/`, `extensions/`, and `clients/`, with emphasis on:

- required vs optional inputs
- implicit defaults
- places where optional fields currently trigger fallback behavior

## 1. Wire Protocol

All gateway/runtime socket traffic uses:

```json
{ "type": "req", "id": "string", "method": "namespace.action", "params": {} }
{ "type": "res", "id": "string", "ok": true, "payload": {} }
{ "type": "event", "event": "name", "payload": {} }
```

Source of truth: `packages/shared/src/protocol.ts`.

## 2. Gateway API (`packages/gateway`)

Endpoint: `ws://<host>:30086/ws`  
Health: `GET /health`

### 2.1 Workspace methods

| Method                    | Required params                              | Optional params         | Default/fallback behavior                                                      |
| ------------------------- | -------------------------------------------- | ----------------------- | ------------------------------------------------------------------------------ |
| `workspace.list`          | none                                         | none                    | returns all workspaces                                                         |
| `workspace.get`           | `workspaceId`                                | none                    | error if missing/not found                                                     |
| `workspace.getOrCreate`   | `cwd`                                        | `name`                  | if `name` missing, uses `basename(cwd)`                                        |
| `workspace.listSessions`  | `workspaceId`                                | none                    | returns sessions for only that workspace                                       |
| `workspace.createSession` | `workspaceId`, `model`, `thinking`, `effort` | `title`, `systemPrompt` | archives current active session in workspace, then creates new runtime session |

Refs: `packages/gateway/src/index.ts`, `packages/gateway/src/db/models/workspace.ts`.

### 2.2 Session methods

| Method              | Required params                                       | Optional params           | Default/fallback behavior                                         |
| ------------------- | ----------------------------------------------------- | ------------------------- | ----------------------------------------------------------------- |
| `session.info`      | none                                                  | none                      | returns active runtime + current record info                      |
| `session.prompt`    | `sessionId`, `content`, `model`, `thinking`, `effort` | `speakResponse`, `source` | no active-session fallback                                        |
| `session.interrupt` | `sessionId`                                           | none                      | interrupts that specific session                                  |
| `session.get`       | `sessionId`                                           | none                      | error if missing/not found                                        |
| `session.history`   | `sessionId`                                           | `limit`, `offset`         | if no `limit`, returns full parsed history; `offset` defaults `0` |
| `session.switch`    | `sessionId`                                           | none                      | closes current runtime session, resumes target                    |
| `session.reset`     | `workspaceId`, `model`, `thinking`, `effort`          | `systemPrompt`            | creates a new session via explicit workspace+runtime params       |

Refs: `packages/gateway/src/index.ts`, `packages/gateway/src/session-manager.ts`.

### 2.3 Extension/system methods

| Method           | Required params | Optional params | Default/fallback behavior                                         |
| ---------------- | --------------- | --------------- | ----------------------------------------------------------------- |
| `extension.list` | none            | none            | returns loaded extension metadata                                 |
| `method.list`    | none            | none            | returns gateway + extension method catalog including JSON Schemas |
| `subscribe`      | none            | `events`        | `events` defaults to `[]`                                         |
| `unsubscribe`    | none            | `events`        | `events` defaults to `[]`                                         |

Any other namespaced method (example `voice.speak`) is routed to extension handlers.

Gateway now validates extension method params against each extension method's required `inputSchema` before dispatching to `handleMethod`.

### 2.4 Event routing notes

- `voice.*` events with `payload.sessionId` are session-scoped in broadcast: only clients subscribed to `stream.{sessionId}.*` (or `*`) receive them.
- General subscription matching supports exact names, `*`, and prefix wildcards (`foo.*`).

Ref: `packages/gateway/src/index.ts`.

## 3. Runtime API (`packages/runtime`)

Endpoint: `ws://<host>:30087/ws`  
Health: `GET /health`  
Kill one runtime session: `DELETE /session/:id`

### 3.1 Runtime session methods

| Method              | Required params        | Optional params                               | Default/fallback behavior                                                |
| ------------------- | ---------------------- | --------------------------------------------- | ------------------------------------------------------------------------ |
| `session.create`    | `cwd`                  | `model`, `systemPrompt`, `thinking`, `effort` | runtime default model is `claude-sonnet-4-20250514` when `model` omitted |
| `session.resume`    | `sessionId`, `cwd`     | `model`, `thinking`, `effort`                 | if omitted, falls back to runtime defaults                               |
| `session.prompt`    | `sessionId`, `content` | `cwd`                                         | if process not alive and `cwd` provided, auto-resume kicks in            |
| `session.interrupt` | `sessionId`            | none                                          | returns `interrupted` or `not_found`                                     |
| `session.close`     | `sessionId`            | none                                          | closes process and removes from manager map                              |
| `session.list`      | none                   | none                                          | returns currently active runtime sessions only                           |

Refs: `packages/runtime/src/index.ts`, `packages/runtime/src/manager.ts`, `packages/runtime/src/session.ts`.

## 4. Extension APIs (`extensions/*`)

These are called through gateway using `extensionId.method`.

Extension contract now requires method metadata with an `inputSchema` for every method.
At runtime, methods are discovered and exposed to clients via `method.list` with JSON Schema payloads.

### 4.1 Voice extension (`extensions/voice`)

Methods:

- `voice.speak`: required `text`
- `voice.stop`: no params
- `voice.status`: no params
- `voice.replay`: required `sessionId`, `streamId`
- `voice.health-check`: no params

Config defaults:

- `apiKey`: `process.env.CARTESIA_API_KEY || ""`
- `voiceId`: `process.env.CARTESIA_VOICE_ID || "a0e99841-438c-4a64-b679-ae501e7d6091"`
- `model`: `"sonic-3"`
- `autoSpeak`: `false`
- `summarizeThreshold`: `150`
- `emotions`: `["positivity:high", "curiosity"]`
- `speed`: `1.0`
- `streaming`: `true`

Events emitted:

- `voice.speaking`, `voice.done`, `voice.audio`, `voice.error`
- `voice.stream_start`, `voice.audio_chunk`, `voice.stream_end`

Ref: `extensions/voice/src/index.ts`.

### 4.2 iMessage extension (`extensions/imessage`)

Methods:

- `imessage.send`: required `text` and one of (`chatId` or `to`)
- `imessage.status`: no params
- `imessage.chats`: optional `limit` (defaults `20`)
- `imessage.health-check`: no params

Config defaults:

- `cliPath`: `"imsg"`
- `dbPath`: `undefined` (imsg default DB path)
- `allowedSenders`: `[]` (safe deny-all behavior)
- `includeAttachments`: `false`
- `historyLimit`: `0`

Events emitted:

- `imessage.message`, `imessage.sent`, `imessage.error`, `imessage.prompt_request`

Ref: `extensions/imessage/src/index.ts`.

### 4.3 Chat extension (`extensions/chat`)

Methods:

- `chat.health-check`: no params
- `chat.kill-session`: required `sessionId`
- `chat.kill-all-sessions`: no params

Notes:

- talks to runtime HTTP API (`/health`, `DELETE /session/:id`).
- runtime port defaults to `30087` via shared config.

Ref: `extensions/chat/src/extension.ts`.

### 4.4 Mission Control extension (`extensions/mission-control`)

Methods:

- `mission-control.health-check`: no params

Events: none  
Server-side extension exists mainly to support UI route/pages and health metadata.

Ref: `extensions/mission-control/src/index.ts`.

## 5. Memory MCP API (`packages/memory-mcp`)

Transport: stdio MCP server.

Tools:

| Tool              | Required args | Optional args                             | Default/fallback behavior                                                                        |
| ----------------- | ------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `memory_remember` | `content`     | `filename`, `section`, `category`, `tags` | defaults to dated file under `insights/`; section defaults `Notes`; category defaults `insights` |
| `memory_recall`   | `query`       | `limit`, `category`                       | `limit` defaults `5`                                                                             |
| `memory_read`     | `filepath`    | `section`                                 | reads whole file if `section` missing                                                            |
| `memory_list`     | none          | `category`, `recent`                      | if `recent`, returns most recent N memories                                                      |
| `memory_sections` | none          | `filepath`                                | without filepath returns global known section titles                                             |
| `memory_sync`     | none          | none                                      | imports memory sections into registry DB                                                         |

Ref: `packages/memory-mcp/src/index.ts`.

## 6. Client-Exposed APIs (`clients/*`, `packages/ui`)

### 6.1 VS Code commands/settings (`clients/vscode`)

Commands:

- `claudia.openChat`
- `claudia.sendSelection`
- `claudia.explainCode`
- `claudia.fixCode`

Settings:

- `claudia.gatewayUrl` default `ws://localhost:30086/ws`
- `claudia.includeFileContext` default `true`
- `claudia.openOnStartup` default `false`

Ref: `clients/vscode/package.json`, `clients/vscode/src/extension.ts`.

### 6.2 iOS VoiceMode gateway contract (`clients/ios/VoiceMode`)

Client currently calls:

- `workspace.getOrCreate` (always with explicit `cwd`)
- `session.switch` / `workspace.listSessions` / `workspace.createSession` for reuse flow
- `subscribe` with `["session.*", "voice.*", "stream.{ccSessionId}.*"]`
- `session.prompt` with explicit `sessionId`, `model`, `thinking`, `effort`, `content`, and `speakResponse: true`
- `session.interrupt` with explicit `sessionId`, plus `voice.stop`

Default app `cwd`: `/Users/michael/claudia/chat`

Ref: `clients/ios/VoiceMode/GatewayClient.swift`.

### 6.3 Menubar gateway contract (`clients/menubar`)

Client currently calls:

- `subscribe` with `["session.*", "voice.*"]`
- `workspace.getOrCreate` then `workspace.createSession` if needed
- `session.prompt` with explicit `sessionId`, `model`, `thinking`, `effort`, and `content` (plus optional `speakResponse`)
- `voice.speak`

Default gateway URL:

- env `CLAUDIA_GATEWAY_URL`
- else user default `gatewayURL`
- else `ws://localhost:30086/ws`

Ref: `clients/menubar/Claudia/GatewayClient.swift`.

### 6.4 UI hook contract (`packages/ui`)

Public hook options:

- `sessionId?` for explicit web session page
- `autoDiscoverCwd?` for VS Code auto-discover flow

Ref: `packages/ui/src/hooks/useGateway.ts`.

## 7. Remaining Optional Hotspots

Most high-impact gateway/session optionals were removed. Remaining meaningful optionals:

1. `session.history.limit` (gateway): missing means full-history parse.
2. `workspace.getOrCreate.name` (gateway): missing means `basename(cwd)`.
3. Runtime boundary (`session.create` / `session.resume`) still supports optional model/thinking/effort at runtime API layer, though gateway now sends them explicitly.
4. `imessage.chats.limit` (extension): defaults to `20`.
5. Voice extension config fields (api/model/voice/speed/emotions): fallback to baked defaults/env.

## 8. Drift Note

`packages/shared/src/protocol.ts` contains older protocol/interface fields that do not fully match current gateway/runtime behavior (for example session-creation/prompt shapes and extension payload details).  
Before tightening required fields, align shared protocol types with live handlers first, then enforce requireds at gateway boundary.
