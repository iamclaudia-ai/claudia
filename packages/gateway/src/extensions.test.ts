import { describe, expect, it } from "bun:test";
import { ExtensionManager } from "./extensions";
import type { GatewayEvent } from "@claudia/shared";
import type { ExtensionHostProcess, ExtensionRegistration } from "./extension-host";

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

  it("throws when no remote host is registered for a method", async () => {
    const manager = new ExtensionManager();
    await expect(manager.handleMethod("missing.echo", {})).rejects.toThrow(
      "No extension found for method: missing.echo",
    );
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

  it("returns false when no source route exists", async () => {
    const manager = new ExtensionManager();
    manager.registerRemote(
      createRemoteRegistration({ sourceRoutes: ["voice"] }),
      createRemoteHostMock(),
    );

    const routed = await manager.routeToSource("unknown/abc", {
      type: "session.message_stop",
      payload: {},
      timestamp: Date.now(),
    });

    expect(routed).toBe(false);
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
    expect(manager.hasMethod("session.send_prompt")).toBe(false);
    expect(manager.getExtensionList()).toEqual([
      { id: "voice", name: "Voice", methods: ["voice.speak"] },
    ]);
    expect(manager.getMethodDefinitions()[0]?.method.name).toBe("voice.speak");
    expect(manager.getSourceRoutes()).toEqual({});
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
    expect(manager.getSourceRoutes()).toEqual({});

    manager.registerRemote(
      createRemoteRegistration({ id: "voice2", sourceRoutes: ["voice"] }),
      createRemoteHostMock({
        forceKill() {
          forceKilled += 1;
        },
      }),
    );
    manager.forceKillRemoteHosts();
    expect(forceKilled).toBe(1);
    expect(manager.getSourceRoutes()).toEqual({});
  });
});
