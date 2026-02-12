/**
 * Mission Control Extension — Server-Side
 *
 * Minimal server-side component. Mission Control is primarily a UI extension
 * that discovers and renders health data from other extensions.
 */

import { z } from "zod";
import type {
  ClaudiaExtension,
  ExtensionContext,
  HealthCheckResponse,
} from "@claudia/shared";

export function createMissionControlExtension(): ClaudiaExtension {
  let ctx: ExtensionContext | null = null;

  return {
    id: "mission-control",
    name: "Mission Control",
    methods: [
      {
        name: "mission-control.health-check",
        description:
          "Return standardized health-check payload for Mission Control extension",
        inputSchema: z.object({}),
      },
    ],
    events: [],

    async start(context: ExtensionContext) {
      ctx = context;
      ctx.log.info("Mission Control extension started");
    },

    async stop() {
      ctx = null;
    },

    async handleMethod(method: string) {
      if (method === "mission-control.health-check") {
        const response: HealthCheckResponse = {
          ok: true,
          status: "healthy",
          label: "Mission Control",
          metrics: [
            { label: "Server Extension", value: "loaded" },
            { label: "UI Route", value: "/mission-control" },
          ],
        };
        return response;
      }
      throw new Error(`Unknown method: ${method}`);
    },

    health() {
      return { ok: true };
    },
  };
}

export default createMissionControlExtension;
