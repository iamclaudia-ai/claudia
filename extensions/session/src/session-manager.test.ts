import { describe, expect, it } from "bun:test";
import { EventEmitter } from "node:events";
import { SessionManager } from "./session-manager";

class FakeSession extends EventEmitter {
  constructor(
    public id: string,
    public isActive = true,
  ) {
    super();
  }

  interrupted = false;
  permissionMode: string | null = null;
  toolResult: {
    toolUseId: string;
    content: string;
    isError: boolean;
  } | null = null;
  closed = false;

  async start(): Promise<void> {}

  prompt(_content: string | unknown[]): void {}

  interrupt(): void {
    this.interrupted = true;
  }

  setPermissionMode(mode: string): void {
    this.permissionMode = mode;
  }

  sendToolResult(toolUseId: string, content: string, isError = false): void {
    this.toolResult = { toolUseId, content, isError };
  }

  async close(): Promise<void> {
    this.closed = true;
    this.emit("closed");
  }

  getInfo() {
    return {
      id: this.id,
      cwd: "/tmp/test",
      model: "claude-test",
      healthy: true,
      stale: false,
      lastActivity: Date.now(),
    };
  }
}

describe("SessionManager", () => {
  it("creates and wires a new session", async () => {
    const fake = new FakeSession("s-created");
    const manager = new SessionManager({
      create: () => fake as unknown as import("./sdk-session").SDKSession,
    });
    const events: Record<string, unknown>[] = [];
    manager.on("session.event", (e) => {
      events.push(e as Record<string, unknown>);
    });

    await expect(manager.create({ cwd: "/repo", model: "claude-sonnet" })).resolves.toEqual({
      sessionId: "s-created",
    });
    expect(manager.list()[0]?.id).toBe("s-created");

    fake.emit("sse", { type: "content_block_delta", delta: { text: "hi" } });
    fake.emit("process_started");
    fake.emit("process_ended");

    expect(events[0]).toMatchObject({
      eventName: "session.s-created.content_block_delta",
      sessionId: "s-created",
      type: "content_block_delta",
    });
    expect(events[1]).toMatchObject({
      eventName: "session.s-created.process_started",
      sessionId: "s-created",
      type: "process_started",
    });
    expect(events[2]).toMatchObject({
      eventName: "session.s-created.process_ended",
      sessionId: "s-created",
      type: "process_ended",
    });
  });

  it("auto-resumes missing sessions for prompt using configured defaults", async () => {
    const resumed = new FakeSession("s-resume");
    const resumeCalls: Array<{ sessionId: string; options: Record<string, unknown> }> = [];
    const manager = new SessionManager({
      resume: (sessionId, options) => {
        resumeCalls.push({ sessionId, options: options as unknown as Record<string, unknown> });
        return resumed as unknown as import("./sdk-session").SDKSession;
      },
    });
    manager.setDefaults({ model: "claude-opus", thinking: true, effort: "high" });

    await manager.prompt("s-resume", "hello", "/repo");

    expect(resumeCalls).toEqual([
      {
        sessionId: "s-resume",
        options: {
          cwd: "/repo",
          model: "claude-opus",
          thinking: true,
          effort: "high",
        },
      },
    ]);
  });

  it("throws when prompting a missing session without cwd", async () => {
    const manager = new SessionManager();
    await expect(manager.prompt("missing", "hello")).rejects.toThrow(
      "Session not found and no cwd provided for auto-resume: missing",
    );
  });

  it("routes interrupt, permission mode, and tool results to active sessions", async () => {
    const fake = new FakeSession("s-live");
    const manager = new SessionManager({
      create: () => fake as unknown as import("./sdk-session").SDKSession,
    });
    await manager.create({ cwd: "/repo" });

    expect(manager.interrupt("s-live")).toBe(true);
    expect(fake.interrupted).toBe(true);

    expect(manager.setPermissionMode("s-live", "acceptEdits")).toBe(true);
    expect(fake.permissionMode).toBe("acceptEdits");

    expect(manager.sendToolResult("s-live", "tool-1", "ok", false)).toBe(true);
    expect(fake.toolResult).toEqual({ toolUseId: "tool-1", content: "ok", isError: false });
  });

  it("closes individual sessions and closeAll removes all", async () => {
    const s1 = new FakeSession("s1");
    const s2 = new FakeSession("s2");
    let created = 0;
    const manager = new SessionManager({
      create: () => (created++ === 0 ? s1 : s2) as unknown as import("./sdk-session").SDKSession,
    });
    await manager.create({ cwd: "/repo/1" });
    await manager.create({ cwd: "/repo/2" });

    await manager.close("s1");
    expect(s1.closed).toBe(true);
    expect(manager.list().map((s) => s.id)).toEqual(["s2"]);

    await manager.closeAll();
    expect(s2.closed).toBe(true);
    expect(manager.list()).toHaveLength(0);
  });
});
