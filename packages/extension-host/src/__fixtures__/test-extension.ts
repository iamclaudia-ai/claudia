import { z } from "zod";
import type { ClaudiaExtension, ExtensionContext, GatewayEvent } from "@claudia/shared";
import { runExtensionHost } from "../index";

function createFixtureExtension(): ClaudiaExtension {
  let ctx: ExtensionContext | null = null;

  return {
    id: "fixture",
    name: "Fixture Extension",
    methods: [
      {
        name: "fixture.echo",
        description: "Echo params with current request envelope context",
        inputSchema: z.object({ value: z.string().optional() }),
      },
      {
        name: "fixture.emit_context",
        description: "Emit an event without overrides (uses ambient request context)",
        inputSchema: z.object({}),
      },
      {
        name: "fixture.call_through",
        description: "Make a ctx.call and return the response",
        inputSchema: z.object({}),
      },
      {
        name: "fixture.fail",
        description: "Throw an error for protocol error-path testing",
        inputSchema: z.object({}),
      },
    ],
    events: ["fixture.*"],
    sourceRoutes: ["fixture-src"],
    async start(extCtx: ExtensionContext) {
      ctx = extCtx;
      ctx.on("trigger.call", async () => {
        await ctx!.call("from.event", { via: "event" });
        ctx!.emit("fixture.after_event", { ok: true });
      });
    },
    async stop() {
      ctx = null;
    },
    async handleMethod(method: string, params: Record<string, unknown>) {
      if (method === "fixture.echo") {
        return {
          params,
          connectionId: ctx?.connectionId ?? null,
          tags: ctx?.tags ?? null,
        };
      }
      if (method === "fixture.emit_context") {
        ctx?.emit("fixture.context", { ok: true });
        return { ok: true };
      }
      if (method === "fixture.call_through") {
        return await ctx!.call("session.send_prompt", { content: "ping" });
      }
      if (method === "fixture.fail") {
        throw new Error("fixture boom");
      }
      throw new Error(`Unknown method: ${method}`);
    },
    async handleSourceResponse(source: string, event: GatewayEvent) {
      ctx?.emit("fixture.routed", { source, type: event.type });
    },
    health() {
      return { ok: true, details: { fixture: true } };
    },
  };
}

if (import.meta.main) {
  runExtensionHost(() => createFixtureExtension());
}
