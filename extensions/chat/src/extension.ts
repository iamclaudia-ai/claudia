/**
 * Chat Extension — Server-Side
 *
 * Provides chat/runtime health status for Mission Control.
 */

import type {
  ClaudiaExtension,
  ExtensionContext,
  HealthCheckResponse,
  HealthItem,
} from "@claudia/shared";
import { loadConfig } from "@claudia/shared";
import { z } from "zod";

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
      {
        name: "chat.health-check",
        description: "Return chat/runtime health status for Mission Control",
        inputSchema: z.object({}),
      },
    ],
    events: [],

    async start(context: ExtensionContext) {
      ctx = context;
      ctx.log.info("Chat extension started (health check)");
    },

    async stop() {
      ctx = null;
    },

    async handleMethod(method: string) {
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
            items,
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

export default createChatExtension;
