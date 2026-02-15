/**
 * Hooks Extension
 *
 * Loads lightweight hook scripts from ~/.claudia/hooks/ and from the active
 * workspace at <workspace>/.claudia/hooks, subscribes to their declared events,
 * and dispatches to handlers.
 * Hook output is emitted as hook.{hookId}.{event} for the UI to render.
 */

import { z } from "zod";
import { readdirSync, existsSync } from "node:fs";
import { join, basename } from "node:path";
import { homedir } from "node:os";
import type {
  ClaudiaExtension,
  ExtensionContext,
  GatewayEvent,
  HookDefinition,
  HookContext,
  HealthCheckResponse,
} from "@claudia/shared";

const DEFAULT_WORKSPACE_RESCAN_MS = 10_000;

export interface HooksConfig {
  /** Additional global hooks directories to scan (beyond defaults) */
  extraDirs?: string[];
  /** Minimum interval before re-scanning the same workspace hooks dir */
  workspaceRescanMs?: number;
}

interface LoadedHook {
  id: string;
  definition: HookDefinition;
  events: string[];
  sourcePath: string;
}

function normalizeEventPatterns(events: string[]): string[] {
  const unique = Array.from(new Set(events.filter(Boolean)));
  const exact = unique.filter((p) => p !== "*" && !p.endsWith(".*"));
  const prefixWildcards = unique.filter((p) => p.endsWith(".*"));
  const catchAll = unique.filter((p) => p === "*");
  return [...exact, ...prefixWildcards, ...catchAll];
}

function matchesPattern(eventType: string, pattern: string): boolean {
  if (pattern === "*") return true;
  if (pattern === eventType) return true;
  if (pattern.endsWith(".*")) {
    const prefix = pattern.slice(0, -2);
    return eventType.startsWith(`${prefix}.`);
  }
  return false;
}

function extractWorkspaceCwd(event: GatewayEvent): string | null {
  const payload =
    event.payload && typeof event.payload === "object"
      ? (event.payload as Record<string, unknown>)
      : null;

  if (typeof payload?.cwd === "string") {
    return payload.cwd;
  }

  const workspace =
    payload?.workspace && typeof payload.workspace === "object"
      ? (payload.workspace as Record<string, unknown>)
      : null;

  if (typeof workspace?.cwd === "string") {
    return workspace.cwd;
  }

  return null;
}

export function createHooksExtension(config: HooksConfig = {}): ClaudiaExtension {
  let ctx: ExtensionContext | null = null;

  // Global hooks (~/.claudia/hooks and config.extraDirs)
  const globalHooks = new Map<string, LoadedHook>();
  // Workspace hooks (<workspace>/.claudia/hooks)
  const workspaceHooks = new Map<string, LoadedHook>();
  // Active hooks after precedence merge (workspace overrides global by id)
  const hooks: LoadedHook[] = [];

  const unsubscribers: Array<() => void> = [];

  let currentWorkspaceCwd: string | null = null;
  let currentWorkspaceHooksDir: string | null = null;
  let currentSessionId: string | null = null;
  let lastWorkspaceScanAt = 0;

  const workspaceRescanMs = Math.max(0, config.workspaceRescanMs ?? DEFAULT_WORKSPACE_RESCAN_MS);

  function rebuildActiveHooks(): void {
    const merged = new Map<string, LoadedHook>();

    for (const [id, hook] of globalHooks) {
      merged.set(id, hook);
    }

    for (const [id, hook] of workspaceHooks) {
      merged.set(id, hook);
    }

    hooks.length = 0;
    hooks.push(...merged.values());
  }

  /**
   * Scan a directory for hook files and load them into a target map.
   * Later loads override same hook IDs within the same target map.
   */
  async function loadHooksFromDir(
    dir: string,
    target: Map<string, LoadedHook>,
    scope: "global" | "workspace",
  ): Promise<void> {
    if (!existsSync(dir)) {
      ctx?.log.info(`Hook scan skipped (missing ${scope} dir): ${dir}`);
      return;
    }

    ctx?.log.info(`Scanning ${scope} hooks dir: ${dir}`);

    const files = readdirSync(dir).filter((f) => f.endsWith(".ts") || f.endsWith(".js"));

    for (const file of files) {
      const hookId = basename(file, file.endsWith(".ts") ? ".ts" : ".js");
      const fullPath = join(dir, file);

      try {
        const mod = await import(fullPath);
        const definition: HookDefinition = mod.default;

        if (!definition?.handler || !definition?.event) {
          ctx?.log.warn(`Skipping invalid hook: ${hookId} (missing handler or event)`);
          continue;
        }

        const events = normalizeEventPatterns(
          Array.isArray(definition.event) ? definition.event : [definition.event],
        );

        const loaded: LoadedHook = {
          id: hookId,
          definition,
          events,
          sourcePath: fullPath,
        };

        const previous = target.get(hookId);
        if (previous) {
          ctx?.log.info(`Overriding hook: ${hookId}`, {
            previous: previous.sourcePath,
            next: fullPath,
            scope,
          });
        } else {
          ctx?.log.info(`Loaded hook: ${hookId} (events: ${events.join(", ")})`, {
            scope,
            path: fullPath,
          });
        }

        target.set(hookId, loaded);
      } catch (error) {
        ctx?.log.error(`Failed to load hook: ${hookId}`, error);
      }
    }
  }

  async function loadGlobalHooks(): Promise<void> {
    globalHooks.clear();

    const globalDirs = [join(homedir(), ".claudia", "hooks"), ...(config.extraDirs || [])];
    ctx?.log.info(`Loading global hooks from: ${globalDirs.join(", ")}`);

    for (const dir of globalDirs) {
      await loadHooksFromDir(dir, globalHooks, "global");
    }

    rebuildActiveHooks();
  }

  async function loadWorkspaceHooks(cwd: string | null): Promise<void> {
    const workspaceHooksDir = cwd ? join(cwd, ".claudia", "hooks") : null;

    if (!workspaceHooksDir) {
      if (currentWorkspaceHooksDir) {
        ctx?.log.info("Clearing workspace hooks (no workspace cwd available)");
      }
      workspaceHooks.clear();
      currentWorkspaceHooksDir = null;
      lastWorkspaceScanAt = 0;
      rebuildActiveHooks();
      return;
    }

    const now = Date.now();
    const sameDir = workspaceHooksDir === currentWorkspaceHooksDir;
    const shouldRescan = !sameDir || now - lastWorkspaceScanAt >= workspaceRescanMs;

    if (!shouldRescan) {
      return;
    }

    ctx?.log.info(`Loading workspace hooks from: ${workspaceHooksDir}`);

    workspaceHooks.clear();
    await loadHooksFromDir(workspaceHooksDir, workspaceHooks, "workspace");

    currentWorkspaceHooksDir = workspaceHooksDir;
    lastWorkspaceScanAt = now;
    rebuildActiveHooks();

    ctx?.log.info(`Loaded ${workspaceHooks.size} workspace hook(s) for cwd: ${cwd}`);
  }

  /**
   * Create a HookContext for a specific hook.
   */
  function createHookContext(hookId: string): HookContext {
    return {
      emit(event: string, payload: unknown) {
        ctx?.emit(`hook.${hookId}.${event}`, payload);
      },
      workspace: currentWorkspaceCwd ? { cwd: currentWorkspaceCwd } : null,
      sessionId: currentSessionId,
      log: {
        info: (msg, meta) => ctx?.log.info(`[${hookId}] ${msg}`, meta),
        warn: (msg, meta) => ctx?.log.warn(`[${hookId}] ${msg}`, meta),
        error: (msg, meta) => ctx?.log.error(`[${hookId}] ${msg}`, meta),
      },
    };
  }

  /**
   * Dispatch an event to all hooks with first-match semantics per hook.
   */
  async function dispatchEvent(event: GatewayEvent): Promise<void> {
    if (event.sessionId) {
      currentSessionId = event.sessionId;
    }

    const workspaceCwd = extractWorkspaceCwd(event);
    if (workspaceCwd) {
      currentWorkspaceCwd = workspaceCwd;
      await loadWorkspaceHooks(currentWorkspaceCwd);
    }

    for (const hook of hooks) {
      const matched = hook.events.find((pattern) => matchesPattern(event.type, pattern));
      if (!matched) continue;

      try {
        await hook.definition.handler(createHookContext(hook.id), event.payload);
      } catch (error) {
        ctx?.log.error(`Hook ${hook.id} failed on ${event.type}`, error);
      }
    }
  }

  return {
    id: "hooks",
    name: "Hooks",
    methods: [
      {
        name: "hooks.health-check",
        description: "Return health status of the hooks extension",
        inputSchema: z.object({}),
      },
      {
        name: "hooks.list",
        description: "List loaded hooks and their subscribed events",
        inputSchema: z.object({}),
      },
    ],
    events: [
      "hook.*", // All hook output events
    ],

    async start(context: ExtensionContext) {
      ctx = context;
      currentWorkspaceCwd = null;
      currentWorkspaceHooksDir = null;
      currentSessionId = null;
      lastWorkspaceScanAt = 0;

      await loadGlobalHooks();

      ctx.log.info(`Loaded ${hooks.length} hook(s)`);

      // Subscribe once and match patterns inside dispatchEvent().
      // This prevents duplicate executions when exact + wildcard patterns overlap.
      const unsub = ctx.on("*", (gatewayEvent) => {
        void dispatchEvent(gatewayEvent);
      });
      unsubscribers.push(unsub);
    },

    async stop() {
      for (const unsub of unsubscribers) {
        unsub();
      }
      unsubscribers.length = 0;
      hooks.length = 0;
      globalHooks.clear();
      workspaceHooks.clear();
      currentWorkspaceCwd = null;
      currentWorkspaceHooksDir = null;
      currentSessionId = null;
      lastWorkspaceScanAt = 0;
      ctx = null;
    },

    async handleMethod(method: string, _params: Record<string, unknown>) {
      switch (method) {
        case "hooks.health-check": {
          const response: HealthCheckResponse = {
            ok: true,
            status: hooks.length > 0 ? "healthy" : "degraded",
            label: "Hooks",
            metrics: [
              { label: "Loaded", value: hooks.length },
              { label: "Hooks", value: hooks.map((h) => h.id).join(", ") || "none" },
            ],
          };
          return response;
        }

        case "hooks.list": {
          return {
            hooks: hooks.map((h) => ({
              id: h.id,
              events: h.events,
              description: h.definition.description,
            })),
          };
        }

        default:
          throw new Error(`Unknown method: ${method}`);
      }
    },

    health() {
      return {
        ok: true,
        details: {
          hookCount: hooks.length,
          hooks: hooks.map((h) => h.id),
        },
      };
    },
  };
}

export default createHooksExtension;
