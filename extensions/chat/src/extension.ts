/**
 * Chat Extension — Server-Side
 *
 * Provides health check and session management methods for Mission Control.
 * Fetches runtime health data and formats it as standardized HealthCheckResponse.
 */

import type {
  ClaudiaExtension,
  ExtensionContext,
  HealthCheckResponse,
  HealthItem,
} from "@claudia/shared";
import { loadConfig } from "@claudia/shared";

interface RuntimeSessionInfo {
  id: string;
  cwd: string;
  model: string;
  isActive: boolean;
  isProcessRunning: boolean;
  createdAt?: string;
  lastActivity?: string;
  healthy?: boolean;
  stale?: boolean;
}

interface RuntimeHealth {
  status: string;
  clients: number;
  sessions: RuntimeSessionInfo[];
}

export function createChatExtension(): ClaudiaExtension {
  let ctx: ExtensionContext | null = null;
  const config = loadConfig();
  const runtimePort = config.runtime?.port || 30087;

  async function fetchRuntimeHealth(): Promise<RuntimeHealth | null> {
    try {
      const res = await fetch(`http://localhost:${runtimePort}/health`);
      return (await res.json()) as RuntimeHealth;
    } catch {
      return null;
    }
  }

  function formatRelativeTime(isoString?: string): string {
    if (!isoString) return "unknown";
    const ms = Date.now() - new Date(isoString).getTime();
    if (ms < 60_000) return `${Math.round(ms / 1000)}s ago`;
    if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`;
    return `${Math.round(ms / 3_600_000)}h ago`;
  }

  return {
    id: "chat",
    name: "Chat Sessions",
    methods: [
      "chat.health-check",
      "chat.kill-session",
      "chat.kill-all-sessions",
    ],
    events: [],

    async start(context: ExtensionContext) {
      ctx = context;
      ctx.log.info("Chat extension started (health check + session management)");
    },

    async stop() {
      ctx = null;
    },

    async handleMethod(method: string, params: Record<string, unknown>) {
      switch (method) {
        case "chat.health-check": {
          const runtime = await fetchRuntimeHealth();

          const items: HealthItem[] = (runtime?.sessions || []).map((s) => ({
            id: s.id,
            label: s.cwd.replace(/^\/Users\/\w+/, "~"),
            status: !s.isProcessRunning
              ? "dead"
              : !s.healthy
                ? "dead"
                : s.isActive
                  ? "healthy"
                  : "inactive",
            details: {
              model: s.model,
              started: formatRelativeTime(s.createdAt),
              lastActivity: formatRelativeTime(s.lastActivity),
            },
          }));

          const activeCount = items.filter(
            (i) => i.status === "healthy" || i.status === "stale",
          ).length;

          const response: HealthCheckResponse = {
            ok: runtime !== null,
            status: runtime ? "healthy" : "disconnected",
            label: "Chat Sessions",
            metrics: [
              { label: "Active Sessions", value: activeCount },
              {
                label: "Runtime",
                value: runtime ? "connected" : "disconnected",
              },
            ],
            actions: [
              {
                method: "chat.kill-session",
                label: "Kill",
                confirm: "Kill this Claude process?",
                params: [{ name: "sessionId", source: "item.id" }],
                scope: "item",
              },
              {
                method: "chat.kill-all-sessions",
                label: "Kill All",
                confirm: "Kill all Claude processes?",
                params: [],
                scope: "global",
              },
            ],
            items,
          };
          return response;
        }

        case "chat.kill-session": {
          const sessionId = params.sessionId as string;
          if (!sessionId) throw new Error("Missing sessionId parameter");

          try {
            const res = await fetch(
              `http://localhost:${runtimePort}/session/${sessionId}`,
              { method: "DELETE" },
            );
            const result = await res.json();
            ctx?.log.info(`Killed session: ${sessionId}`);
            return result;
          } catch (error) {
            const msg =
              error instanceof Error ? error.message : "Unknown error";
            throw new Error(`Failed to kill session: ${msg}`);
          }
        }

        case "chat.kill-all-sessions": {
          const runtime = await fetchRuntimeHealth();
          if (!runtime?.sessions.length) {
            return { status: "no_sessions" };
          }

          const results = await Promise.allSettled(
            runtime.sessions.map((s) =>
              fetch(`http://localhost:${runtimePort}/session/${s.id}`, {
                method: "DELETE",
              }),
            ),
          );

          const killed = results.filter(
            (r) => r.status === "fulfilled",
          ).length;
          ctx?.log.info(`Killed ${killed}/${runtime.sessions.length} sessions`);
          return { status: "ok", killed, total: runtime.sessions.length };
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

export default createChatExtension;
