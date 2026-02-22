---
name: delegating-to-codex
description: "Use PROACTIVELY when you need to delegate code review, test writing, or coding tasks to Cody (your OpenAI Codex sub-agent). Cody runs as a separate agent with his own sandbox and can execute commands, read/write files, and run tests autonomously. Use this when you want a second opinion on code, need tests written, or want to offload mechanical tasks. Triggers on: ask cody, delegate to cody, cody review, cody test, code review, have cody, let cody, send to cody, codex task, run tests with cody, cody write tests, get a second opinion, delegate task, sub-agent, assistant review."
---

# Delegating Tasks to Cody (Codex Sub-Agent)

You have a sub-agent named Cody powered by OpenAI's Codex. He runs as a separate process with his own sandbox and can execute commands, edit files, and run tests autonomously. Use the Claudia CLI to send him work.

## When to Use

- You want a **code review** and a second pair of eyes on changes
- You need **tests written** for new or existing code
- You want to **offload mechanical tasks** (refactoring, formatting, boilerplate)
- You want a **second opinion** on architecture or implementation
- You need something done in parallel while you focus on other work

## CLI Commands

All commands go through the Claudia gateway. The gateway must be running.

### Send a General Task

```bash
claudia codex task --prompt "Describe what you want Cody to do"
```

Optional parameters:

- `--cwd /path/to/project` — Working directory (defaults to extension config)
- `--sandbox "read-only"` — Sandbox mode: `read-only`, `workspace-write`, `danger-full-access`
- `--model "gpt-5.2-codex"` — Model override
- `--effort "medium"` — Reasoning effort: `minimal`, `low`, `medium`, `high`, `xhigh`

### Code Review (Read-Only)

```bash
claudia codex review --prompt "Review the tags propagation for edge cases"
```

Optional: `--files '["src/extensions.ts", "src/start.ts"]'` — Focus on specific files.

Reviews always run in **read-only** sandbox — Cody can look but not touch.

### Write/Run Tests

```bash
claudia codex test --prompt "Write comprehensive tests for the voice extension"
```

Tests always run in **workspace-write** sandbox — Cody can create and modify files.

### Check Status

```bash
claudia codex status
```

Returns whether Cody is busy, what he's working on, elapsed time, and a result preview.

### Interrupt Active Task

```bash
claudia codex interrupt
```

Cancels whatever Cody is currently doing.

## Streaming Events

When Cody works, he emits real-time events through the gateway event bus:

| Event Pattern                  | What It Means                          |
| ------------------------------ | -------------------------------------- |
| `codex.{taskId}.turn_start`    | Cody started working                   |
| `codex.{taskId}.message_delta` | Streaming text output (token by token) |
| `codex.{taskId}.command_delta` | Live command stdout/stderr             |
| `codex.{taskId}.file_change`   | Cody edited a file                     |
| `codex.{taskId}.item_start`    | New work item (command, message, etc.) |
| `codex.{taskId}.item_stop`     | Work item completed                    |
| `codex.{taskId}.turn_stop`     | Cody finished — includes final result  |
| `codex.{taskId}.error`         | Something went wrong                   |

Subscribe to `codex.*` events to watch Cody work in real-time.

## Calling from Extension Code

From any Claudia extension, you can delegate to Cody via `ctx.call()`:

```typescript
// Fire and forget — returns immediately with a task handle
const handle = await ctx.call("codex.task", {
  prompt: "Review the session extension for memory leaks",
  cwd: "/Users/michael/Projects/iamclaudia-ai/claudia",
  sandbox: "read-only",
});
// handle = { taskId: "ctask_abc123", status: "running", message: "..." }

// Check on progress later
const status = await ctx.call("codex.status", {});
// status = { busy: true, taskId: "ctask_abc123", type: "task", elapsed: "15s", ... }
```

Listen for results via events:

```typescript
ctx.on("codex.*.turn_stop", (event) => {
  const { result, items, usage } = event.payload;
  // result = Cody's final text response
  // items = all work items (commands run, files changed, messages)
});
```

## Task Types and Sandbox Modes

| Method         | Sandbox                                   | Use Case                         |
| -------------- | ----------------------------------------- | -------------------------------- |
| `codex.task`   | Configurable (default: `workspace-write`) | General tasks                    |
| `codex.review` | `read-only` (forced)                      | Code review — safe, no writes    |
| `codex.test`   | `workspace-write` (forced)                | Test writing — needs file access |

## Examples

```bash
# Quick code review
claudia codex review --prompt "Check extensions/codex/src/index.ts for error handling gaps"

# Targeted review with file list
claudia codex review --prompt "Look for race conditions" --files '["src/session-manager.ts", "src/sdk-session.ts"]'

# Write tests for a specific module
claudia codex test --prompt "Write bun tests for extensions/voice/src/sentence-chunker.ts with edge cases for emoji and unicode"

# General task with high effort
claudia codex task --prompt "Refactor the workspace.ts database layer to use prepared statements" --effort high

# Check what Cody is doing
claudia codex status

# Cancel if taking too long
claudia codex interrupt
```

## Important Notes

- **One task at a time**: Cody can only work on one thing. If you send a new task while he's busy, it will error. Use `codex.interrupt` first, or check `codex.status`.
- **Auto-approve**: By default, Cody auto-approves all command executions and file changes. This is configurable via `autoApprove` in the extension config.
- **Fresh thread per task**: Each task creates a new Codex conversation thread. Context does not carry between tasks.
- **Personality**: Cody's system prompt is configurable. The default tells him to be thorough and precise.
- **The task returns immediately**: `codex.task` / `codex.review` / `codex.test` return a task handle right away. The actual work happens asynchronously. Watch events or poll `codex.status` for results.
- **Connection-scoped routing**: Events use `gateway.caller` routing, so only the client that initiated the task receives the streaming events.
