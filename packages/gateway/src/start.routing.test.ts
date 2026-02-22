import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:net";

type GatewayMsg =
  | { type: "event"; event: string; payload: unknown }
  | { type: "res"; id: string; ok: boolean; payload?: unknown; error?: string }
  | { type: string; [key: string]: unknown };

async function getFreePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    const timer = setTimeout(() => {
      try {
        server.close();
      } catch {
        // ignore
      }
      reject(new Error("Timed out reserving free port"));
    }, 3000);
    server.listen(0, "127.0.0.1", () => {
      clearTimeout(timer);
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Failed to reserve free port"));
        return;
      }
      const port = address.port;
      server.close(() => resolve(port));
    });
  });
}

class WsClient {
  private ws: WebSocket;
  private inbox: GatewayMsg[] = [];
  private isOpen = false;

  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.ws.addEventListener("open", () => {
      this.isOpen = true;
    });
    this.ws.addEventListener("message", (event) => {
      this.inbox.push(JSON.parse(String(event.data)) as GatewayMsg);
    });
  }

  async waitOpen(timeoutMs = 5000): Promise<void> {
    const start = Date.now();
    while (!this.isOpen && Date.now() - start < timeoutMs) {
      await Bun.sleep(10);
    }
    if (!this.isOpen) throw new Error("WebSocket did not open");
  }

  async waitFor(predicate: (msg: GatewayMsg) => boolean, timeoutMs = 5000): Promise<GatewayMsg> {
    const existing = this.inbox.find(predicate);
    if (existing) return existing;

    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      await Bun.sleep(10);
      const found = this.inbox.find(predicate);
      if (found) return found;
    }
    throw new Error(`Timed out waiting for message. Seen: ${JSON.stringify(this.inbox)}`);
  }

  pop(eventName: string): GatewayMsg[] {
    const matched = this.inbox.filter(
      (m) => m.type === "event" && (m as { event?: string }).event === eventName,
    );
    this.inbox = this.inbox.filter(
      (m) => !(m.type === "event" && (m as { event?: string }).event === eventName),
    );
    return matched;
  }

  clear(): void {
    this.inbox = [];
  }

  send(msg: Record<string, unknown>): void {
    this.ws.send(JSON.stringify(msg));
  }

  close(): void {
    this.ws.close();
  }
}

describe("gateway routing (isolated process)", () => {
  let proc: Bun.Subprocess<"pipe", "pipe", "pipe">;
  let port: number;
  let cfgDir: string;
  let dataDir: string;

  beforeAll(async () => {
    port = await getFreePort();
    cfgDir = mkdtempSync(join(tmpdir(), "claudia-gateway-cfg-"));
    dataDir = mkdtempSync(join(tmpdir(), "claudia-gateway-data-"));
    const configPath = join(cfgDir, "claudia.json");

    writeFileSync(
      configPath,
      JSON.stringify(
        {
          gateway: { port, host: "127.0.0.1" },
          session: { model: "sonnet", thinking: false, effort: "medium", systemPrompt: null },
          extensions: {
            testroute: { enabled: true, config: {} },
          },
          federation: { enabled: false, nodeId: "test", peers: [] },
        },
        null,
        2,
      ),
    );

    proc = Bun.spawn(["bun", "packages/gateway/src/start.ts"], {
      cwd: join(import.meta.dir, "..", "..", ".."),
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        CLAUDIA_CONFIG: configPath,
        CLAUDIA_DATA_DIR: dataDir,
        CLAUDIA_SKIP_ORPHAN_KILL: "true",
      },
    });

    // Drain output to avoid backpressure.
    void new Response(proc.stdout).text();
    void new Response(proc.stderr).text();

    const healthUrl = `http://127.0.0.1:${port}/health`;
    const start = Date.now();
    while (Date.now() - start < 10_000) {
      try {
        const res = await fetch(healthUrl);
        if (res.ok) {
          const body = (await res.json()) as {
            extensions?: Record<string, { ok: boolean }>;
          };
          if (body.extensions?.testroute) return;
        }
      } catch {
        // retry
      }
      await Bun.sleep(50);
    }

    throw new Error("Gateway did not become healthy in time");
  });

  afterAll(async () => {
    try {
      proc.kill("SIGTERM");
      await Promise.race([proc.exited, Bun.sleep(3000)]);
      if (proc.exitCode === null) {
        proc.kill("SIGKILL");
        await proc.exited;
      }
    } catch {
      // ignore
    }
    rmSync(cfgDir, { recursive: true, force: true });
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("sends gateway.caller events only to the requesting client", async () => {
    const url = `ws://127.0.0.1:${port}/ws`;
    const a = new WsClient(url);
    const b = new WsClient(url);
    await a.waitOpen();
    await b.waitOpen();

    await a.waitFor(
      (m) => m.type === "event" && (m as { event?: string }).event === "gateway.welcome",
    );
    await b.waitFor(
      (m) => m.type === "event" && (m as { event?: string }).event === "gateway.welcome",
    );

    const subA = crypto.randomUUID();
    a.send({
      type: "req",
      id: subA,
      method: "gateway.subscribe",
      params: { events: ["testroute.event"] },
    });
    await a.waitFor((m) => m.type === "res" && (m as { id?: string }).id === subA);

    const subB = crypto.randomUUID();
    b.send({
      type: "req",
      id: subB,
      method: "gateway.subscribe",
      params: { events: ["testroute.event"] },
    });
    await b.waitFor((m) => m.type === "res" && (m as { id?: string }).id === subB);

    a.clear();
    b.clear();

    const reqId = crypto.randomUUID();
    a.send({
      type: "req",
      id: reqId,
      method: "testroute.emit_targeted",
      params: { message: "only-a" },
    });
    await a.waitFor((m) => m.type === "res" && (m as { id?: string }).id === reqId);
    await Bun.sleep(100);

    const aEvents = a.pop("testroute.event");
    const bEvents = b.pop("testroute.event");
    expect(aEvents).toHaveLength(1);
    expect((aEvents[0] as { payload?: { message?: string } }).payload?.message).toBe("only-a");
    expect(bEvents).toHaveLength(0);

    a.close();
    b.close();
  });

  it("enforces exclusive subscriber precedence (last wins)", async () => {
    const url = `ws://127.0.0.1:${port}/ws`;
    const a = new WsClient(url);
    const b = new WsClient(url);
    await a.waitOpen();
    await b.waitOpen();

    await a.waitFor(
      (m) => m.type === "event" && (m as { event?: string }).event === "gateway.welcome",
    );
    await b.waitFor(
      (m) => m.type === "event" && (m as { event?: string }).event === "gateway.welcome",
    );

    const subA = crypto.randomUUID();
    a.send({
      type: "req",
      id: subA,
      method: "gateway.subscribe",
      params: { events: ["testroute.event"], exclusive: true },
    });
    await a.waitFor((m) => m.type === "res" && (m as { id?: string }).id === subA);

    const subB = crypto.randomUUID();
    b.send({
      type: "req",
      id: subB,
      method: "gateway.subscribe",
      params: { events: ["testroute.event"], exclusive: true },
    });
    await b.waitFor((m) => m.type === "res" && (m as { id?: string }).id === subB);

    a.clear();
    b.clear();

    const reqId = crypto.randomUUID();
    a.send({
      type: "req",
      id: reqId,
      method: "testroute.emit_public",
      params: { message: "exclusive" },
    });
    await a.waitFor((m) => m.type === "res" && (m as { id?: string }).id === reqId);
    await Bun.sleep(100);

    const aEvents = a.pop("testroute.event");
    const bEvents = b.pop("testroute.event");
    expect(aEvents).toHaveLength(0);
    expect(bEvents).toHaveLength(1);
    expect((bEvents[0] as { payload?: { message?: string } }).payload?.message).toBe("exclusive");

    a.close();
    b.close();
  });
});
