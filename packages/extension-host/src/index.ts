#!/usr/bin/env bun
/**
 * Extension Host — Generic shim for running extensions out-of-process.
 *
 * Spawned by the gateway as: bun --hot extension-host/src/index.ts <module> <config-json>
 *
 * Communicates with the gateway via stdin/stdout NDJSON:
 *   - Reads method calls + events from stdin
 *   - Writes responses + events + registration to stdout
 *
 * With `bun --hot`, code changes hot-reload without restarting the process,
 * so the stdio pipes to the gateway stay intact.
 */

import type { ClaudiaExtension, ExtensionContext, GatewayEvent } from "@claudia/shared";
import { createLogger } from "@claudia/shared";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";

// ── Redirect console to stderr ────────────────────────────────
// stdout is reserved for NDJSON protocol. The shared logger writes to
// both console AND file, so we redirect console.log/warn/error to stderr.

const stderrWrite = (msg: string) => process.stderr.write(msg + "\n");
console.log = (...args: unknown[]) => stderrWrite(args.map(String).join(" "));
console.warn = (...args: unknown[]) => stderrWrite(args.map(String).join(" "));
console.error = (...args: unknown[]) => stderrWrite(args.map(String).join(" "));

// ── Args ──────────────────────────────────────────────────────

const moduleSpec = process.argv[2];
const configJson = process.argv[3] || "{}";

if (!moduleSpec) {
  process.stderr.write(
    "Usage: bun --hot extension-host/src/index.ts <module-specifier> [config-json]\n",
  );
  process.exit(1);
}

// Use stderr for host-level logging (stdout is reserved for NDJSON protocol)
const hostLog = createLogger(
  "ExtensionHost",
  join(homedir(), ".claudia", "logs", "extension-host.log"),
);

// ── Parent liveness check ────────────────────────────────────
// When bun --watch restarts the gateway, orphan extension hosts get
// reparented to PID 1 (launchd). Poll to detect this and self-terminate.
const parentPidAtStart = process.ppid;
const parentCheckInterval = setInterval(() => {
  if (process.ppid !== parentPidAtStart) {
    hostLog.info(`Parent PID changed (${parentPidAtStart} → ${process.ppid}), shutting down`);
    clearInterval(parentCheckInterval);
    process.exit(0);
  }
}, 2000);

// ── NDJSON I/O ────────────────────────────────────────────────

function write(msg: unknown): void {
  const line = JSON.stringify(msg);
  process.stdout.write(line + "\n");
}

function writeEvent(type: string, payload: unknown, options?: { source?: string }): void {
  write({ type: "event", event: type, payload, source: options?.source });
}

// ── Pending Calls (ctx.call → gateway hub) ──────────────────

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const pendingCalls = new Map<string, PendingCall>();
const CALL_TIMEOUT = 300_000; // 5 min (matches extension host request timeout)

// Current call context — set per inbound request from gateway
let currentConnectionId: string | null = null;
let currentTraceId: string | null = null;
let currentDepth = 0;
let currentDeadlineMs: number | null = null;

function writeResponse(id: string, ok: boolean, payload: unknown): void {
  if (ok) {
    write({ type: "res", id, ok: true, payload });
  } else {
    write({ type: "res", id, ok: false, error: String(payload) });
  }
}

// ── Event Bus ─────────────────────────────────────────────────

type EventHandler = (event: GatewayEvent) => void | Promise<void>;
const eventHandlers = new Map<string, Set<EventHandler>>();

function matchesPattern(eventType: string, pattern: string): boolean {
  if (pattern === "*") return true;
  if (pattern === eventType) return true;
  if (pattern.endsWith(".*")) {
    const prefix = pattern.slice(0, -2);
    return eventType.startsWith(prefix + ".");
  }
  return false;
}

async function broadcastToHandlers(event: GatewayEvent): Promise<void> {
  const handlers: EventHandler[] = [];
  for (const [pattern, handlerSet] of eventHandlers) {
    if (matchesPattern(event.type, pattern)) {
      handlers.push(...handlerSet);
    }
  }
  await Promise.all(handlers.map((h) => h(event)));
}

// ── Extension Loading ─────────────────────────────────────────

/**
 * Find the factory function in a module.
 * Looks for exports matching `createXxxExtension` or a default export.
 */
function findFactory(
  mod: Record<string, unknown>,
): ((config: Record<string, unknown>) => ClaudiaExtension) | null {
  // Check for createXxxExtension pattern
  for (const [key, value] of Object.entries(mod)) {
    if (key.startsWith("create") && key.endsWith("Extension") && typeof value === "function") {
      return value as (config: Record<string, unknown>) => ClaudiaExtension;
    }
  }
  // Check default export
  if (typeof mod.default === "function") {
    return mod.default as (config: Record<string, unknown>) => ClaudiaExtension;
  }
  return null;
}

let extension: ClaudiaExtension | null = null;

async function loadAndStart(): Promise<ClaudiaExtension> {
  hostLog.info("Loading extension", { module: moduleSpec });

  const mod = await import(moduleSpec);
  const factory = findFactory(mod);
  if (!factory) {
    throw new Error(
      `No factory function found in ${moduleSpec}. Expected export matching createXxxExtension.`,
    );
  }

  const config = JSON.parse(configJson);
  const ext = factory(config);

  hostLog.info("Creating context", { id: ext.id, name: ext.name });

  // Create extension context — bridges events to/from stdio
  const ctx: ExtensionContext = {
    on(pattern: string, handler: EventHandler): () => void {
      if (!eventHandlers.has(pattern)) {
        eventHandlers.set(pattern, new Set());
      }
      eventHandlers.get(pattern)!.add(handler);
      return () => {
        eventHandlers.get(pattern)?.delete(handler);
      };
    },

    emit(type: string, payload: unknown, options?: { source?: string }): void {
      writeEvent(type, payload, options);
    },

    async call(method: string, params?: Record<string, unknown>): Promise<unknown> {
      const id = randomUUID();
      // Calculate remaining deadline budget
      const now = Date.now();
      let deadlineMs = currentDeadlineMs;
      if (!deadlineMs) {
        deadlineMs = now + CALL_TIMEOUT;
      }
      const remaining = deadlineMs - now;
      if (remaining <= 0) {
        throw new Error(`Call deadline exceeded before sending ${method}`);
      }

      return new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => {
            pendingCalls.delete(id);
            reject(
              new Error(
                `ctx.call(${method}) timed out after ${Math.min(remaining, CALL_TIMEOUT)}ms`,
              ),
            );
          },
          Math.min(remaining, CALL_TIMEOUT),
        );

        pendingCalls.set(id, { resolve, reject, timer });

        write({
          type: "call",
          id,
          method,
          params: params ?? {},
          connectionId: currentConnectionId,
          traceId: currentTraceId || randomUUID(),
          depth: currentDepth + 1,
          deadlineMs,
        });
      });
    },

    get connectionId(): string | null {
      return currentConnectionId;
    },

    config,

    log: createLogger(ext.id, join(homedir(), ".claudia", "logs", `${ext.id}.log`)),
  };

  await ext.start(ctx);

  hostLog.info("Extension started", { id: ext.id });

  // Send registration message — tells gateway what we provide
  // Serialize method definitions without Zod schemas (can't send functions over stdio)
  const methods = ext.methods.map((m) => ({
    name: m.name,
    description: m.description,
    // Convert Zod schema to JSON schema for gateway-side validation
    inputSchema: m.inputSchema._def,
  }));

  write({
    type: "register",
    extension: {
      id: ext.id,
      name: ext.name,
      methods,
      events: ext.events,
      sourceRoutes: ext.sourceRoutes || [],
    },
  });

  return ext;
}

// ── Stdin Reading ─────────────────────────────────────────────
// Use Node.js process.stdin (data events) instead of Bun.stdin.stream()
// to avoid ReadableStream lock issues with bun --hot.
//
// IMPORTANT: Only attach listeners once — they persist across HMR reloads
// since process.stdin is the same object. We track this via import.meta.hot.data
// which survives across HMR cycles (unlike module-level variables which re-init).

const stdinAlreadyBound = import.meta.hot?.data?.stdinBound === true;

function readStdin(): void {
  if (stdinAlreadyBound) {
    hostLog.info("Stdin already bound, skipping listener setup (HMR reload)");
    return;
  }
  // Persist flag across HMR reloads
  if (import.meta.hot) {
    import.meta.hot.data.stdinBound = true;
  }

  let buffer = "";

  process.stdin.setEncoding("utf-8");
  process.stdin.on("data", async (chunk: string) => {
    buffer += chunk;

    let newlineIndex: number;
    while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);

      if (line.length > 0) {
        await handleMessage(line);
      }
    }
  });

  process.stdin.on("end", async () => {
    hostLog.info("Stdin closed, shutting down");
    if (extension) {
      await extension.stop();
    }
    process.exit(0);
  });

  process.stdin.on("error", (error: Error) => {
    hostLog.error("Stdin error", { error: String(error) });
  });

  process.stdin.resume();
}

async function handleMessage(line: string): Promise<void> {
  let msg: Record<string, unknown>;
  try {
    msg = JSON.parse(line);
  } catch {
    hostLog.warn("Invalid JSON on stdin", { line: line.slice(0, 100) });
    return;
  }

  if (msg.type === "req") {
    const id = msg.id as string;
    const method = msg.method as string;
    const params = (msg.params as Record<string, unknown>) || {};

    // Set per-request context from envelope
    const prevConnectionId = currentConnectionId;
    const prevTraceId = currentTraceId;
    const prevDepth = currentDepth;
    const prevDeadlineMs = currentDeadlineMs;
    currentConnectionId = (msg.connectionId as string) || null;
    currentTraceId = (msg.traceId as string) || null;
    currentDepth = (msg.depth as number) || 0;
    currentDeadlineMs = (msg.deadlineMs as number) || null;

    if (!extension) {
      writeResponse(id, false, "Extension not loaded");
      // Restore context
      currentConnectionId = prevConnectionId;
      currentTraceId = prevTraceId;
      currentDepth = prevDepth;
      currentDeadlineMs = prevDeadlineMs;
      return;
    }

    // Special internal methods
    if (method === "__health") {
      writeResponse(id, true, extension.health());
      currentConnectionId = prevConnectionId;
      currentTraceId = prevTraceId;
      currentDepth = prevDepth;
      currentDeadlineMs = prevDeadlineMs;
      return;
    }

    if (method === "__sourceResponse") {
      const source = params.source as string;
      const event = params.event as GatewayEvent;
      if (extension.handleSourceResponse) {
        try {
          await extension.handleSourceResponse(source, event);
          writeResponse(id, true, { status: "ok" });
        } catch (error) {
          writeResponse(id, false, String(error));
        }
      } else {
        writeResponse(id, false, "Extension does not handle source responses");
      }
      currentConnectionId = prevConnectionId;
      currentTraceId = prevTraceId;
      currentDepth = prevDepth;
      currentDeadlineMs = prevDeadlineMs;
      return;
    }

    // Regular method call — connectionId is in ctx, not params
    try {
      const result = await extension.handleMethod(method, params);
      writeResponse(id, true, result);
    } catch (error) {
      writeResponse(id, false, String(error));
    }

    // Restore context after handling
    currentConnectionId = prevConnectionId;
    currentTraceId = prevTraceId;
    currentDepth = prevDepth;
    currentDeadlineMs = prevDeadlineMs;
  } else if (msg.type === "call_res") {
    // Response to a ctx.call() we made
    const id = msg.id as string;
    const pending = pendingCalls.get(id);
    if (pending) {
      clearTimeout(pending.timer);
      pendingCalls.delete(id);
      if (msg.ok) {
        pending.resolve(msg.payload);
      } else {
        pending.reject(new Error(msg.error as string));
      }
    }
  } else if (msg.type === "event") {
    // Gateway is forwarding an event — broadcast to extension's handlers
    const event: GatewayEvent = {
      type: msg.event as string,
      payload: msg.payload,
      timestamp: Date.now(),
      origin: msg.origin as string | undefined,
      source: msg.source as string | undefined,
      sessionId: msg.sessionId as string | undefined,
      connectionId: msg.connectionId as string | undefined,
    };
    await broadcastToHandlers(event);
  }
}

// ── Main ──────────────────────────────────────────────────────

try {
  extension = await loadAndStart();
  readStdin(); // Don't await — runs as long-lived loop
} catch (error) {
  hostLog.error("Failed to start extension", { module: moduleSpec, error: String(error) });
  write({ type: "error", error: String(error) });
  process.exit(1);
}

// ── HMR ───────────────────────────────────────────────────────

if (import.meta.hot) {
  import.meta.hot.dispose(async () => {
    hostLog.info("HMR: disposing extension", { id: extension?.id });
    if (extension) {
      await extension.stop();
      extension = null;
    }
    // Clear event handlers so re-registration starts fresh
    eventHandlers.clear();
    // Reject pending calls
    for (const [id, pending] of pendingCalls) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Extension host reloading (HMR)"));
      pendingCalls.delete(id);
    }
    // Stop parent liveness check — a new one will be created on reload
    clearInterval(parentCheckInterval);
    // NOTE: stdinBound stays true in import.meta.hot.data so listeners
    // aren't re-attached. The existing stdin listeners will route messages
    // to the new extension instance via the module-level `extension` var.
  });
}
