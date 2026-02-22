import { afterEach, describe, expect, it } from "bun:test";
import { join } from "node:path";

type HostMsg = Record<string, unknown>;

class HostHarness {
  private proc: Bun.Subprocess<"pipe", "pipe", "pipe">;
  private lines: HostMsg[] = [];
  private stdoutDone = false;

  constructor() {
    const fixture = join(import.meta.dir, "__fixtures__", "test-extension.ts");
    this.proc = Bun.spawn(["bun", fixture, "{}"], {
      cwd: join(import.meta.dir, "..", "..", ".."),
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    this.readStdout();
    this.readStderr();
  }

  async waitFor(predicate: (msg: HostMsg) => boolean, timeoutMs = 3000): Promise<HostMsg> {
    const existing = this.lines.find(predicate);
    if (existing) return existing;

    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      await Bun.sleep(10);
      const found = this.lines.find(predicate);
      if (found) return found;
      if (this.stdoutDone) break;
    }

    throw new Error(`Timed out waiting for host message. Seen: ${JSON.stringify(this.lines)}`);
  }

  send(msg: HostMsg): void {
    this.proc.stdin.write(JSON.stringify(msg) + "\n");
  }

  async stop(): Promise<void> {
    try {
      this.proc.stdin.end();
    } catch {
      // ignore
    }

    const exited = await Promise.race([
      this.proc.exited.then(() => true),
      Bun.sleep(2000).then(() => false),
    ]);
    if (!exited) {
      this.proc.kill("SIGKILL");
      await this.proc.exited;
    }
  }

  private async readStdout(): Promise<void> {
    const reader = this.proc.stdout.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, idx).trim();
          buffer = buffer.slice(idx + 1);
          if (!line) continue;
          try {
            this.lines.push(JSON.parse(line) as HostMsg);
          } catch {
            // ignore non-json noise
          }
        }
      }
    } finally {
      this.stdoutDone = true;
    }
  }

  private async readStderr(): Promise<void> {
    const reader = this.proc.stderr.getReader();
    try {
      while (true) {
        const { done } = await reader.read();
        if (done) break;
      }
    } catch {
      // ignore
    }
  }
}

describe("runExtensionHost", () => {
  let host: HostHarness | null = null;

  afterEach(async () => {
    if (host) {
      await host.stop();
      host = null;
    }
  });

  it("registers and handles req with connection/tag context", async () => {
    host = new HostHarness();
    await host.waitFor((m) => m.type === "register");

    host.send({
      type: "req",
      id: "r1",
      method: "fixture.echo",
      params: { value: "ok" },
      connectionId: "conn-1",
      tags: ["voice"],
      traceId: "trace-1",
      depth: 2,
      deadlineMs: Date.now() + 60_000,
    });

    const res = await host.waitFor((m) => m.type === "res" && m.id === "r1");
    expect(res.ok).toBe(true);
    expect(res.payload).toEqual({
      params: { value: "ok" },
      connectionId: "conn-1",
      tags: ["voice"],
    });
  });

  it("stamps ambient envelope metadata on ctx.emit and ctx.call", async () => {
    host = new HostHarness();
    await host.waitFor((m) => m.type === "register");

    host.send({
      type: "req",
      id: "r2",
      method: "fixture.emit_context",
      params: {},
      connectionId: "conn-emit",
      tags: ["t-emit"],
      traceId: "trace-emit",
      depth: 1,
      deadlineMs: Date.now() + 60_000,
    });
    const evt = await host.waitFor((m) => m.type === "event" && m.event === "fixture.context");
    expect(evt.connectionId).toBe("conn-emit");
    expect(evt.tags).toEqual(["t-emit"]);

    host.send({
      type: "req",
      id: "r3",
      method: "fixture.call_through",
      params: {},
      connectionId: "conn-call",
      tags: ["t-call"],
      traceId: "trace-call",
      depth: 4,
      deadlineMs: Date.now() + 60_000,
    });
    const call = await host.waitFor((m) => m.type === "call" && m.method === "session.send_prompt");
    expect(call.connectionId).toBe("conn-call");
    expect(call.tags).toEqual(["t-call"]);
    expect(call.traceId).toBe("trace-call");
    expect(call.depth).toBe(5);

    host.send({
      type: "call_res",
      id: call.id,
      ok: true,
      payload: { text: "pong" },
    });
    const res = await host.waitFor((m) => m.type === "res" && m.id === "r3");
    expect(res.ok).toBe(true);
    expect(res.payload).toEqual({ text: "pong" });
  });

  it("uses event envelope context for handler-initiated ctx.call/emit", async () => {
    host = new HostHarness();
    await host.waitFor((m) => m.type === "register");

    host.send({
      type: "event",
      event: "trigger.call",
      payload: {},
      connectionId: "conn-event",
      tags: ["t-event"],
    });

    const call = await host.waitFor((m) => m.type === "call" && m.method === "from.event");
    expect(call.connectionId).toBe("conn-event");
    expect(call.tags).toEqual(["t-event"]);
    expect(call.depth).toBe(1);

    host.send({ type: "call_res", id: call.id, ok: true, payload: { ok: true } });
    const event = await host.waitFor(
      (m) => m.type === "event" && m.event === "fixture.after_event",
    );
    expect(event.connectionId).toBe("conn-event");
    expect(event.tags).toEqual(["t-event"]);
  });

  it("handles __health, __sourceResponse, and method errors", async () => {
    host = new HostHarness();
    await host.waitFor((m) => m.type === "register");

    host.send({ type: "req", id: "h1", method: "__health", params: {} });
    const health = await host.waitFor((m) => m.type === "res" && m.id === "h1");
    expect(health.ok).toBe(true);
    expect(health.payload).toEqual({ ok: true, details: { fixture: true } });

    host.send({
      type: "req",
      id: "s1",
      method: "__sourceResponse",
      params: {
        source: "fixture-src/client-1",
        event: { type: "session.done", payload: {}, timestamp: Date.now() },
      },
      connectionId: "conn-src",
      tags: ["src-tag"],
    });
    const sourceRes = await host.waitFor((m) => m.type === "res" && m.id === "s1");
    expect(sourceRes.ok).toBe(true);
    const routedEvent = await host.waitFor(
      (m) => m.type === "event" && m.event === "fixture.routed",
    );
    expect(routedEvent.connectionId).toBe("conn-src");
    expect(routedEvent.tags).toEqual(["src-tag"]);

    host.send({ type: "req", id: "e1", method: "fixture.fail", params: {} });
    const err = await host.waitFor((m) => m.type === "res" && m.id === "e1");
    expect(err.ok).toBe(false);
    expect(String(err.error)).toContain("fixture boom");
  });
});
