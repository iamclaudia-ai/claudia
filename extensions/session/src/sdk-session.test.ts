import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createSDKSession, resumeSDKSession, SDKSession } from "./sdk-session";

type QueryMsg = Record<string, unknown>;

class FakeQuery implements AsyncIterable<QueryMsg> {
  private queue: QueryMsg[] = [];
  private waiting: ((value: IteratorResult<QueryMsg>) => void) | null = null;
  private done = false;

  interruptCalls = 0;
  closeCalls = 0;
  permissionModes: string[] = [];

  push(msg: QueryMsg): void {
    if (this.done) return;
    if (this.waiting) {
      const resolve = this.waiting;
      this.waiting = null;
      resolve({ value: msg, done: false });
    } else {
      this.queue.push(msg);
    }
  }

  finish(): void {
    this.done = true;
    if (this.waiting) {
      const resolve = this.waiting;
      this.waiting = null;
      resolve({ value: undefined as unknown as QueryMsg, done: true });
    }
  }

  async interrupt(): Promise<void> {
    this.interruptCalls += 1;
  }

  async setPermissionMode(mode: string): Promise<void> {
    this.permissionModes.push(mode);
  }

  close(): void {
    this.closeCalls += 1;
    this.finish();
  }

  [Symbol.asyncIterator](): AsyncIterator<QueryMsg> {
    return {
      next: () => {
        if (this.queue.length > 0) {
          return Promise.resolve({ value: this.queue.shift()!, done: false });
        }
        if (this.done) {
          return Promise.resolve({ value: undefined as unknown as QueryMsg, done: true });
        }
        return new Promise<IteratorResult<QueryMsg>>((resolve) => {
          this.waiting = resolve;
        });
      },
    };
  }
}

class RejectingOpsQuery extends FakeQuery {
  async interrupt(): Promise<void> {
    this.interruptCalls += 1;
    throw new Error("interrupt failed");
  }

  async setPermissionMode(mode: string): Promise<void> {
    this.permissionModes.push(mode);
    throw new Error("permission failed");
  }
}

class ThrowingQuery implements AsyncIterable<QueryMsg> {
  async interrupt(): Promise<void> {}
  async setPermissionMode(): Promise<void> {}
  close(): void {}

  [Symbol.asyncIterator](): AsyncIterator<QueryMsg> {
    return {
      next: async () => {
        throw new Error("query exploded");
      },
    };
  }
}

const asQueryFactory = (queryLike: unknown) =>
  (() => queryLike) as unknown as typeof import("@anthropic-ai/claude-agent-sdk").query;

describe("SDKSession", () => {
  const createdSessionIds: string[] = [];

  afterEach(() => {
    for (const id of createdSessionIds) {
      rmSync(join(homedir(), ".claudia", "sessions", id), { recursive: true, force: true });
    }
    createdSessionIds.length = 0;
  });

  it("creates query on prompt and forwards stream/result events", async () => {
    const fakeQuery = new FakeQuery();
    const sessionId = `sdk-test-${Date.now()}-1`;
    createdSessionIds.push(sessionId);
    const session = new SDKSession(
      sessionId,
      { cwd: "/repo/test", model: "claude-test", effort: "low" },
      false,
      { queryFactory: asQueryFactory(fakeQuery) },
    );
    const sseEvents: Array<{ type: string; [key: string]: unknown }> = [];
    const procEvents: string[] = [];

    session.on("sse", (e) => sseEvents.push(e as { type: string; [key: string]: unknown }));
    session.on("process_started", () => procEvents.push("started"));
    session.on("process_ended", () => procEvents.push("ended"));

    await session.start();
    session.prompt("hello");
    expect(procEvents).toContain("started");

    fakeQuery.push({
      type: "stream_event",
      event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hi" } },
    });
    fakeQuery.push({
      type: "result",
      stop_reason: "end_turn",
      duration_ms: 10,
      num_turns: 1,
      usage: { input_tokens: 1, output_tokens: 1 },
      total_cost_usd: 0.001,
    });
    fakeQuery.finish();
    await Bun.sleep(20);

    expect(sseEvents.some((e) => e.type === "content_block_delta")).toBe(true);
    const turnStop = sseEvents.find((e) => e.type === "turn_stop");
    expect(turnStop?.stop_reason).toBe("end_turn");
    expect(procEvents).toContain("ended");
  });

  it("interrupt emits synthetic stop events for open messages/blocks", async () => {
    const fakeQuery = new FakeQuery();
    const sessionId = `sdk-test-${Date.now()}-2`;
    createdSessionIds.push(sessionId);
    const session = new SDKSession(sessionId, { cwd: "/repo/test" }, false, {
      queryFactory: asQueryFactory(fakeQuery),
    });
    const sseTypes: string[] = [];
    session.on("sse", (e) => sseTypes.push((e as { type: string }).type));

    await session.start();
    session.prompt("hello");

    fakeQuery.push({ type: "stream_event", event: { type: "message_start" } });
    fakeQuery.push({ type: "stream_event", event: { type: "content_block_start", index: 3 } });
    await Bun.sleep(10);

    session.interrupt();
    await Bun.sleep(10);

    expect(fakeQuery.interruptCalls).toBe(1);
    expect(sseTypes).toContain("content_block_stop");
    expect(sseTypes).toContain("message_delta");
    expect(sseTypes).toContain("message_stop");
    expect(sseTypes.filter((t) => t === "turn_stop").length).toBeGreaterThan(0);
  });

  it("auto-approves EnterPlanMode tool calls via sendToolResult", async () => {
    const fakeQuery = new FakeQuery();
    const sessionId = `sdk-test-${Date.now()}-3`;
    createdSessionIds.push(sessionId);
    const session = new SDKSession(sessionId, { cwd: "/repo/test" }, false, {
      queryFactory: asQueryFactory(fakeQuery),
    });
    const sendToolSpy = spyOn(session, "sendToolResult");

    await session.start();
    session.prompt("hello");

    fakeQuery.push({ type: "stream_event", event: { type: "message_start" } });
    fakeQuery.push({
      type: "stream_event",
      event: {
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", id: "tool-enter-1", name: "EnterPlanMode" },
      },
    });
    fakeQuery.push({
      type: "stream_event",
      event: {
        type: "content_block_delta",
        delta: { type: "input_json_delta", partial_json: '{"step":1}' },
      },
    });
    fakeQuery.push({ type: "stream_event", event: { type: "content_block_stop", index: 0 } });
    fakeQuery.push({ type: "stream_event", event: { type: "message_stop" } });
    await Bun.sleep(20);

    expect(sendToolSpy).toHaveBeenCalledTimes(1);
    expect(sendToolSpy).toHaveBeenCalledWith(
      "tool-enter-1",
      expect.stringContaining("Plan mode activated"),
    );
    expect(session.getPendingInteractiveTools()).toHaveLength(0);

    sendToolSpy.mockRestore();
  });

  it("setPermissionMode forwards to query and close cleans up query", async () => {
    const fakeQuery = new FakeQuery();
    const sessionId = `sdk-test-${Date.now()}-4`;
    createdSessionIds.push(sessionId);
    const session = new SDKSession(sessionId, { cwd: "/repo/test" }, false, {
      queryFactory: asQueryFactory(fakeQuery),
    });

    await session.start();
    session.prompt("hello");
    session.setPermissionMode("acceptEdits");
    await Bun.sleep(10);
    expect(fakeQuery.permissionModes).toEqual(["acceptEdits"]);

    await session.close();
    expect(fakeQuery.closeCalls).toBe(1);
    expect(session.isActive).toBe(false);
  });

  it("routes user/system/tool_progress messages and extracts tool results", async () => {
    const fakeQuery = new FakeQuery();
    const sessionId = `sdk-test-${Date.now()}-5`;
    createdSessionIds.push(sessionId);
    const session = new SDKSession(sessionId, { cwd: "/repo/test" }, false, {
      queryFactory: asQueryFactory(fakeQuery),
    });
    const sseEvents: Array<{ type: string; [key: string]: unknown }> = [];
    session.on("sse", (e) => sseEvents.push(e as { type: string; [key: string]: unknown }));

    await session.start();
    session.prompt("hello");

    fakeQuery.push({
      type: "user",
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "tool-1", content: "ok", is_error: false }],
      },
    });
    fakeQuery.push({ type: "system", subtype: "status", status: "compacting" });
    fakeQuery.push({ type: "system", subtype: "status", status: null });
    fakeQuery.push({
      type: "system",
      subtype: "compact_boundary",
      compact_metadata: { trigger: "auto", pre_tokens: 123 },
    });
    fakeQuery.push({
      type: "tool_progress",
      tool_use_id: "tool-2",
      tool_name: "Bash",
      elapsed_time_seconds: 2,
    });
    fakeQuery.push({ type: "something_unhandled" });
    fakeQuery.finish();
    await Bun.sleep(20);

    expect(sseEvents.some((e) => e.type === "request_tool_results")).toBe(true);
    expect(sseEvents.some((e) => e.type === "compaction_start")).toBe(true);
    expect(sseEvents.some((e) => e.type === "compaction_end")).toBe(true);
    expect(sseEvents.some((e) => e.type === "tool_progress")).toBe(true);
  });

  it("tracks AskUserQuestion as pending and does not auto-approve it", async () => {
    const fakeQuery = new FakeQuery();
    const sessionId = `sdk-test-${Date.now()}-6`;
    createdSessionIds.push(sessionId);
    const session = new SDKSession(sessionId, { cwd: "/repo/test" }, false, {
      queryFactory: asQueryFactory(fakeQuery),
    });
    const sendToolSpy = spyOn(session, "sendToolResult");

    await session.start();
    session.prompt("hello");

    fakeQuery.push({ type: "stream_event", event: { type: "message_start" } });
    fakeQuery.push({
      type: "stream_event",
      event: {
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", id: "tool-ask-1", name: "AskUserQuestion" },
      },
    });
    fakeQuery.push({ type: "stream_event", event: { type: "content_block_stop", index: 0 } });
    fakeQuery.push({ type: "stream_event", event: { type: "message_stop" } });
    await Bun.sleep(20);

    expect(sendToolSpy).not.toHaveBeenCalled();
    expect(session.getPendingInteractiveTools()).toEqual([
      {
        toolUseId: "tool-ask-1",
        name: "AskUserQuestion",
        input: "",
      },
    ]);
    sendToolSpy.mockRestore();
  });

  it("handles interrupt/setPermissionMode failures and emits process_died on read failure", async () => {
    const rejectingQuery = new RejectingOpsQuery();
    const sessionId1 = `sdk-test-${Date.now()}-7`;
    createdSessionIds.push(sessionId1);
    const session1 = new SDKSession(sessionId1, { cwd: "/repo/test" }, false, {
      queryFactory: asQueryFactory(rejectingQuery),
    });

    await session1.start();
    session1.prompt("hello");
    session1.interrupt();
    session1.setPermissionMode("bypassPermissions");
    await Bun.sleep(20);

    expect(rejectingQuery.interruptCalls).toBe(1);
    expect(rejectingQuery.permissionModes).toEqual(["bypassPermissions"]);

    const throwingQuery = new ThrowingQuery();
    const sessionId2 = `sdk-test-${Date.now()}-8`;
    createdSessionIds.push(sessionId2);
    const session2 = new SDKSession(sessionId2, { cwd: "/repo/test" }, false, {
      queryFactory: asQueryFactory(throwingQuery),
    });
    const sseTypes: string[] = [];
    session2.on("sse", (e) => sseTypes.push((e as { type: string }).type));

    await session2.start();
    session2.prompt("hello");
    await Bun.sleep(20);
    expect(sseTypes).toContain("process_died");
  });

  it("reports info/health correctly and supports factory constructors", async () => {
    const created = createSDKSession({ cwd: "/repo/factory" });
    createdSessionIds.push(created.id);
    await created.start();
    const createdInfo = created.getInfo();
    expect(createdInfo.id).toBe(created.id);
    expect(createdInfo.healthy).toBe(false);
    expect(createdInfo.stale).toBe(false);
    expect(created.isProcessRunning).toBe(false);

    (created as unknown as { lastActivityTime: number }).lastActivityTime =
      Date.now() - 6 * 60 * 1000;
    expect(created.getInfo().stale).toBe(true);
    await created.close();

    const resumed = resumeSDKSession(`sdk-test-${Date.now()}-9`, { cwd: "/repo/factory" });
    createdSessionIds.push(resumed.id);
    await resumed.start();
    expect(resumed.id).toMatch(/^sdk-test-/);
    expect(resumed.isActive).toBe(true);
    await resumed.close();
  });

  it("closes MessageChannel iterators cleanly when session closes", async () => {
    const fakeQuery = new FakeQuery();
    const sessionId = `sdk-test-${Date.now()}-10`;
    createdSessionIds.push(sessionId);

    let secondDone: boolean | undefined;
    let thirdDone: boolean | undefined;

    const session = new SDKSession(sessionId, { cwd: "/repo/test" }, false, {
      queryFactory: ((args: { prompt: AsyncIterable<unknown> }) => {
        void (async () => {
          const iter = args.prompt[Symbol.asyncIterator]();
          await iter.next();
          secondDone = (await iter.next()).done;
          thirdDone = (await iter.next()).done;
        })();
        return fakeQuery as unknown;
      }) as unknown as typeof import("@anthropic-ai/claude-agent-sdk").query,
    });

    await session.start();
    session.prompt("hello");
    await Bun.sleep(10);
    await session.close();
    await Bun.sleep(20);

    expect(secondDone === true).toBe(true);
    expect(thirdDone === true).toBe(true);
  });
});
