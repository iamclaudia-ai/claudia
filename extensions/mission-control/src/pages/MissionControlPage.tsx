/**
 * Mission Control Dashboard
 *
 * Discovers extensions with health-check methods and renders their status
 * generically based on the HealthCheckResponse shape.
 */

import { useState, useEffect, useCallback, useRef } from "react";
import { Link } from "@claudia/ui";
import type {
  HealthCheckResponse,
  HealthAction,
  HealthItem,
} from "@claudia/shared";

// Same-origin WebSocket URL (served from gateway)
const WS_URL = `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/ws`;

// ── Lightweight WebSocket Hook ───────────────────────────────

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

function useGatewayRpc() {
  const wsRef = useRef<WebSocket | null>(null);
  const pendingRef = useRef<Map<string, PendingRequest>>(new Map());
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    const ws = new WebSocket(WS_URL);
    wsRef.current = ws;

    ws.onopen = () => setConnected(true);
    ws.onclose = () => setConnected(false);
    ws.onerror = () => setConnected(false);

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === "res" && msg.id) {
          const pending = pendingRef.current.get(msg.id);
          if (pending) {
            pendingRef.current.delete(msg.id);
            if (msg.ok) {
              pending.resolve(msg.payload);
            } else {
              pending.reject(new Error(msg.error || "Request failed"));
            }
          }
        }
      } catch {
        // ignore parse errors
      }
    };

    return () => {
      ws.close();
      wsRef.current = null;
    };
  }, []);

  const request = useCallback(
    <T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> => {
      return new Promise((resolve, reject) => {
        const ws = wsRef.current;
        if (!ws || ws.readyState !== WebSocket.OPEN) {
          reject(new Error("Not connected"));
          return;
        }
        const id = Math.random().toString(36).slice(2, 10);
        pendingRef.current.set(id, {
          resolve: resolve as (v: unknown) => void,
          reject,
        });
        ws.send(JSON.stringify({ type: "req", id, method, params }));

        // Timeout after 10s
        setTimeout(() => {
          if (pendingRef.current.has(id)) {
            pendingRef.current.delete(id);
            reject(new Error("Request timeout"));
          }
        }, 10000);
      });
    },
    [],
  );

  return { request, connected };
}

// ── Types ────────────────────────────────────────────────────

interface ExtensionInfo {
  id: string;
  name: string;
  methods: string[];
}

interface ExtensionHealth {
  extension: ExtensionInfo;
  health: HealthCheckResponse | null;
  error?: string;
}

// ── Status Dot Component ─────────────────────────────────────

function StatusDot({ status }: { status: string }) {
  const colors: Record<string, string> = {
    healthy: "bg-emerald-400",
    degraded: "bg-yellow-400",
    stale: "bg-yellow-400",
    error: "bg-red-400",
    dead: "bg-red-400",
    disconnected: "bg-red-400",
    inactive: "bg-zinc-500",
  };
  const color = colors[status] || "bg-zinc-500";
  return (
    <span
      className={`inline-block w-2.5 h-2.5 rounded-full ${color} ${status === "healthy" ? "animate-pulse" : ""}`}
    />
  );
}

// ── Extension Health Card ────────────────────────────────────

function HealthCard({
  data,
  onAction,
}: {
  data: ExtensionHealth;
  onAction: (action: HealthAction, itemId?: string) => void;
}) {
  const { health, error } = data;

  if (error || !health) {
    return (
      <div className="rounded-xl border border-zinc-700/50 bg-zinc-800/50 p-5">
        <div className="flex items-center gap-2 mb-3">
          <StatusDot status="error" />
          <h3 className="text-sm font-medium text-zinc-200">
            {data.extension.name}
          </h3>
        </div>
        <p className="text-xs text-red-400">{error || "No response"}</p>
      </div>
    );
  }

  const globalActions = health.actions?.filter((a) => a.scope === "global") || [];

  return (
    <div className="rounded-xl border border-zinc-700/50 bg-zinc-800/50 p-5">
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <StatusDot status={health.status} />
          <h3 className="text-sm font-medium text-zinc-200">{health.label}</h3>
          <span className="text-xs text-zinc-500 capitalize">
            {health.status}
          </span>
        </div>
        <div className="flex gap-2">
          {globalActions.map((action) => (
            <button
              key={action.method}
              onClick={() => onAction(action)}
              className="text-xs px-2.5 py-1 rounded-md bg-zinc-700/50 text-zinc-300 hover:bg-zinc-600/50 transition-colors"
            >
              {action.label}
            </button>
          ))}
        </div>
      </div>

      {/* Metrics */}
      {health.metrics && health.metrics.length > 0 && (
        <div className="flex flex-wrap gap-x-6 gap-y-1 mb-4">
          {health.metrics.map((metric) => (
            <div key={metric.label} className="text-xs">
              <span className="text-zinc-500">{metric.label}: </span>
              <span className="text-zinc-300">{metric.value}</span>
            </div>
          ))}
        </div>
      )}

      {/* Items Table */}
      {health.items && health.items.length > 0 && (
        <div className="mt-3 border-t border-zinc-700/30 pt-3">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-zinc-500">
                <th className="text-left font-medium pb-2 pr-3">Status</th>
                <th className="text-left font-medium pb-2 pr-3">Resource</th>
                {/* Dynamic detail columns from first item */}
                {health.items[0]?.details &&
                  Object.keys(health.items[0].details).map((key) => (
                    <th
                      key={key}
                      className="text-left font-medium pb-2 pr-3 capitalize"
                    >
                      {key}
                    </th>
                  ))}
                {health.actions?.some((a) => a.scope === "item") && (
                  <th className="text-right font-medium pb-2">Actions</th>
                )}
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-700/30">
              {health.items.map((item) => (
                <ItemRow
                  key={item.id}
                  item={item}
                  actions={
                    health.actions?.filter((a) => a.scope === "item") || []
                  }
                  onAction={onAction}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Empty state */}
      {health.items && health.items.length === 0 && (
        <p className="text-xs text-zinc-600 italic">No active resources</p>
      )}
    </div>
  );
}

// ── Item Row ─────────────────────────────────────────────────

function ItemRow({
  item,
  actions,
  onAction,
}: {
  item: HealthItem;
  actions: HealthAction[];
  onAction: (action: HealthAction, itemId?: string) => void;
}) {
  return (
    <tr className="text-zinc-300">
      <td className="py-2 pr-3">
        <StatusDot status={item.status} />
      </td>
      <td className="py-2 pr-3 font-mono text-zinc-400">
        {item.label}
        <span className="text-zinc-600 ml-2">
          {item.id.length > 12 ? item.id.slice(0, 12) + "..." : item.id}
        </span>
      </td>
      {item.details &&
        Object.values(item.details).map((value, i) => (
          <td key={i} className="py-2 pr-3">
            {value}
          </td>
        ))}
      {actions.length > 0 && (
        <td className="py-2 text-right">
          <div className="flex gap-1.5 justify-end">
            {actions.map((action) => (
              <button
                key={action.method}
                onClick={() => onAction(action, item.id)}
                className="px-2 py-0.5 rounded bg-red-900/30 text-red-400 hover:bg-red-900/50 transition-colors"
              >
                {action.label}
              </button>
            ))}
          </div>
        </td>
      )}
    </tr>
  );
}

// ── Main Page Component ──────────────────────────────────────

export function MissionControlPage() {
  const { request, connected } = useGatewayRpc();
  const [healthData, setHealthData] = useState<ExtensionHealth[]>([]);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [loading, setLoading] = useState(true);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const refresh = useCallback(async () => {
    if (!connected) return;

    try {
      // Step 1: Discover extensions
      const { extensions } = await request<{ extensions: ExtensionInfo[] }>(
        "extension.list",
      );

      // Step 2: Filter for health-check capable extensions
      const healthExtensions = extensions.filter((ext) =>
        ext.methods.some((m) => m.endsWith(".health-check")),
      );

      // Step 3: Call each health-check in parallel
      const results = await Promise.allSettled(
        healthExtensions.map(async (ext) => {
          const healthMethod = ext.methods.find((m) =>
            m.endsWith(".health-check"),
          )!;
          const health = await request<HealthCheckResponse>(healthMethod);
          return { extension: ext, health } as ExtensionHealth;
        }),
      );

      const healthData = results.map((result, i) => {
        if (result.status === "fulfilled") {
          return result.value;
        }
        return {
          extension: healthExtensions[i],
          health: null,
          error: result.reason?.message || "Failed to fetch health",
        } as ExtensionHealth;
      });

      setHealthData(healthData);
      setLastUpdated(new Date());
    } catch (error) {
      console.error("[MissionControl] Refresh failed:", error);
    } finally {
      setLoading(false);
    }
  }, [connected, request]);

  // Poll every 5 seconds
  useEffect(() => {
    if (!connected) return;

    refresh();
    intervalRef.current = setInterval(refresh, 5000);
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [connected, refresh]);

  // Handle actions
  const handleAction = useCallback(
    async (action: HealthAction, itemId?: string) => {
      // Confirmation dialog
      if (action.confirm) {
        if (!window.confirm(action.confirm)) return;
      }

      // Resolve params
      const params: Record<string, unknown> = {};
      for (const param of action.params) {
        if (param.source === "item.id" && itemId) {
          params[param.name] = itemId;
        } else if (param.source === "input") {
          const value = window.prompt(`Enter ${param.name}:`);
          if (value === null) return; // Cancelled
          params[param.name] = value;
        }
      }

      try {
        await request(action.method, params);
        // Refresh immediately after action
        setTimeout(refresh, 500);
      } catch (error) {
        console.error(`[MissionControl] Action failed:`, error);
      }
    },
    [request, refresh],
  );

  return (
    <div className="min-h-screen bg-zinc-900 text-zinc-100">
      {/* Header */}
      <div className="border-b border-zinc-800 px-6 py-4">
        <div className="flex items-center justify-between max-w-5xl mx-auto">
          <div className="flex items-center gap-3">
            <Link
              href="/"
              className="text-zinc-500 hover:text-zinc-300 transition-colors"
            >
              &larr;
            </Link>
            <h1 className="text-lg font-semibold">Mission Control</h1>
            <span className="flex items-center gap-1.5 text-xs text-zinc-500">
              <StatusDot status={connected ? "healthy" : "disconnected"} />
              {connected ? "Connected" : "Disconnected"}
            </span>
          </div>
          <div className="flex items-center gap-3">
            {lastUpdated && (
              <span className="text-xs text-zinc-600">
                Updated {formatTimeAgo(lastUpdated)}
              </span>
            )}
            <button
              onClick={refresh}
              className="text-xs px-3 py-1.5 rounded-md bg-zinc-800 text-zinc-400 hover:bg-zinc-700 hover:text-zinc-300 transition-colors"
            >
              Refresh
            </button>
          </div>
        </div>
      </div>

      {/* Content */}
      <div className="max-w-5xl mx-auto px-6 py-6">
        {loading ? (
          <div className="text-center py-12 text-zinc-500">
            Loading health data...
          </div>
        ) : healthData.length === 0 ? (
          <div className="text-center py-12 text-zinc-500">
            No extensions with health checks found
          </div>
        ) : (
          <div className="space-y-4">
            {healthData.map((data) => (
              <HealthCard
                key={data.extension.id}
                data={data}
                onAction={handleAction}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Helpers ──────────────────────────────────────────────────

function formatTimeAgo(date: Date): string {
  const seconds = Math.round((Date.now() - date.getTime()) / 1000);
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  return `${Math.round(seconds / 60)}m ago`;
}
