import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import type { ExtensionContext } from "@claudia/shared";
import { createSessionExtension } from "./index";
import { SessionManager } from "./session-manager";

const sessionId = "session-test-123";

function createTestContext(overrides: Partial<ExtensionContext> = {}): ExtensionContext {
  return {
    on: () => () => {},
    emit: () => {},
    async call() {
      throw new Error("Not implemented in test");
    },
    connectionId: null,
    tags: null,
    config: {},
    log: { info: () => {}, warn: () => {}, error: () => {} },
    ...overrides,
  };
}

describe("session extension", () => {
  let promptSpy: ReturnType<typeof spyOn>;
  let closeAllSpy: ReturnType<typeof spyOn>;
  let emitEventSpy: ReturnType<typeof spyOn>;
  let createSpy: ReturnType<typeof spyOn>;
  let resumeSpy: ReturnType<typeof spyOn>;
  let interruptSpy: ReturnType<typeof spyOn>;
  let closeSpy: ReturnType<typeof spyOn>;
  let listSpy: ReturnType<typeof spyOn>;
  let setPermissionModeSpy: ReturnType<typeof spyOn>;
  let sendToolResultSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    emitEventSpy = spyOn(SessionManager.prototype, "emit");
    closeAllSpy = spyOn(SessionManager.prototype, "closeAll").mockResolvedValue(undefined);
    createSpy = spyOn(SessionManager.prototype, "create").mockResolvedValue({
      sessionId: "created-session-1",
    });
    resumeSpy = spyOn(SessionManager.prototype, "resume").mockResolvedValue({
      sessionId: "resumed-session-1",
    });
    interruptSpy = spyOn(SessionManager.prototype, "interrupt").mockReturnValue(true);
    closeSpy = spyOn(SessionManager.prototype, "close").mockResolvedValue(undefined);
    listSpy = spyOn(SessionManager.prototype, "list").mockReturnValue([
      {
        id: sessionId,
        cwd: "/repo/project",
        model: "claude-test",
        isActive: true,
        isProcessRunning: true,
        createdAt: new Date().toISOString(),
        healthy: true,
        stale: false,
        lastActivity: new Date().toISOString(),
      },
    ]);
    setPermissionModeSpy = spyOn(SessionManager.prototype, "setPermissionMode").mockReturnValue(
      true,
    );
    sendToolResultSpy = spyOn(SessionManager.prototype, "sendToolResult").mockReturnValue(true);

    promptSpy = spyOn(SessionManager.prototype, "prompt").mockImplementation(function (
      this: SessionManager,
      sid: string,
    ) {
      this.emit("session.event", {
        eventName: `session.${sid}.content_block_delta`,
        sessionId: sid,
        type: "content_block_delta",
        delta: { type: "text_delta", text: "Hello " },
      });

      this.emit("session.event", {
        eventName: `session.${sid}.content_block_delta`,
        sessionId: sid,
        type: "content_block_delta",
        delta: { type: "text_delta", text: "world" },
      });

      this.emit("session.event", {
        eventName: `session.${sid}.turn_stop`,
        sessionId: sid,
        type: "turn_stop",
      });

      return Promise.resolve();
    });
  });

  afterEach(() => {
    promptSpy.mockRestore();
    closeAllSpy.mockRestore();
    emitEventSpy.mockRestore();
    createSpy.mockRestore();
    resumeSpy.mockRestore();
    interruptSpy.mockRestore();
    closeSpy.mockRestore();
    listSpy.mockRestore();
    setPermissionModeSpy.mockRestore();
    sendToolResultSpy.mockRestore();
  });

  it("returns accumulated text for non-streaming prompts", async () => {
    const ext = createSessionExtension();
    await ext.start(createTestContext());

    const result = (await ext.handleMethod("session.send_prompt", {
      sessionId,
      content: "ping",
      streaming: false,
    })) as { text: string; sessionId: string };

    expect(result).toEqual({ text: "Hello world", sessionId });

    await ext.stop();
  });

  it("propagates envelope data to async stream events", async () => {
    const emitted: Array<{ eventName: string; options?: Record<string, unknown> }> = [];

    const ext = createSessionExtension();
    await ext.start(
      createTestContext({
        connectionId: "conn-voice-1",
        tags: ["voice"],
        emit: (eventName, _payload, options) => {
          emitted.push({ eventName, options: options as Record<string, unknown> | undefined });
        },
      }),
    );

    await ext.handleMethod("session.send_prompt", {
      sessionId,
      content: "ping",
      streaming: false,
      source: "imessage/+15551234567",
    });

    const deltaEvent = emitted.find((e) => e.eventName.endsWith("content_block_delta"));
    expect(deltaEvent).toBeDefined();
    expect(deltaEvent?.options).toEqual({
      source: "imessage/+15551234567",
      connectionId: "conn-voice-1",
      tags: ["voice"],
    });

    await ext.stop();
  });

  it("returns immediately for streaming prompts", async () => {
    promptSpy.mockImplementation(() => Promise.resolve());

    const ext = createSessionExtension();
    await ext.start(createTestContext());

    const result = (await ext.handleMethod("session.send_prompt", {
      sessionId,
      content: "ping",
      streaming: true,
    })) as { status: string; sessionId: string };

    expect(result).toEqual({ status: "streaming", sessionId });
    expect(promptSpy).toHaveBeenCalledTimes(1);
    expect(promptSpy).toHaveBeenCalledWith(sessionId, "ping", undefined);

    await ext.stop();
  });

  it("propagates envelope data in streaming mode for async events", async () => {
    const emitted: Array<{ eventName: string; options?: Record<string, unknown> }> = [];

    promptSpy.mockImplementation(function (this: SessionManager, sid: string) {
      queueMicrotask(() => {
        this.emit("session.event", {
          eventName: `session.${sid}.content_block_delta`,
          sessionId: sid,
          type: "content_block_delta",
          delta: { type: "text_delta", text: "stream" },
        });
      });
      return Promise.resolve();
    });

    const ext = createSessionExtension();
    await ext.start(
      createTestContext({
        connectionId: "conn-stream-1",
        tags: ["voice", "realtime"],
        emit: (eventName, _payload, options) => {
          emitted.push({ eventName, options: options as Record<string, unknown> | undefined });
        },
      }),
    );

    await ext.handleMethod("session.send_prompt", {
      sessionId,
      content: "ping",
      streaming: true,
      source: "chat/browser",
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    const deltaEvent = emitted.find((e) => e.eventName.endsWith("content_block_delta"));
    expect(deltaEvent).toBeDefined();
    expect(deltaEvent?.options).toEqual({
      source: "chat/browser",
      connectionId: "conn-stream-1",
      tags: ["voice", "realtime"],
    });

    await ext.stop();
  });

  it("rejects non-streaming prompt when manager.prompt fails", async () => {
    promptSpy.mockImplementation(() => Promise.reject(new Error("prompt failed")));

    const ext = createSessionExtension();
    await ext.start(createTestContext());

    await expect(
      ext.handleMethod("session.send_prompt", {
        sessionId,
        content: "ping",
        streaming: false,
      }),
    ).rejects.toThrow("prompt failed");

    expect(emitEventSpy).not.toHaveBeenCalledWith(
      "session.event",
      expect.objectContaining({ type: "turn_stop" }),
    );

    await ext.stop();
  });

  it("creates sessions via session.create_session", async () => {
    const ext = createSessionExtension();
    await ext.start(createTestContext());

    const result = await ext.handleMethod("session.create_session", {
      cwd: "/repo/project",
      model: "claude-opus",
      systemPrompt: "You are strict",
      thinking: true,
      effort: "high",
    });

    expect(createSpy).toHaveBeenCalledWith({
      cwd: "/repo/project",
      model: "claude-opus",
      systemPrompt: "You are strict",
      thinking: true,
      effort: "high",
    });
    expect(result).toEqual({ sessionId: "created-session-1" });

    await ext.stop();
  });

  it("switches and resets sessions through manager methods", async () => {
    createSpy.mockResolvedValueOnce({ sessionId: "reset-session-1" });

    const ext = createSessionExtension();
    await ext.start(createTestContext());

    const switched = await ext.handleMethod("session.switch_session", {
      sessionId: "resume-1",
      cwd: "/repo/project",
      model: "claude-sonnet",
    });
    expect(resumeSpy).toHaveBeenCalledWith({
      sessionId: "resume-1",
      cwd: "/repo/project",
      model: "claude-sonnet",
    });
    expect(switched).toEqual({ sessionId: "resume-1" });

    const reset = await ext.handleMethod("session.reset_session", {
      cwd: "/repo/project",
      model: "claude-opus",
    });
    expect(createSpy).toHaveBeenCalledWith({
      cwd: "/repo/project",
      model: "claude-opus",
    });
    expect(reset).toEqual({ sessionId: "reset-session-1" });

    await ext.stop();
  });

  it("delegates interrupt/close/permission/tool_result methods", async () => {
    const ext = createSessionExtension();
    await ext.start(createTestContext());

    const interrupted = await ext.handleMethod("session.interrupt_session", { sessionId: "s-1" });
    expect(interruptSpy).toHaveBeenCalledWith("s-1");
    expect(interrupted).toEqual({ ok: true });

    const permission = await ext.handleMethod("session.set_permission_mode", {
      sessionId: "s-1",
      mode: "acceptEdits",
    });
    expect(setPermissionModeSpy).toHaveBeenCalledWith("s-1", "acceptEdits");
    expect(permission).toEqual({ ok: true });

    const toolResult = await ext.handleMethod("session.send_tool_result", {
      sessionId: "s-1",
      toolUseId: "tool-123",
      content: "done",
      isError: true,
    });
    expect(sendToolResultSpy).toHaveBeenCalledWith("s-1", "tool-123", "done", true);
    expect(toolResult).toEqual({ ok: true });

    const closed = await ext.handleMethod("session.close_session", { sessionId: "s-1" });
    expect(closeSpy).toHaveBeenCalledWith("s-1");
    expect(closed).toEqual({ ok: true });

    await ext.stop();
  });

  it("returns expected info and health payloads", async () => {
    const ext = createSessionExtension();
    await ext.start(createTestContext());

    const infoNoSession = (await ext.handleMethod("session.get_info", {})) as {
      activeSessions: unknown[];
    };
    expect(infoNoSession.activeSessions).toHaveLength(1);

    const infoWithSession = (await ext.handleMethod("session.get_info", {
      sessionId,
    })) as { session: { id: string } | null; activeSessions: unknown[] };
    expect(infoWithSession.session?.id).toBe(sessionId);
    expect(infoWithSession.activeSessions).toHaveLength(1);

    const health = (await ext.handleMethod("session.health_check", {})) as {
      ok: boolean;
      label: string;
      status: string;
      metrics?: Array<{ label: string; value: number }>;
      items?: Array<{ id: string }>;
    };
    expect(health.ok).toBe(true);
    expect(health.label).toBe("Sessions");
    expect(health.status).toBe("healthy");
    expect(health.metrics?.[0]).toEqual({ label: "Active Sessions", value: 1 });
    expect(health.items?.[0]?.id).toBe(sessionId);

    await ext.stop();
  });

  it("throws for unknown methods", async () => {
    const ext = createSessionExtension();
    await ext.start(createTestContext());

    await expect(ext.handleMethod("session.nope", {})).rejects.toThrow(
      "Unknown method: session.nope",
    );

    await ext.stop();
  });
});
