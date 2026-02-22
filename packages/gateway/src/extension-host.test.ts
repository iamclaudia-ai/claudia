import { describe, expect, it } from "bun:test";
import type { GatewayEvent } from "@claudia/shared";
import { ExtensionHostProcess, type ExtensionRegistration } from "./extension-host";

interface TestProc {
  stdin: {
    write: (line: string) => void;
    close: () => void;
  };
  kill: (_signal: string) => void;
}

function createHostHarness(
  options: {
    onEvent?: (
      type: string,
      payload: unknown,
      source?: string,
      connectionId?: string,
      tags?: string[],
    ) => void;
    onRegister?: (registration: ExtensionRegistration) => void;
    onCall?: ConstructorParameters<typeof ExtensionHostProcess>[5];
  } = {},
) {
  const writes: Record<string, unknown>[] = [];
  const events: Array<{
    type: string;
    payload: unknown;
    source?: string;
    connectionId?: string;
    tags?: string[];
  }> = [];
  const registrations: ExtensionRegistration[] = [];

  const host = new ExtensionHostProcess(
    "test-ext",
    "extensions/test/index.ts",
    {},
    options.onEvent ??
      ((type, payload, source, connectionId, tags) => {
        events.push({ type, payload, source, connectionId, tags });
      }),
    options.onRegister ??
      ((registration) => {
        registrations.push(registration);
      }),
    options.onCall,
  );

  const proc: TestProc = {
    stdin: {
      write(line: string) {
        writes.push(JSON.parse(line.trim()) as Record<string, unknown>);
      },
      close() {},
    },
    kill() {},
  };
  (host as unknown as { proc: TestProc }).proc = proc;

  return { host, writes, events, registrations };
}

describe("ExtensionHostProcess protocol", () => {
  it("forwards extension event envelopes to gateway callback", () => {
    const { host, events } = createHostHarness();

    (host as unknown as { handleLine: (line: string) => void }).handleLine(
      JSON.stringify({
        type: "event",
        event: "session.abc.content_block_delta",
        payload: { text: "hello" },
        source: "chat/browser",
        connectionId: "conn-1",
        tags: ["voice"],
      }),
    );

    expect(events).toEqual([
      {
        type: "session.abc.content_block_delta",
        payload: { text: "hello" },
        source: "chat/browser",
        connectionId: "conn-1",
        tags: ["voice"],
      },
    ]);
  });

  it("stores registration and invokes callback", () => {
    const { host, registrations } = createHostHarness();
    const registration: ExtensionRegistration = {
      id: "test-ext",
      name: "Test Extension",
      methods: [{ name: "test.echo", description: "Echo" }],
      events: ["test.*"],
      sourceRoutes: ["testsrc"],
    };

    (host as unknown as { handleLine: (line: string) => void }).handleLine(
      JSON.stringify({ type: "register", extension: registration }),
    );

    expect(registrations).toEqual([registration]);
    expect(host.getRegistration()).toEqual(registration);
  });

  it("sends event payloads to host stdin", () => {
    const { host, writes } = createHostHarness();
    const event: GatewayEvent = {
      type: "voice.audio",
      payload: { chunk: 1 },
      timestamp: 1,
      origin: "extension:voice",
      source: "chat/browser",
      sessionId: "s1",
      connectionId: "conn-1",
      tags: ["voice"],
    };

    host.sendEvent(event);

    expect(writes).toEqual([
      {
        type: "event",
        event: "voice.audio",
        payload: { chunk: 1 },
        origin: "extension:voice",
        source: "chat/browser",
        sessionId: "s1",
        connectionId: "conn-1",
        tags: ["voice"],
      },
    ]);
  });

  it("routes source responses using __sourceResponse", async () => {
    const { host, writes } = createHostHarness();
    const event: GatewayEvent = { type: "session.done", payload: { ok: true }, timestamp: 1 };

    const promise = host.routeToSource("imessage/+1555", event);
    const req = writes[0] as { id: string };
    (host as unknown as { handleLine: (line: string) => void }).handleLine(
      JSON.stringify({ type: "res", id: req.id, ok: true, payload: { status: "ok" } }),
    );
    await promise;

    expect((writes[0] as { method: string }).method).toBe("__sourceResponse");
    expect((writes[0] as { params: Record<string, unknown> }).params).toEqual({
      source: "imessage/+1555",
      event,
    });
  });

  it("delegates callMethod with envelope metadata and resolves on response", async () => {
    const { host, writes } = createHostHarness();

    const callPromise = host.callMethod(
      "session.send_prompt",
      { sessionId: "s1", content: "ping" },
      "conn-1",
      { traceId: "trace-1", depth: 3, deadlineMs: 9999, tags: ["voice", "streaming"] },
    );

    const request = writes[0] as {
      id: string;
      method: string;
      connectionId?: string;
      tags?: string[];
      traceId?: string;
      depth?: number;
      deadlineMs?: number;
    };
    expect(request.method).toBe("session.send_prompt");
    expect(request.connectionId).toBe("conn-1");
    expect(request.tags).toEqual(["voice", "streaming"]);
    expect(request.traceId).toBe("trace-1");
    expect(request.depth).toBe(3);
    expect(request.deadlineMs).toBe(9999);

    (host as unknown as { handleLine: (line: string) => void }).handleLine(
      JSON.stringify({
        type: "res",
        id: request.id,
        ok: true,
        payload: { text: "pong" },
      }),
    );

    await expect(callPromise).resolves.toEqual({ text: "pong" });
  });

  it("rejects callMethod when response is error", async () => {
    const { host, writes } = createHostHarness();
    const callPromise = host.callMethod("session.send_prompt", { content: "ping" });
    const request = writes[0] as { id: string };

    (host as unknown as { handleLine: (line: string) => void }).handleLine(
      JSON.stringify({
        type: "res",
        id: request.id,
        ok: false,
        error: "bad request",
      }),
    );

    await expect(callPromise).rejects.toThrow("bad request");
  });

  it("enforces ctx.call guardrails and returns call_res errors", async () => {
    const { host, writes } = createHostHarness();
    const handleCall = (
      host as unknown as { handleCall: (msg: Record<string, unknown>) => Promise<void> }
    ).handleCall;

    await handleCall.call(host, { id: "c1", method: "x.y", depth: 9 });
    await handleCall.call(host, { id: "c2", method: "x.y", depth: 1, deadlineMs: Date.now() - 1 });
    await handleCall.call(host, { id: "c3", method: "x.y", depth: 1 });

    expect(writes).toEqual([
      {
        type: "call_res",
        id: "c1",
        ok: false,
        error: "Call depth 9 exceeds max (8) — possible cycle",
      },
      { type: "call_res", id: "c2", ok: false, error: "Call deadline exceeded for x.y" },
      {
        type: "call_res",
        id: "c3",
        ok: false,
        error: "ctx.call not supported — no onCall callback registered",
      },
    ]);
  });

  it("propagates ctx.call metadata to onCall and returns payload", async () => {
    const seen: Array<{
      caller: string;
      method: string;
      params: Record<string, unknown>;
      meta: {
        connectionId?: string;
        tags?: string[];
        traceId?: string;
        depth?: number;
        deadlineMs?: number;
      };
    }> = [];
    const { host, writes } = createHostHarness({
      onCall: async (caller, method, params, meta) => {
        seen.push({ caller, method, params, meta });
        return { ok: true, payload: { result: "ok" } };
      },
    });
    const handleCall = (
      host as unknown as { handleCall: (msg: Record<string, unknown>) => Promise<void> }
    ).handleCall;
    const deadlineMs = Date.now() + 60_000;

    await handleCall.call(host, {
      type: "call",
      id: "call-1",
      method: "session.send_prompt",
      params: { sessionId: "s1" },
      connectionId: "conn-xyz",
      tags: ["voice"],
      traceId: "trace-123",
      depth: 2,
      deadlineMs,
    });

    expect(seen).toEqual([
      {
        caller: "test-ext",
        method: "session.send_prompt",
        params: { sessionId: "s1" },
        meta: {
          connectionId: "conn-xyz",
          tags: ["voice"],
          traceId: "trace-123",
          depth: 2,
          deadlineMs,
        },
      },
    ]);
    expect(writes).toEqual([
      { type: "call_res", id: "call-1", ok: true, payload: { result: "ok" } },
    ]);
  });

  it("rejects pending requests when killed", async () => {
    const { host } = createHostHarness();
    const pending = host.callMethod("session.send_prompt", { sessionId: "s1" });

    await host.kill();
    await expect(pending).rejects.toThrow("Extension host killed");
  });
});
