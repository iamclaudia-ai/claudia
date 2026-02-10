# Session Context — Claudia Runtime & Web UI

## What We're Building

Claudia's **session runtime** (`packages/runtime/`) manages Claude Code CLI processes via an HTTP proxy that intercepts Anthropic API calls. The **gateway** (`packages/gateway/`) connects to the runtime via WebSocket and relays streaming events to the **web UI** (`packages/ui/`).

## Architecture Flow

```
Web UI ←→ Gateway (30086) ←→ Runtime (30087) ←→ [Proxy ←→ Anthropic API]
                                                    ↑
                                              Claude CLI process
```

The proxy is a MITM between Claude CLI and the Anthropic API. It:
- Injects extended thinking config into requests (CLI doesn't support `--thinking`)
- Captures SSE streaming events and forwards them to clients
- Emits turn-level events (`turn_start`/`turn_stop`) for UI state management
- Filters out Haiku model side-channel requests (safety checks)

## Key Discoveries & Fixes (This Session)

### 1. Haiku Side-Channel Problem
Claude CLI makes **concurrent** `/v1/messages` requests — primary model (Opus/Sonnet) AND Haiku (for tool result safety checks). Haiku responses were:
- Polluting the event stream with `<is_displaying_contents>` messages
- Causing premature `turn_stop` events (Haiku's `end_turn` != actual turn end)
- Making the thinking animation flicker on/off between tool calls

**Fix**: Proxy checks `requestBody.model?.includes("haiku")` and skips ALL event emissions, turn tracking, and stop_reason updates for Haiku requests. Client also filters `message_start` where model includes "haiku" as a safety net.

### 2. Turn-Level Events
Problem: `message_start`/`message_stop` fire per API call, but a single "turn" spans multiple API calls (tool use → tool result → next response). UI was toggling thinking animation per message.

**Fix**: Proxy emits `turn_start` on first `/v1/messages` request and `turn_stop` when `stop_reason !== "tool_use"`. The `_inTurn` flag prevents duplicate `turn_start` emissions during multi-call turns.

### 3. Lazy Session Resumption
When runtime restarts, all sessions die. Gateway had stale `activeRuntimeSessionId`.

**Fix**: Manager's `prompt()` method auto-resumes sessions on first prompt if not found. Gateway passes `cwd` with prompt requests. No persistence needed — just lazy restart.

### 4. Mid-Turn Recovery
If browser refreshes during an active turn, UI misses `turn_start`.

**Fix**: Client detects streaming events while `isQuerying=false` and auto-enables thinking animation.

### 5. Model Config Not Passed on Lazy Resume
`manager.prompt()` lazy resume only passed `{ sessionId, cwd }`, missing model/thinking config. Sessions fell back to hardcoded `DEFAULT_MODEL = "claude-sonnet-4-20250514"` instead of using `claudia.json` config (`claude-opus-4-6`).

**Fix (just made, not yet tested)**: Manager now has `setConfig(config)` method. Runtime passes loaded `claudia.json` config. Lazy resume pulls `model`, `thinking`, `thinkingBudget` from config.

## Current State of Key Files

### `packages/runtime/src/proxy.ts`
- Turn tracking: `_inTurn`, `_lastStopReason`, `_eventSequence`
- Haiku filtering on ALL paths (request handling, SSE parsing, stream end, error handling)
- `resetTurn()` method for interrupt handling
- Thinking injection for non-Haiku requests only

### `packages/runtime/src/session.ts`
- Spawns Claude CLI with `--session-id` (new) or `--resume` (existing)
- Sets `ANTHROPIC_BASE_URL` to proxy for MITM
- Synthetic `turn_stop` emission on interrupt + `proxy.resetTurn()`

### `packages/runtime/src/manager.ts`
- `setConfig()` stores `ClaudiaConfig` for session defaults
- `prompt()` does lazy resume with config defaults (model, thinking, thinkingBudget)
- `create()` / `resume()` / `interrupt()` / `close()` / `list()`

### `packages/ui/src/hooks/useGateway.ts`
- `turn_start` → `setIsQuerying(true)`, `turn_stop` → `setIsQuerying(false)`
- `ignoringHaikuMessageRef` filters all events from Haiku message blocks
- Mid-turn recovery for HMR/refresh scenarios
- `message_start`/`message_stop` no longer toggle `isQuerying`

## Pending / TODO

- [ ] **Restart runtime** to test model config passthrough (changes just made to manager.ts + index.ts)
- [ ] **Verify Opus model** shows in `message_start` payload after restart
- [ ] **Commit** all changes: turn events, Haiku filtering, lazy resume, model config fix
- [ ] **Clean up** debug artifacts if any remain (sequence numbers in events, extra logging)
- [ ] Consider removing `_eventSequence` from proxy events (was for debugging)
- [ ] Eventually: emit turn events from a higher level than HTTP proxy (like pi-agent's agent-loop approach)

## Config

`~/.claudia/claudia.json`:
```json
{
  "session": {
    "model": "claude-opus-4-6",
    "thinking": true,
    "thinkingBudget": 10000
  }
}
```
