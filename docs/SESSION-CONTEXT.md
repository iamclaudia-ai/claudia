# Session Context — Claudia Runtime

Last updated: 2026-02-20

## Overview

Claudia's **session runtime** (`packages/runtime/`) manages Claude sessions using one of two interchangeable engines. The **gateway** (`packages/gateway/`) connects to the runtime via WebSocket and relays streaming events to clients (web UI, mobile, CLI, VS Code, etc.).

## Architecture Flow

```
Clients ←→ Gateway (30086) ←→ Runtime (30087) ←→ Session Engine ←→ Claude Code ←→ Anthropic API
```

The Runtime supports two engines (configured via `runtime.engine` in `~/.claudia/claudia.json`):

| Engine            | Class            | Mechanism                                                    |
| ----------------- | ---------------- | ------------------------------------------------------------ |
| `"cli"` (default) | `RuntimeSession` | `Bun.spawn` → Claude Code CLI with stdin/stdout NDJSON pipes |
| `"sdk"`           | `SDKSession`     | `@anthropic-ai/claude-agent-sdk` `query()` async generator   |

Both engines emit identical `StreamEvent`s via `EventEmitter`. The gateway and UI see no difference.

## Architecture History

The runtime has evolved through three phases:

1. **Proxy era** (removed) — HTTP MITM proxy intercepted CLI ↔ Anthropic API calls to inject thinking config and capture SSE events. Required Haiku side-channel filtering.
2. **Direct stdio** (current default) — `Bun.spawn` with `--input-format stream-json --output-format stream-json`. Thinking via `control_request` on stdin. No proxy needed.
3. **Agent SDK** (new option) — `query()` function wraps CLI internally. Push-based `MessageChannel` for multi-turn. Programmatic control via `query.interrupt()`, `query.setPermissionMode()`.

## Key Files

### `packages/runtime/src/manager.ts`

- `RuntimeSessionManager` — manages all active sessions
- `setConfig()` stores `ClaudiaConfig` for session defaults
- `engine` getter reads `config.runtime.engine`, defaults to `"cli"`
- `create()`/`resume()` route to correct factory based on engine
- `prompt()` does lazy resume with config defaults (model, thinking, effort)
- `wireSession()` forwards all session events to gateway via EventEmitter

### `packages/runtime/src/session.ts` (CLI Engine)

- `RuntimeSession` — spawns Claude CLI with `--session-id` (new) or `--resume` (existing)
- `ensureProcess()` — lazy spawn on first prompt
- `routeMessage()` — parses NDJSON from stdout, routes by message type
- `trackEventState()` / `emitSyntheticStops()` — event state tracking for interrupts
- `autoApproveInteractiveTool()` — auto-approves ExitPlanMode/EnterPlanMode, forwards AskUserQuestion
- Thinking via `control_request` with `set_max_thinking_tokens` on stdin

### `packages/runtime/src/sdk-session.ts` (SDK Engine)

- `SDKSession` — uses `query()` from `@anthropic-ai/claude-agent-sdk`
- `MessageChannel` — push-based `AsyncIterable<SDKUserMessage>` for multi-turn conversations
- `ensureQuery()` — lazy query creation on first prompt
- `routeMessage()` — identical event routing logic to CLI engine
- `buildQueryOptions()` — maps session config to SDK options (sessionId/resume, thinking, permissions)
- All tool approval via `canUseTool: async () => ({ behavior: "allow" })`

### `packages/ui/src/hooks/useGateway.ts`

- `turn_stop` → `setIsQuerying(false)`
- Mid-turn recovery for HMR/refresh scenarios
- Streaming event handling (content_block_delta, etc.)

## Session ID Management

Two-tier ID system:

```
Gateway DB:  ses_xxx (TypeID) ←→ ccSessionId (UUID)
Runtime:     ccSessionId (UUID) maps to CLI --session-id / SDK options.sessionId
JSONL files: ~/.claude/projects/{cwd-encoded}/{uuid}.jsonl
```

The gateway generates the UUID (`ccSessionId`) when creating a session. It checks for JSONL file existence to determine new (`--session-id`) vs resume (`--resume`).

## Event Flow

Both engines emit identical events:

| Event                 | When                                                                                       |
| --------------------- | ------------------------------------------------------------------------------------------ |
| `"sse"` + StreamEvent | Every Anthropic SSE event, plus turn_stop, request_tool_results, compaction, tool_progress |
| `"ready"`             | After start()                                                                              |
| `"prompt_sent"`       | After prompt written                                                                       |
| `"process_started"`   | When engine starts (CLI spawn or SDK query begin)                                          |
| `"process_ended"`     | When engine finishes (CLI exit or SDK generator done)                                      |
| `"interrupted"`       | After interrupt                                                                            |
| `"closed"`            | After close                                                                                |

## Config

`~/.claudia/claudia.json`:

```json
{
  "runtime": {
    "engine": "sdk" // or "cli" (default)
  },
  "session": {
    "model": "sonnet",
    "thinking": true,
    "effort": "medium",
    "systemPrompt": null
  }
}
```
