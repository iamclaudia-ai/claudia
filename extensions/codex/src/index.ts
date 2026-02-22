/**
 * Codex Extension — Delegate tasks to an OpenAI Codex sub-agent ("Cody")
 *
 * Wraps @openai/codex-sdk to give Claudia a sub-agent she can delegate to
 * for code review, test writing, and general tasks. Streams Cody's progress
 * through the Claudia event bus in real-time.
 *
 * Architecture:
 *   Gateway <--NDJSON--> Extension Host (codex) <--stdio--> Codex CLI
 *   The SDK spawns & manages the Codex CLI process internally.
 */

import { z } from "zod";
import { runExtensionHost } from "@claudia/extension-host";
import type { ClaudiaExtension, ExtensionContext, HealthCheckResponse } from "@claudia/shared";
import {
  Codex,
  type Thread,
  type ThreadEvent,
  type ThreadItem,
  type CodexOptions,
  type ThreadOptions,
  type SandboxMode,
} from "@openai/codex-sdk";

// ── Configuration ────────────────────────────────────────────

export interface CodexConfig {
  /** OpenAI API key (required) */
  apiKey?: string;
  /** Path to codex CLI binary (default: auto-detected by SDK) */
  cliPath?: string;
  /** Default model (e.g., "o3-mini", "gpt-5.1-codex") */
  model?: string;
  /** Default sandbox mode */
  sandboxMode?: SandboxMode;
  /** Default working directory for Codex operations */
  cwd?: string;
  /** System personality / instructions prefix for Cody */
  personality?: string;
  /** Default effort level */
  effort?: "minimal" | "low" | "medium" | "high" | "xhigh";
  /** Auto-approve all command and file change requests (default: true) */
  autoApprove?: boolean;
}

const DEFAULT_PERSONALITY =
  "You are Cody, a meticulous sub-agent working for Claudia. " +
  "Be thorough, precise, and report findings clearly. " +
  "When reviewing code, look for bugs, edge cases, and missed error handling. " +
  "When writing tests, aim for high coverage and test edge cases.";

// ── Internal Task State ──────────────────────────────────────

type TaskType = "task" | "review" | "test";
type TaskStatus = "running" | "completed" | "failed" | "interrupted";

interface ActiveTask {
  id: string;
  type: TaskType;
  threadId: string | null;
  prompt: string;
  status: TaskStatus;
  startedAt: number;
  resultText: string;
  items: ThreadItem[];
  error: string | null;
}

/** Request context captured at call time for async event routing */
interface TaskContext {
  connectionId: string | null;
  tags: string[] | null;
}

// ── Zod Schemas ──────────────────────────────────────────────

const TaskSchema = z.object({
  prompt: z.string().min(1).describe("The task prompt for Cody"),
  cwd: z.string().optional().describe("Working directory override"),
  sandbox: z
    .enum(["read-only", "workspace-write", "danger-full-access"])
    .optional()
    .describe("Sandbox mode override"),
  model: z.string().optional().describe("Model override"),
  effort: z
    .enum(["minimal", "low", "medium", "high", "xhigh"])
    .optional()
    .describe("Reasoning effort override"),
});

const ReviewSchema = z.object({
  prompt: z.string().min(1).describe("What to review and what to look for"),
  cwd: z.string().optional().describe("Working directory override"),
  files: z.array(z.string()).optional().describe("Specific files to review (prepended to prompt)"),
});

const TestSchema = z.object({
  prompt: z.string().min(1).describe("What to test — targets, framework hints, coverage goals"),
  cwd: z.string().optional().describe("Working directory override"),
});

const InterruptSchema = z.object({});
const StatusSchema = z.object({});
const HealthCheckSchema = z.object({});

// ── Helpers ──────────────────────────────────────────────────

let taskCounter = 0;
function newTaskId(): string {
  return `ctask_${Date.now().toString(36)}_${(++taskCounter).toString(36)}`;
}

// ── Extension Factory ────────────────────────────────────────

export function createCodexExtension(config: CodexConfig = {}): ClaudiaExtension {
  let ctx: ExtensionContext | null = null;
  let codex: Codex | null = null;
  let activeTask: ActiveTask | null = null;
  let taskContext: TaskContext | null = null;
  let abortController: AbortController | null = null;

  // Resolved config with defaults
  const cfg: Required<Pick<CodexConfig, "personality" | "autoApprove" | "effort">> & CodexConfig = {
    personality: DEFAULT_PERSONALITY,
    autoApprove: true,
    effort: "medium",
    ...config,
  };

  // ── Lazy SDK init ────────────────────────────────────────

  function ensureCodex(): Codex {
    if (codex) return codex;

    if (!cfg.apiKey) {
      throw new Error(
        "Codex extension requires an OpenAI API key (config.apiKey or $OPENAI_API_KEY)",
      );
    }

    const options: CodexOptions = {
      apiKey: cfg.apiKey,
    };
    if (cfg.cliPath) {
      options.codexPathOverride = cfg.cliPath;
    }

    codex = new Codex(options);
    ctx?.log.info("Codex SDK initialized");
    return codex;
  }

  // ── Event Emission with Envelope Context ─────────────────

  function emit(eventType: string, payload: Record<string, unknown>): void {
    if (!ctx) return;

    const emitOptions: { source?: string; connectionId?: string; tags?: string[] } = {};
    emitOptions.source = "gateway.caller";
    if (taskContext?.connectionId) emitOptions.connectionId = taskContext.connectionId;
    if (taskContext?.tags) emitOptions.tags = taskContext.tags;

    ctx.emit(eventType, payload, Object.keys(emitOptions).length > 0 ? emitOptions : undefined);
  }

  // ── Stream Bridge — Codex ThreadEvents → Claudia Events ──

  async function runStreamedTask(thread: Thread, task: ActiveTask, prompt: string): Promise<void> {
    abortController = new AbortController();

    try {
      const { events } = await thread.runStreamed(prompt, {
        signal: abortController.signal,
      });

      for await (const event of events) {
        if (!activeTask || activeTask.id !== task.id) break; // interrupted

        bridgeEvent(task, event);
      }

      // If we exited normally and task wasn't already marked
      if (activeTask?.id === task.id && task.status === "running") {
        task.status = "completed";
        emit(`codex.${task.id}.turn_stop`, {
          taskId: task.id,
          type: task.type,
          result: task.resultText,
          items: task.items.map(summarizeItem),
          threadId: thread.id,
        });
        ctx?.log.info(`Task ${task.id} completed (${task.type})`);
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);

      // AbortError means we interrupted intentionally
      if (message.includes("abort") || message.includes("cancel")) {
        task.status = "interrupted";
        emit(`codex.${task.id}.turn_stop`, {
          taskId: task.id,
          type: task.type,
          result: task.resultText,
          interrupted: true,
          threadId: thread.id,
        });
        ctx?.log.info(`Task ${task.id} interrupted`);
      } else {
        task.status = "failed";
        task.error = message;
        emit(`codex.${task.id}.error`, {
          taskId: task.id,
          type: task.type,
          error: message,
          threadId: thread.id,
        });
        ctx?.log.error(`Task ${task.id} failed: ${message}`);
      }
    } finally {
      abortController = null;
      // Clear active task only if it's still ours
      if (activeTask?.id === task.id) {
        activeTask = null;
        taskContext = null;
      }
    }
  }

  /** Map SDK ThreadEvent to Claudia event bus emissions */
  function bridgeEvent(task: ActiveTask, event: ThreadEvent): void {
    const taskId = task.id;

    switch (event.type) {
      case "thread.started":
        task.threadId = event.thread_id;
        break;

      case "turn.started":
        emit(`codex.${taskId}.turn_start`, {
          taskId,
          type: task.type,
          threadId: task.threadId,
        });
        break;

      case "item.started":
        emit(`codex.${taskId}.item_start`, {
          taskId,
          itemType: event.item.type,
          item: summarizeItem(event.item),
        });
        // If it's a command, log what's running
        if (event.item.type === "command_execution") {
          ctx?.log.info(`Cody running: ${event.item.command}`);
        }
        break;

      case "item.updated":
        handleItemUpdate(task, event.item);
        break;

      case "item.completed":
        task.items.push(event.item);
        emit(`codex.${taskId}.item_stop`, {
          taskId,
          itemType: event.item.type,
          item: summarizeItem(event.item),
        });
        // Accumulate agent message text
        if (event.item.type === "agent_message") {
          task.resultText += (task.resultText ? "\n" : "") + event.item.text;
        }
        break;

      case "turn.completed":
        task.status = "completed";
        emit(`codex.${taskId}.turn_stop`, {
          taskId,
          type: task.type,
          result: task.resultText,
          items: task.items.map(summarizeItem),
          threadId: task.threadId,
          usage: event.usage,
        });
        ctx?.log.info(`Task ${taskId} completed (${task.type})`);
        break;

      case "turn.failed":
        task.status = "failed";
        task.error = event.error.message;
        emit(`codex.${taskId}.error`, {
          taskId,
          type: task.type,
          error: event.error.message,
          threadId: task.threadId,
        });
        ctx?.log.error(`Task ${taskId} failed: ${event.error.message}`);
        break;

      case "error":
        ctx?.log.error(`Codex stream error: ${event.message}`);
        emit(`codex.${taskId}.error`, {
          taskId,
          type: task.type,
          error: event.message,
          threadId: task.threadId,
        });
        break;
    }
  }

  /** Emit streaming deltas for item updates */
  function handleItemUpdate(task: ActiveTask, item: ThreadItem): void {
    const taskId = task.id;

    switch (item.type) {
      case "agent_message":
        // Streaming text delta — the main thing you want to watch!
        emit(`codex.${taskId}.message_delta`, {
          taskId,
          text: item.text,
        });
        break;

      case "command_execution":
        // Live command output
        emit(`codex.${taskId}.command_delta`, {
          taskId,
          command: item.command,
          output: item.aggregated_output,
          status: item.status,
        });
        break;

      case "file_change":
        // File change update
        emit(`codex.${taskId}.file_change`, {
          taskId,
          changes: item.changes,
          status: item.status,
        });
        break;

      default:
        // reasoning, web_search, mcp_tool_call, etc.
        emit(`codex.${taskId}.item_update`, {
          taskId,
          itemType: item.type,
          item: summarizeItem(item),
        });
        break;
    }
  }

  /** Create a safe summary of an item for event payloads */
  function summarizeItem(item: ThreadItem): Record<string, unknown> {
    const base: Record<string, unknown> = { type: item.type, id: item.id };

    switch (item.type) {
      case "agent_message":
        base.text = item.text;
        break;
      case "command_execution":
        base.command = item.command;
        base.exitCode = item.exit_code;
        base.status = item.status;
        // Truncate long output in summaries
        base.output =
          item.aggregated_output.length > 2000
            ? item.aggregated_output.slice(0, 2000) + "... (truncated)"
            : item.aggregated_output;
        break;
      case "file_change":
        base.changes = item.changes;
        base.status = item.status;
        break;
      case "reasoning":
        base.text = item.text;
        break;
      default:
        // Include raw for other types
        Object.assign(base, item);
        break;
    }
    return base;
  }

  // ── Core Task Runner ─────────────────────────────────────

  async function startTask(
    type: TaskType,
    prompt: string,
    options: {
      cwd?: string;
      sandbox?: SandboxMode;
      model?: string;
      effort?: string;
    } = {},
  ): Promise<Record<string, unknown>> {
    if (activeTask && activeTask.status === "running") {
      throw new Error(
        `Cody is busy with task ${activeTask.id} (${activeTask.type}). ` +
          `Use codex.interrupt to cancel, or codex.status to check progress.`,
      );
    }

    const sdk = ensureCodex();
    const taskId = newTaskId();

    // Capture envelope context for async event routing
    taskContext = {
      connectionId: ctx?.connectionId ?? null,
      tags: ctx?.tags ?? null,
    };

    const task: ActiveTask = {
      id: taskId,
      type,
      threadId: null,
      prompt,
      status: "running",
      startedAt: Date.now(),
      resultText: "",
      items: [],
      error: null,
    };
    activeTask = task;

    // Build thread options
    const threadOptions: ThreadOptions = {
      workingDirectory: options.cwd || cfg.cwd,
      skipGitRepoCheck: true,
      model: options.model || cfg.model,
      sandboxMode: options.sandbox || cfg.sandboxMode || "workspace-write",
      modelReasoningEffort: (options.effort || cfg.effort) as ThreadOptions["modelReasoningEffort"],
      approvalPolicy: cfg.autoApprove ? "never" : "on-request",
      webSearchEnabled: false,
    };

    // Start thread and kick off streaming (fire and forget)
    const thread = sdk.startThread(threadOptions);

    // Prepend personality to prompt
    const fullPrompt = cfg.personality ? `${cfg.personality}\n\n---\n\n${prompt}` : prompt;

    ctx?.log.info(`Starting ${type} task ${taskId}: ${prompt.slice(0, 100)}...`);

    // Run in background — don't await! Return handle immediately.
    runStreamedTask(thread, task, fullPrompt).catch((err) => {
      ctx?.log.error(`Unhandled error in task ${taskId}: ${err}`);
    });

    return {
      taskId,
      type,
      status: "running",
      message: `Cody is on it! Watch codex.${taskId}.* events for progress.`,
    };
  }

  // ── Extension Definition ─────────────────────────────────

  return {
    id: "codex",
    name: "Codex (OpenAI Sub-Agent)",

    methods: [
      {
        name: "codex.task",
        description: "Delegate a general task to Cody (the Codex sub-agent)",
        inputSchema: TaskSchema,
      },
      {
        name: "codex.review",
        description: "Ask Cody to review code (read-only sandbox)",
        inputSchema: ReviewSchema,
      },
      {
        name: "codex.test",
        description: "Ask Cody to write or run tests (workspace-write sandbox)",
        inputSchema: TestSchema,
      },
      {
        name: "codex.interrupt",
        description: "Cancel Cody's active task",
        inputSchema: InterruptSchema,
      },
      {
        name: "codex.status",
        description: "Check if Cody is busy and get current task info",
        inputSchema: StatusSchema,
      },
      {
        name: "codex.health_check",
        description: "Health check for Mission Control dashboard",
        inputSchema: HealthCheckSchema,
      },
    ],

    events: [
      // Turn lifecycle
      "codex.*.turn_start",
      "codex.*.turn_stop",
      // Streaming deltas (the good stuff!)
      "codex.*.message_delta",
      "codex.*.command_delta",
      "codex.*.file_change",
      // Item lifecycle
      "codex.*.item_start",
      "codex.*.item_stop",
      "codex.*.item_update",
      // Errors
      "codex.*.error",
    ],

    async start(context: ExtensionContext) {
      ctx = context;
      ctx.log.info("Codex extension started (SDK will be initialized on first use)");
    },

    async stop() {
      // Interrupt any active task
      if (abortController) {
        abortController.abort();
      }
      activeTask = null;
      taskContext = null;
      abortController = null;
      codex = null;
      ctx?.log.info("Codex extension stopped");
      ctx = null;
    },

    async handleMethod(method: string, params: Record<string, unknown>) {
      switch (method) {
        // ── General Task ───────────────────────────────────
        case "codex.task": {
          const { prompt, cwd, sandbox, model, effort } = params as z.infer<typeof TaskSchema>;
          return startTask("task", prompt, { cwd, sandbox, model, effort });
        }

        // ── Code Review (read-only) ───────────────────────
        case "codex.review": {
          const { prompt, cwd, files } = params as z.infer<typeof ReviewSchema>;

          // Prepend file list to review prompt
          let reviewPrompt = prompt;
          if (files?.length) {
            reviewPrompt = `Review the following files: ${files.join(", ")}\n\n${prompt}`;
          }

          return startTask("review", reviewPrompt, {
            cwd,
            sandbox: "read-only", // Always read-only for reviews
          });
        }

        // ── Test Writing (workspace-write) ─────────────────
        case "codex.test": {
          const { prompt, cwd } = params as z.infer<typeof TestSchema>;
          return startTask("test", prompt, {
            cwd,
            sandbox: "workspace-write", // Tests need write access
          });
        }

        // ── Interrupt Active Task ──────────────────────────
        case "codex.interrupt": {
          if (!activeTask || activeTask.status !== "running") {
            return { ok: true, message: "No active task to interrupt" };
          }

          const taskId = activeTask.id;
          if (abortController) {
            abortController.abort();
          }
          ctx?.log.info(`Interrupting task ${taskId}`);

          return {
            ok: true,
            taskId,
            message: `Interrupted task ${taskId}`,
          };
        }

        // ── Status Check ───────────────────────────────────
        case "codex.status": {
          if (!activeTask) {
            return { busy: false, message: "Cody is available" };
          }

          return {
            busy: activeTask.status === "running",
            taskId: activeTask.id,
            type: activeTask.type,
            status: activeTask.status,
            prompt: activeTask.prompt.slice(0, 200),
            elapsed: `${Math.round((Date.now() - activeTask.startedAt) / 1000)}s`,
            itemCount: activeTask.items.length,
            resultPreview: activeTask.resultText.slice(0, 500) || null,
            threadId: activeTask.threadId,
          };
        }

        // ── Health Check ───────────────────────────────────
        case "codex.health_check": {
          const response: HealthCheckResponse = {
            ok: !!cfg.apiKey,
            status: !cfg.apiKey
              ? "disconnected"
              : activeTask?.status === "running"
                ? "healthy"
                : "healthy",
            label: "Codex (OpenAI Sub-Agent)",
            metrics: [
              { label: "API Key", value: cfg.apiKey ? "configured" : "missing" },
              { label: "Model", value: cfg.model || "default" },
              { label: "Sandbox", value: cfg.sandboxMode || "workspace-write" },
              { label: "Active Task", value: activeTask?.type || "none" },
              {
                label: "Status",
                value: activeTask
                  ? `${activeTask.status} (${Math.round((Date.now() - activeTask.startedAt) / 1000)}s)`
                  : "idle",
              },
            ],
            items: activeTask
              ? [
                  {
                    id: activeTask.id,
                    label: `${activeTask.type}: ${activeTask.prompt.slice(0, 60)}`,
                    status: activeTask.status === "running" ? "healthy" : "inactive",
                    details: {
                      threadId: activeTask.threadId || "pending",
                      items: String(activeTask.items.length),
                      elapsed: `${Math.round((Date.now() - activeTask.startedAt) / 1000)}s`,
                    },
                  },
                ]
              : [],
          };
          return response;
        }

        default:
          throw new Error(`Unknown method: ${method}`);
      }
    },

    health() {
      return {
        ok: !!cfg.apiKey,
        details: {
          apiKeyConfigured: !!cfg.apiKey,
          model: cfg.model || "default",
          busy: activeTask?.status === "running",
          activeTaskId: activeTask?.id || null,
        },
      };
    },
  };
}

// ── Entry Point ──────────────────────────────────────────────

if (import.meta.main) {
  runExtensionHost(createCodexExtension);
}
