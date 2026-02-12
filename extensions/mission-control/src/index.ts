/**
 * Mission Control Extension — Server-Side
 *
 * Minimal server-side component. Mission Control is primarily a UI extension
 * that discovers and renders health data from other extensions.
 */

import type { ClaudiaExtension, ExtensionContext } from "@claudia/shared";

export function createMissionControlExtension(): ClaudiaExtension {
  let ctx: ExtensionContext | null = null;

  return {
    id: "mission-control",
    name: "Mission Control",
    methods: [],
    events: [],

    async start(context: ExtensionContext) {
      ctx = context;
      ctx.log.info("Mission Control extension started");
    },

    async stop() {
      ctx = null;
    },

    async handleMethod() {
      return {};
    },

    health() {
      return { ok: true };
    },
  };
}

export default createMissionControlExtension;
