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

  beforeEach(() => {
    emitEventSpy = spyOn(SessionManager.prototype, "emit");
    closeAllSpy = spyOn(SessionManager.prototype, "closeAll").mockResolvedValue(undefined);
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
});
