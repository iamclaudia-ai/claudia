import { describe, expect, it } from "bun:test";
import { z } from "zod";
import { ExtensionManager } from "./extensions";
import type { ClaudiaExtension, ExtensionContext, GatewayEvent } from "@claudia/shared";
import type { ExtensionHostProcess, ExtensionRegistration } from "./extension-host";

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

function createRemoteHostMock(overrides: Partial<ExtensionHostProcess> = {}): ExtensionHostProcess {
  const host = {
    async callMethod() {
      return { ok: true };
    },
    sendEvent() {},
    async routeToSource() {},
    isRunning() {
      return true;
    },
    async kill() {},
    forceKill() {},
  } as unknown as ExtensionHostProcess;

  return Object.assign(host, overrides);
}

function createRemoteRegistration(
  overrides: Partial<ExtensionRegistration> = {},
): ExtensionRegistration {
  return {
    id: "remote",
    name: "Remote Extension",
    methods: [{ name: "remote.echo", description: "Echo" }],
    events: [],
    sourceRoutes: ["remote-src"],
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

  it("passes emit envelope options from local extensions", async () => {
    const manager = new ExtensionManager();
    const emissions: Array<{
      type: string;
      payload: unknown;
      source: string;
      connectionId?: string;
      tags?: string[];
    }> = [];

    manager.setEmitCallback((type, payload, source, connectionId, tags) => {
      emissions.push({ type, payload, source, connectionId, tags });
    });

    await manager.register(
      createTestExtension({
        async handleMethod(_method, _params) {
          const ext = manager.getExtensions().find((e) => e.id === "test");
          expect(ext).toBeDefined();
          return { ok: true };
        },
        async start(context: ExtensionContext) {
          context.emit(
            "test.stream",
            { step: 1 },
            { source: "gateway:test", connectionId: "conn-1", tags: ["voice"] },
          );
        },
      }),
    );

    expect(emissions).toEqual([
      {
        type: "test.stream",
        payload: { step: 1 },
        source: "gateway:test",
        connectionId: "conn-1",
        tags: ["voice"],
      },
    ]);
  });

  it("delegates remote methods with connection and RPC metadata", async () => {
    const manager = new ExtensionManager();
    const calls: Array<{
      method: string;
      params: Record<string, unknown>;
      connectionId?: string;
      meta?: { traceId?: string; depth?: number; deadlineMs?: number; tags?: string[] };
    }> = [];
    const host = createRemoteHostMock({
      async callMethod(method, params, connectionId, meta) {
        calls.push({
          method: method as string,
          params: params as Record<string, unknown>,
          connectionId: connectionId as string | undefined,
          meta: meta as { traceId?: string; depth?: number; deadlineMs?: number; tags?: string[] },
        });
        return { remote: true };
      },
    });
    manager.registerRemote(createRemoteRegistration(), host);

    const result = await manager.handleMethod(
      "remote.echo",
      { text: "hi" },
      "conn-a",
      { traceId: "trace-1", depth: 2, deadlineMs: 12345 },
      ["voice", "streaming"],
    );

    expect(result).toEqual({ remote: true });
    expect(calls).toEqual([
      {
        method: "remote.echo",
        params: { text: "hi" },
        connectionId: "conn-a",
        meta: { traceId: "trace-1", depth: 2, deadlineMs: 12345, tags: ["voice", "streaming"] },
      },
    ]);
  });

  it("forwards broadcasts to remote hosts and honors skipExtensionId", async () => {
    const manager = new ExtensionManager();
    const seenByA: GatewayEvent[] = [];
    const seenByB: GatewayEvent[] = [];
    const hostA = createRemoteHostMock({
      sendEvent(event) {
        seenByA.push(event as GatewayEvent);
      },
    });
    const hostB = createRemoteHostMock({
      sendEvent(event) {
        seenByB.push(event as GatewayEvent);
      },
    });

    manager.registerRemote(
      createRemoteRegistration({
        id: "remoteA",
        methods: [{ name: "remoteA.echo", description: "" }],
      }),
      hostA,
    );
    manager.registerRemote(
      createRemoteRegistration({
        id: "remoteB",
        methods: [{ name: "remoteB.echo", description: "" }],
      }),
      hostB,
    );

    const event: GatewayEvent = {
      type: "voice.audio",
      payload: { chunk: 1 },
      timestamp: Date.now(),
    };
    await manager.broadcast(event, "remoteA");

    expect(seenByA).toHaveLength(0);
    expect(seenByB).toHaveLength(1);
    expect(seenByB[0]).toEqual(event);
  });

  it("routes to remote source handlers and returns false when host throws", async () => {
    const manager = new ExtensionManager();
    const routedEvents: Array<{ source: string; event: GatewayEvent }> = [];
    const host = createRemoteHostMock({
      async routeToSource(source, event) {
        routedEvents.push({ source: source as string, event: event as GatewayEvent });
      },
    });
    manager.registerRemote(createRemoteRegistration({ sourceRoutes: ["sms"] }), host);

    const event: GatewayEvent = {
      type: "session.message_stop",
      payload: { ok: true },
      timestamp: 1,
    };
    await expect(manager.routeToSource("sms/+1555", event)).resolves.toBe(true);
    expect(routedEvents).toEqual([{ source: "sms/+1555", event }]);

    manager.registerRemote(
      createRemoteRegistration({ id: "broken", sourceRoutes: ["broken"] }),
      createRemoteHostMock({
        async routeToSource() {
          throw new Error("boom");
        },
      }),
    );
    await expect(manager.routeToSource("broken/1", event)).resolves.toBe(false);
  });

  it("cleans up source routes on remote unregister and re-register", async () => {
    const manager = new ExtensionManager();
    manager.registerRemote(
      createRemoteRegistration({ id: "voice", sourceRoutes: ["voice"] }),
      createRemoteHostMock(),
    );
    expect(manager.hasSourceRoute("voice/client1")).toBe(true);
    expect(manager.getSourceHandler("voice/client1")).toBe("voice");

    manager.registerRemote(
      createRemoteRegistration({ id: "voice", sourceRoutes: ["voice2"] }),
      createRemoteHostMock(),
    );
    expect(manager.hasSourceRoute("voice/client1")).toBe(false);
    expect(manager.hasSourceRoute("voice2/client1")).toBe(true);

    manager.unregisterRemote("voice");
    expect(manager.hasSourceRoute("voice2/client1")).toBe(false);
  });

  it("includes remote methods in discovery APIs", () => {
    const manager = new ExtensionManager();
    manager.registerRemote(
      createRemoteRegistration({
        id: "voice",
        name: "Voice",
        methods: [{ name: "voice.speak", description: "Speak text" }],
        sourceRoutes: [],
      }),
      createRemoteHostMock(),
    );

    expect(manager.hasMethod("voice.speak")).toBe(true);
    expect(manager.getExtensionList()).toEqual([
      { id: "voice", name: "Voice", methods: ["voice.speak"] },
    ]);
    expect(manager.getMethodDefinitions()[0]?.method.name).toBe("voice.speak");
  });

  it("reports remote host health and kills remote hosts", async () => {
    const manager = new ExtensionManager();
    let killed = 0;
    let forceKilled = 0;
    manager.registerRemote(
      createRemoteRegistration({ id: "voice", sourceRoutes: [] }),
      createRemoteHostMock({
        isRunning() {
          return false;
        },
        async kill() {
          killed += 1;
        },
        forceKill() {
          forceKilled += 1;
        },
      }),
    );

    expect(manager.getHealth()).toEqual({ voice: { ok: false, details: { remote: true } } });
    await manager.killRemoteHosts();
    expect(killed).toBe(1);

    manager.registerRemote(
      createRemoteRegistration({ id: "voice2", sourceRoutes: [] }),
      createRemoteHostMock({
        forceKill() {
          forceKilled += 1;
        },
      }),
    );
    manager.forceKillRemoteHosts();
    expect(forceKilled).toBe(1);
  });

  it("surfaces ctx.call unsupported error for in-process extensions", async () => {
    const manager = new ExtensionManager();
    let ctxRef: ExtensionContext | null = null;
    await manager.register({
      id: "test",
      name: "Test Extension",
      methods: [
        {
          name: "test.call_local",
          description: "Attempt in-process ctx.call",
          inputSchema: z.object({}),
        },
      ],
      events: [],
      async start(ctx: ExtensionContext) {
        ctxRef = ctx;
      },
      async stop() {},
      async handleMethod() {
        return await ctxRef!.call("session.send_prompt", { content: "ping" });
      },
      health() {
        return { ok: true };
      },
    });

    await expect(manager.handleMethod("test.call_local", {})).rejects.toThrow(
      "ctx.call() not yet supported for in-process extensions. Use out-of-process extensions.",
    );
  });

  it("unregister stops local extension and removes local source routes", async () => {
    const manager = new ExtensionManager();
    let stopped = 0;
    await manager.register(
      createTestExtension({
        sourceRoutes: ["imsg"],
        async stop() {
          stopped += 1;
        },
      }),
    );

    expect(manager.hasSourceRoute("imsg/+1555")).toBe(true);
    expect(manager.getSourceHandler("imsg/+1555")).toBe("test");

    await manager.unregister("test");
    expect(stopped).toBe(1);
    expect(manager.hasSourceRoute("imsg/+1555")).toBe(false);
    expect(manager.getSourceHandler("imsg/+1555")).toBeUndefined();
    expect(manager.hasMethod("test.echo")).toBe(false);
  });
});
