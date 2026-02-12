import { describe, expect, it } from "bun:test";
import { z } from "zod";
import { ExtensionManager } from "./extensions";
import type { ClaudiaExtension, ExtensionContext, GatewayEvent } from "@claudia/shared";

function createTestExtension(overrides: Partial<ClaudiaExtension> = {}): ClaudiaExtension {
  let ctx: ExtensionContext | null = null;

  return {
    id: "test",
    name: "Test Extension",
    methods: [
      {
        name: "test.echo",
        description: "Echo text",
        inputSchema: z.object({ text: z.string().min(1) }),
      },
    ],
    events: ["test.event"],
    sourceRoutes: ["testsrc"],
    async start(context: ExtensionContext): Promise<void> {
      ctx = context;
      ctx.log.info("started");
    },
    async stop(): Promise<void> {
      ctx = null;
    },
    async handleMethod(_method: string, params: Record<string, unknown>): Promise<unknown> {
      return { echoed: params.text };
    },
    async handleSourceResponse(_source: string, event: GatewayEvent): Promise<void> {
      ctx?.emit("test.routed", event.payload);
    },
    health() {
      return { ok: true, details: { alive: true } };
    },
    ...overrides,
  };
}

describe("ExtensionManager", () => {
  it("registers extension and exposes methods", async () => {
    const manager = new ExtensionManager();
    const ext = createTestExtension();

    await manager.register(ext);

    expect(manager.hasMethod("test.echo")).toBe(true);
    expect(manager.getExtensionList()).toEqual([
      {
        id: "test",
        name: "Test Extension",
        methods: ["test.echo"],
      },
    ]);

    const defs = manager.getMethodDefinitions();
    expect(defs).toHaveLength(1);
    expect(defs[0]?.method.name).toBe("test.echo");
  });

  it("validates params before invoking extension", async () => {
    const manager = new ExtensionManager();
    await manager.register(createTestExtension());

    await expect(manager.handleMethod("test.echo", { text: "hello" })).resolves.toEqual({
      echoed: "hello",
    });

    await expect(manager.handleMethod("test.echo", {})).rejects.toThrow(
      "Invalid params for test.echo: text: Required",
    );
  });

  it("routes source responses by prefix", async () => {
    const manager = new ExtensionManager();
    let emitted = false;
    manager.setEmitCallback((type) => {
      if (type === "test.routed") emitted = true;
    });
    await manager.register(createTestExtension());

    const routed = await manager.routeToSource("testsrc/abc", {
      type: "session.message_stop",
      payload: { ok: true },
      timestamp: Date.now(),
    });

    expect(routed).toBe(true);
    expect(emitted).toBe(true);
    expect(manager.hasSourceRoute("testsrc/abc")).toBe(true);
    expect(manager.getSourceHandler("testsrc/abc")).toBe("test");
  });

  it("returns false when no source route exists", async () => {
    const manager = new ExtensionManager();
    await manager.register(createTestExtension());

    const routed = await manager.routeToSource("unknown/abc", {
      type: "session.message_stop",
      payload: {},
      timestamp: Date.now(),
    });

    expect(routed).toBe(false);
  });
});
