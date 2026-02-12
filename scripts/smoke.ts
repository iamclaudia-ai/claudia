#!/usr/bin/env bun

const gatewayHttp = process.env.CLAUDIA_GATEWAY_HTTP || "http://localhost:30086";
const gatewayWs = process.env.CLAUDIA_GATEWAY_WS || "ws://localhost:30086/ws";

interface Message {
  type: "req" | "res" | "event";
  id?: string;
  method?: string;
  params?: Record<string, unknown>;
  ok?: boolean;
  payload?: unknown;
  error?: string;
  event?: string;
}

function id(): string {
  return Math.random().toString(36).slice(2, 10);
}

async function checkHealth(): Promise<void> {
  const res = await fetch(`${gatewayHttp}/health`, { signal: AbortSignal.timeout(3000) });
  if (!res.ok) {
    throw new Error(`Gateway health failed: HTTP ${res.status}`);
  }
  const body = (await res.json()) as Record<string, unknown>;
  const isHealthy = body.ok === true || body.status === "ok";
  if (!isHealthy) {
    throw new Error(`Gateway unhealthy: ${JSON.stringify(body)}`);
  }
}

async function methodListSmoke(): Promise<number> {
  const ws = new WebSocket(gatewayWs);
  return new Promise((resolve, reject) => {
    const reqId = id();

    ws.onopen = () => {
      ws.send(JSON.stringify({ type: "req", id: reqId, method: "method.list", params: {} } satisfies Message));
    };

    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data as string) as Message;
      if (msg.type !== "res" || msg.id !== reqId) return;

      if (!msg.ok) {
        ws.close();
        reject(new Error(msg.error || "method.list failed"));
        return;
      }

      const methods = ((msg.payload as { methods?: unknown[] })?.methods ?? []);
      ws.close();
      resolve(methods.length);
    };

    ws.onerror = () => reject(new Error(`WebSocket failed: ${gatewayWs}`));
  });
}

async function main(): Promise<void> {
  await checkHealth();
  const methodCount = await methodListSmoke();
  console.log(`[smoke] OK: gateway healthy + method.list returned ${methodCount} methods`);
}

main().catch((err) => {
  console.error(`[smoke] FAIL: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
