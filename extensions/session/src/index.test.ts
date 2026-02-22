import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import type { ExtensionContext } from "@claudia/shared";
import { createSessionExtension } from "./index";
import { SessionManager } from "./session-manager";
import * as workspace from "./workspace";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

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
  let listWorkspacesSpy: ReturnType<typeof spyOn>;
  let getWorkspaceSpy: ReturnType<typeof spyOn>;
  let getOrCreateWorkspaceSpy: ReturnType<typeof spyOn>;
  let closeDbSpy: ReturnType<typeof spyOn>;

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
    listWorkspacesSpy = spyOn(workspace, "listWorkspaces").mockReturnValue([
      {
        id: "ws-1",
        name: "project",
        cwd: "/repo/project",
        createdAt: "2026-02-22T00:00:00.000Z",
        updatedAt: "2026-02-22T00:00:00.000Z",
      },
    ]);
    getWorkspaceSpy = spyOn(workspace, "getWorkspace").mockReturnValue({
      id: "ws-1",
      name: "project",
      cwd: "/repo/project",
      createdAt: "2026-02-22T00:00:00.000Z",
      updatedAt: "2026-02-22T00:00:00.000Z",
    });
    getOrCreateWorkspaceSpy = spyOn(workspace, "getOrCreateWorkspace").mockReturnValue({
      workspace: {
        id: "ws-2",
        name: "new-project",
        cwd: "/repo/new-project",
        createdAt: "2026-02-22T00:00:00.000Z",
        updatedAt: "2026-02-22T00:00:00.000Z",
      },
      created: true,
    });
    closeDbSpy = spyOn(workspace, "closeDb").mockImplementation(() => {});

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
    listWorkspacesSpy.mockRestore();
    getWorkspaceSpy.mockRestore();
    getOrCreateWorkspaceSpy.mockRestore();
    closeDbSpy.mockRestore();
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

  it("routes workspace CRUD methods through workspace module", async () => {
    const ext = createSessionExtension();
    await ext.start(createTestContext());

    const listed = await ext.handleMethod("session.list_workspaces", {});
    expect(listWorkspacesSpy).toHaveBeenCalledTimes(1);
    expect(listed).toEqual({
      workspaces: [
        {
          id: "ws-1",
          name: "project",
          cwd: "/repo/project",
          createdAt: "2026-02-22T00:00:00.000Z",
          updatedAt: "2026-02-22T00:00:00.000Z",
        },
      ],
    });

    const fetched = await ext.handleMethod("session.get_workspace", { id: "ws-1" });
    expect(getWorkspaceSpy).toHaveBeenCalledWith("ws-1");
    expect(fetched).toEqual({
      workspace: {
        id: "ws-1",
        name: "project",
        cwd: "/repo/project",
        createdAt: "2026-02-22T00:00:00.000Z",
        updatedAt: "2026-02-22T00:00:00.000Z",
      },
    });

    const created = await ext.handleMethod("session.get_or_create_workspace", {
      cwd: "/repo/new-project",
      name: "new-project",
    });
    expect(getOrCreateWorkspaceSpy).toHaveBeenCalledWith("/repo/new-project", "new-project");
    expect(created).toEqual({
      workspace: {
        id: "ws-2",
        name: "new-project",
        cwd: "/repo/new-project",
        createdAt: "2026-02-22T00:00:00.000Z",
        updatedAt: "2026-02-22T00:00:00.000Z",
      },
      created: true,
    });

    await ext.stop();
  });

  it("lists sessions from ~/.claude/projects sorted by recency", async () => {
    const ext = createSessionExtension();
    await ext.start(createTestContext());
    const cwd = `/tmp/claudia-test-${Date.now()}-sessions`;
    const encodedCwd = cwd.replace(/\//g, "-");
    const projectDir = join(homedir(), ".claude", "projects", encodedCwd);
    try {
      mkdirSync(projectDir, { recursive: true });

      writeFileSync(
        join(projectDir, "sessions-index.json"),
        JSON.stringify({
          originalPath: cwd,
          entries: [
            {
              sessionId: "old-session",
              created: "2026-01-01T00:00:00.000Z",
              modified: "2026-01-01T00:00:00.000Z",
              messageCount: 2,
            },
            {
              sessionId: "new-session",
              created: "2026-02-22T00:00:00.000Z",
              modified: "2026-02-22T00:00:00.000Z",
              messageCount: 3,
              gitBranch: "main",
            },
          ],
        }),
      );

      writeFileSync(
        join(projectDir, "old-session.jsonl"),
        `${JSON.stringify({
          type: "user",
          message: { role: "user", content: "older prompt" },
        })}\n`,
      );
      writeFileSync(
        join(projectDir, "new-session.jsonl"),
        `${JSON.stringify({
          type: "user",
          message: { role: "user", content: "newer prompt" },
        })}\n`,
      );

      const result = (await ext.handleMethod("session.list_sessions", { cwd })) as {
        sessions: Array<{ sessionId: string; firstPrompt?: string; gitBranch?: string }>;
      };

      expect(result.sessions).toHaveLength(2);
      expect(result.sessions[0]?.sessionId).toBe("new-session");
      expect(result.sessions[0]?.gitBranch).toBe("main");
      expect(result.sessions[0]?.firstPrompt).toBe("newer prompt");
      expect(result.sessions[1]?.sessionId).toBe("old-session");
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
      await ext.stop();
    }
  });

  it("discovers sessions via originalPath fallback and extracts first text block prompts", async () => {
    const ext = createSessionExtension();
    await ext.start(createTestContext());
    const cwd = `/tmp/claudia-test-${Date.now()}-fallback`;
    const fallbackDir = join(homedir(), ".claude", "projects", `fallback-${Date.now()}`);
    const badDir = join(homedir(), ".claude", "projects", `bad-${Date.now()}`);

    try {
      mkdirSync(fallbackDir, { recursive: true });
      mkdirSync(badDir, { recursive: true });

      writeFileSync(join(badDir, "sessions-index.json"), "{ this is not json");
      writeFileSync(
        join(fallbackDir, "sessions-index.json"),
        JSON.stringify({
          originalPath: cwd,
          entries: [{ sessionId: "fallback-session", modified: "2026-02-22T01:00:00.000Z" }],
        }),
      );
      writeFileSync(
        join(fallbackDir, "fallback-session.jsonl"),
        `${JSON.stringify({
          type: "user",
          message: {
            role: "user",
            content: [{ type: "text", text: "prompt from text block" }],
          },
        })}\n`,
      );

      const result = (await ext.handleMethod("session.list_sessions", { cwd })) as {
        sessions: Array<{ sessionId: string; firstPrompt?: string }>;
      };
      expect(result.sessions).toHaveLength(1);
      expect(result.sessions[0]?.sessionId).toBe("fallback-session");
      expect(result.sessions[0]?.firstPrompt).toBe("prompt from text block");
    } finally {
      rmSync(fallbackDir, { recursive: true, force: true });
      rmSync(badDir, { recursive: true, force: true });
      await ext.stop();
    }
  });

  it("handles delayed turn_stop logging path for streaming prompts", async () => {
    const removeListenerSpy = spyOn(SessionManager.prototype, "removeListener");
    promptSpy.mockImplementation(function (this: SessionManager, sid: string) {
      setTimeout(() => {
        this.emit("session.event", {
          eventName: `session.${sid}.content_block_delta`,
          sessionId: sid,
          type: "content_block_delta",
          delta: { type: "text_delta", text: "late chunk" },
        });
        this.emit("session.event", {
          eventName: `session.${sid}.turn_stop`,
          sessionId: sid,
          type: "turn_stop",
        });
      }, 0);
      return Promise.resolve();
    });

    const ext = createSessionExtension();
    await ext.start(createTestContext());

    const result = await ext.handleMethod("session.send_prompt", {
      sessionId,
      content: "ping",
      streaming: true,
    });
    expect(result).toEqual({ status: "streaming", sessionId });

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(removeListenerSpy).toHaveBeenCalledWith("session.event", expect.any(Function));

    await ext.stop();
    removeListenerSpy.mockRestore();
  });

  it("returns paginated history and empty history when session file is missing", async () => {
    const ext = createSessionExtension();
    await ext.start(createTestContext());
    const cwd = `/tmp/claudia-test-${Date.now()}-history`;
    const encodedCwd = cwd.replace(/\//g, "-");
    const projectDir = join(homedir(), ".claude", "projects", encodedCwd);
    try {
      mkdirSync(projectDir, { recursive: true });

      writeFileSync(
        join(projectDir, "hist-session.jsonl"),
        [
          JSON.stringify({
            type: "user",
            timestamp: "2026-02-22T00:00:00.000Z",
            message: { role: "user", content: "first" },
          }),
          JSON.stringify({
            type: "assistant",
            timestamp: "2026-02-22T00:00:01.000Z",
            message: { role: "assistant", content: [{ type: "text", text: "second" }] },
          }),
          JSON.stringify({
            type: "user",
            timestamp: "2026-02-22T00:00:02.000Z",
            message: { role: "user", content: "third" },
          }),
        ].join("\n") + "\n",
      );

      const paged = (await ext.handleMethod("session.get_history", {
        sessionId: "hist-session",
        cwd,
        limit: 2,
        offset: 0,
      })) as {
        messages: Array<{ role: string }>;
        total: number;
        hasMore: boolean;
      };

      expect(paged.total).toBe(3);
      expect(paged.hasMore).toBe(true);
      expect(paged.messages.map((m) => m.role)).toEqual(["assistant", "user"]);

      const missing = (await ext.handleMethod("session.get_history", {
        sessionId: "missing-session",
        cwd,
      })) as { messages: unknown[]; total: number; hasMore: boolean };
      expect(missing).toEqual({ messages: [], total: 0, hasMore: false });
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
      await ext.stop();
    }
  });

  it("returns empty sessions when project fallback has no matching originalPath", async () => {
    const ext = createSessionExtension();
    await ext.start(createTestContext());
    const cwd = `/tmp/claudia-test-${Date.now()}-no-fallback-match`;
    const badDir = join(homedir(), ".claude", "projects", `bad-only-${Date.now()}`);
    try {
      mkdirSync(badDir, { recursive: true });
      writeFileSync(join(badDir, "sessions-index.json"), "{ broken json");

      const result = (await ext.handleMethod("session.list_sessions", { cwd })) as {
        sessions: Array<{ sessionId: string }>;
      };
      expect(result.sessions).toEqual([]);
    } finally {
      rmSync(badDir, { recursive: true, force: true });
      await ext.stop();
    }
  });

  it("keeps sessions when prompt extraction encounters malformed JSONL lines", async () => {
    const ext = createSessionExtension();
    await ext.start(createTestContext());
    const cwd = `/tmp/claudia-test-${Date.now()}-malformed-prompt`;
    const encodedCwd = cwd.replace(/\//g, "-");
    const projectDir = join(homedir(), ".claude", "projects", encodedCwd);
    try {
      mkdirSync(projectDir, { recursive: true });

      writeFileSync(
        join(projectDir, "broken-first-prompt.jsonl"),
        [
          "{not-json",
          JSON.stringify({
            type: "assistant",
            message: {
              role: "assistant",
              content: [{ type: "text", text: "assistant only" }],
            },
          }),
        ].join("\n") + "\n",
      );

      const result = (await ext.handleMethod("session.list_sessions", { cwd })) as {
        sessions: Array<{ sessionId: string; firstPrompt?: string }>;
      };
      expect(result.sessions).toHaveLength(1);
      expect(result.sessions[0]?.sessionId).toBe("broken-first-prompt");
      expect(result.sessions[0]?.firstPrompt).toBeUndefined();
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
      await ext.stop();
    }
  });

  it("times out non-streaming prompts when turn_stop never arrives", async () => {
    const timeoutCallbacks: Array<() => void> = [];
    const timeoutSpy = spyOn(globalThis, "setTimeout").mockImplementation(((
      cb: (...args: unknown[]) => void,
    ) => {
      timeoutCallbacks.push(() => cb());
      return 1 as unknown as ReturnType<typeof setTimeout>;
    }) as unknown as typeof setTimeout);
    const clearSpy = spyOn(globalThis, "clearTimeout").mockImplementation(() => {});

    promptSpy.mockImplementation(() => Promise.resolve());

    const ext = createSessionExtension();
    await ext.start(createTestContext());

    const pending = ext.handleMethod("session.send_prompt", {
      sessionId,
      content: "ping",
      streaming: false,
    });
    expect(timeoutCallbacks.length).toBe(1);
    timeoutCallbacks[0]?.();
    await expect(pending).rejects.toThrow("Prompt timed out after 5 minutes");

    await ext.stop();
    timeoutSpy.mockRestore();
    clearSpy.mockRestore();
  });

  it("executes slow-call logging path for non-read methods", async () => {
    const nowSpy = spyOn(Date, "now");
    nowSpy.mockImplementationOnce(() => 1_000).mockImplementationOnce(() => 1_250);

    const ext = createSessionExtension();
    await ext.start(createTestContext());

    const result = await ext.handleMethod("session.create_session", { cwd: "/repo/slow" });
    expect(result).toEqual({ sessionId: "created-session-1" });

    await ext.stop();
    nowSpy.mockRestore();
  });
});
