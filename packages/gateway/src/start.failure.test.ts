import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:net";

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

describe("gateway startup failure handling", () => {
  let proc: Bun.Subprocess<"pipe", "pipe", "pipe">;
  let port: number;
  let cfgDir: string;
  let dataDir: string;

  beforeAll(async () => {
    port = await getFreePort();
    cfgDir = mkdtempSync(join(tmpdir(), "claudia-gateway-fail-cfg-"));
    dataDir = mkdtempSync(join(tmpdir(), "claudia-gateway-fail-data-"));
    const configPath = join(cfgDir, "claudia.json");

    writeFileSync(
      configPath,
      JSON.stringify(
        {
          gateway: { port, host: "127.0.0.1" },
          session: { model: "sonnet", thinking: false, effort: "medium", systemPrompt: null },
          extensions: {
            testroute: { enabled: true, config: {} },
            does_not_exist: { enabled: true, config: {} },
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

    // Drain logs to avoid backpressure.
    void new Response(proc.stdout).text();
    void new Response(proc.stderr).text();
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

  it("continues startup and serves healthy gateway even if one extension entrypoint is missing", async () => {
    type HealthPayload = {
      status?: string;
      extensions?: Record<string, { ok: boolean }>;
      sourceRoutes?: Record<string, string>;
    };
    const healthUrl = `http://127.0.0.1:${port}/health`;
    const start = Date.now();
    let body: HealthPayload | null = null;

    while (Date.now() - start < 10_000) {
      try {
        const res = await fetch(healthUrl);
        if (res.ok) {
          body = (await res.json()) as HealthPayload;
          if (body?.extensions?.testroute) break;
        }
      } catch {
        // retry
      }
      await Bun.sleep(50);
    }

    expect(body?.status).toBe("ok");
    expect(body?.extensions?.testroute?.ok).toBe(true);
    expect(body?.extensions?.does_not_exist).toBeUndefined();
    expect(body?.sourceRoutes?.does_not_exist).toBeUndefined();
  });
});
