import { z } from "zod";
import type { ClaudiaExtension, ExtensionContext } from "@claudia/shared";
import { runExtensionHost } from "@claudia/extension-host";

function createTestRouteExtension(): ClaudiaExtension {
  let ctx: ExtensionContext;

  return {
    id: "testroute",
    name: "Test Route Extension",
    methods: [
      {
        name: "testroute.emit_public",
        description: "Emit a public test event",
        inputSchema: z.object({ message: z.string().default("public") }),
      },
      {
        name: "testroute.emit_targeted",
        description: "Emit a gateway.caller-scoped test event",
        inputSchema: z.object({ message: z.string().default("targeted") }),
      },
    ],
    events: ["testroute.*"],
    sourceRoutes: [],
    async start(extCtx: ExtensionContext) {
      ctx = extCtx;
    },
    async stop() {},
    async handleMethod(method: string, params: Record<string, unknown>): Promise<unknown> {
      if (method === "testroute.emit_public") {
        ctx.emit("testroute.event", { message: params.message ?? "public" });
        return { ok: true };
      }
      if (method === "testroute.emit_targeted") {
        ctx.emit(
          "testroute.event",
          { message: params.message ?? "targeted" },
          { source: "gateway.caller" },
        );
        return { ok: true };
      }
      throw new Error(`Unknown method: ${method}`);
    },
    health() {
      return { ok: true };
    },
  };
}

if (import.meta.main) {
  runExtensionHost(() => createTestRouteExtension());
}
