import { describe, expect, it } from "bun:test";
import { z } from "zod";
import { ExtensionManager } from "./extensions";
import type { ClaudiaExtension, ExtensionContext, GatewayEvent } from "@claudia/shared";

function createListenerExtension(
  id: string,
  pattern: string,
  sink: GatewayEvent[],
): ClaudiaExtension {
  return {
    id,
    name: `Listener ${id}`,
    methods: [
      {
        name: `${id}.noop`,
        description: "No-op",
        inputSchema: z.object({}),
      },
    ],
    events: [],
    async start(ctx: ExtensionContext) {
      ctx.on(pattern, (event) => {
        sink.push(event);
      });
    },
    async stop() {},
    async handleMethod() {
      return { ok: true };
    },
    health() {
      return { ok: true };
    },
  };
}

describe("ExtensionManager integration", () => {
  it("broadcasts events to matching subscriptions", async () => {
    const manager = new ExtensionManager();

    const allEvents: GatewayEvent[] = [];
    const voiceEvents: GatewayEvent[] = [];

    await manager.register(createListenerExtension("all", "*", allEvents));
    await manager.register(createListenerExtension("voice", "voice.*", voiceEvents));

    await manager.broadcast({
      type: "voice.audio",
      payload: { chunk: 1 },
      timestamp: Date.now(),
      origin: "extension:voice",
    });

    await manager.broadcast({
      type: "session.message_stop",
      payload: {},
      timestamp: Date.now(),
      origin: "session",
    });

    expect(allEvents).toHaveLength(2);
    expect(voiceEvents).toHaveLength(1);
    expect(voiceEvents[0]?.type).toBe("voice.audio");
  });
});
