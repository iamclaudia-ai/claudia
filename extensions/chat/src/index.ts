/**
 * Chat Extension — Server-Side
 *
 * Provides chat/runtime health status for Mission Control.
 * Proxies health data from the session extension via ctx.call().
 */

import type { ClaudiaExtension, ExtensionContext, HealthCheckResponse } from "@claudia/shared";
import { z } from "zod";

export function createChatExtension(): ClaudiaExtension {
  let ctx: ExtensionContext | null = null;

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
          try {
            const result = await ctx!.call("session.health-check");
            return result;
          } catch {
            return {
              ok: false,
              status: "disconnected",
              label: "Chat Sessions",
              metrics: [{ label: "Status", value: "disconnected" }],
            } satisfies HealthCheckResponse;
          }
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
