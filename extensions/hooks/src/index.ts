/**
 * Hooks Extension
 *
 * Loads lightweight hook scripts from ~/.claudia/hooks/ and ./hooks/,
 * subscribes to their declared events, and dispatches to handlers.
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

export interface HooksConfig {
  /** Additional hooks directories to scan (beyond defaults) */
  extraDirs?: string[];
}

interface LoadedHook {
  id: string;
  definition: HookDefinition;
  events: string[];
}

export function createHooksExtension(config: HooksConfig = {}): ClaudiaExtension {
  let ctx: ExtensionContext | null = null;
  const hooks: LoadedHook[] = [];
  const unsubscribers: Array<() => void> = [];

  // Current session/workspace state (updated from events)
  // Default to process.cwd() since extension host runs in the project root
  let currentWorkspaceCwd: string | null = process.cwd();
  let currentSessionId: string | null = null;

  /**
   * Scan a directory for hook files and load them.
   */
  async function loadHooksFromDir(dir: string): Promise<void> {
    if (!existsSync(dir)) return;

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

        const events = Array.isArray(definition.event) ? definition.event : [definition.event];

        hooks.push({ id: hookId, definition, events });
        ctx?.log.info(`Loaded hook: ${hookId} (events: ${events.join(", ")})`);
      } catch (error) {
        ctx?.log.error(`Failed to load hook: ${hookId}`, error);
      }
    }
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
   * Dispatch an event to all hooks that subscribe to it.
   */
  async function dispatchEvent(eventType: string, event: GatewayEvent): Promise<void> {
    for (const hook of hooks) {
      if (!hook.events.includes(eventType)) continue;

      try {
        await hook.definition.handler(event.payload, createHookContext(hook.id));
      } catch (error) {
        ctx?.log.error(`Hook ${hook.id} failed on ${eventType}`, error);
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

      // Default hook directories: user-level then project-level
      const hooksDirs = [
        join(homedir(), ".claudia", "hooks"),
        join(process.cwd(), "hooks"),
        ...(config.extraDirs || []),
      ];

      ctx.log.info(`Loading hooks from: ${hooksDirs.join(", ")}`);

      for (const dir of hooksDirs) {
        await loadHooksFromDir(dir);
      }

      ctx.log.info(`Loaded ${hooks.length} hook(s)`);

      // Collect all unique events hooks care about
      const allEvents = new Set<string>();
      for (const hook of hooks) {
        for (const event of hook.events) {
          allEvents.add(event);
        }
      }

      // Subscribe to each event
      for (const event of allEvents) {
        const unsub = ctx.on(event, (gatewayEvent) => {
          dispatchEvent(event, gatewayEvent);
        });
        unsubscribers.push(unsub);
      }

      // Track workspace/session state from stream events
      const unsubSession = ctx.on("session.*", (event) => {
        if (event.sessionId) {
          currentSessionId = event.sessionId;
        }
      });
      unsubscribers.push(unsubSession);
    },

    async stop() {
      for (const unsub of unsubscribers) {
        unsub();
      }
      unsubscribers.length = 0;
      hooks.length = 0;
      ctx = null;
    },

    async handleMethod(method: string, params: Record<string, unknown>) {
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
