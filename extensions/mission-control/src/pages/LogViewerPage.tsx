/**
 * Log Viewer Page
 *
 * Real-time log tailing from the browser. Poll-based (every 2s),
 * tracks file byte offset for incremental reads.
 */

import { useState, useEffect, useCallback, useRef } from "react";
import { Link } from "@claudia/ui";

// Same-origin WebSocket URL
const WS_URL = `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/ws`;

// ── Lightweight WebSocket Hook (shared pattern with MissionControlPage) ──

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
        // ignore
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

interface LogFile {
  name: string;
  size: number;
  modified: string;
}

interface TailResponse {
  lines: string[];
  offset: number;
  fileSize: number;
}

type LogLevel = "ALL" | "INFO" | "WARN" | "ERROR";

// ── Log Line Component ──────────────────────────────────────

function LogLine({ line }: { line: string }) {
  // Colorize based on log level
  let levelClass = "text-zinc-400";
  if (line.includes("[ERROR]")) levelClass = "text-red-400";
  else if (line.includes("[WARN]")) levelClass = "text-yellow-400";
  else if (line.includes("[INFO]")) levelClass = "text-zinc-400";

  // Highlight timestamp
  const timestampMatch = line.match(/^\[(\d{4}-\d{2}-\d{2}T[\d:.]+Z?)\]/);
  if (timestampMatch) {
    const ts = timestampMatch[1];
    const rest = line.slice(timestampMatch[0].length);
    return (
      <div className={`font-mono text-xs leading-relaxed whitespace-pre-wrap ${levelClass}`}>
        <span className="text-zinc-600">[{ts}]</span>
        {rest}
      </div>
    );
  }

  return (
    <div className={`font-mono text-xs leading-relaxed whitespace-pre-wrap ${levelClass}`}>
      {line}
    </div>
  );
}

// ── Main Page Component ─────────────────────────────────────

export function LogViewerPage() {
  const { request, connected } = useGatewayRpc();
  const [files, setFiles] = useState<LogFile[]>([]);
  const [selectedFile, setSelectedFile] = useState<string>("");
  const [lines, setLines] = useState<string[]>([]);
  const [levelFilter, setLevelFilter] = useState<LogLevel>("ALL");
  const [paused, setPaused] = useState(false);
  const [autoScroll, setAutoScroll] = useState(true);

  const offsetRef = useRef(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Load file list
  useEffect(() => {
    if (!connected) return;
    request<{ files: LogFile[] }>("mission-control.log-list").then(({ files }) => {
      setFiles(files);
      // Auto-select first file (usually most recent)
      if (files.length > 0 && !selectedFile) {
        // Prefer gateway.log or runtime.log
        const preferred = files.find((f) => f.name === "gateway.log" || f.name === "runtime.log");
        setSelectedFile(preferred?.name || files[0].name);
      }
    });
  }, [connected, request, selectedFile]);

  // Tail the selected file
  const tail = useCallback(async () => {
    if (!connected || !selectedFile || paused) return;

    try {
      const result = await request<TailResponse>("mission-control.log-tail", {
        file: selectedFile,
        lines: 200,
        offset: offsetRef.current,
      });

      if (result.lines.length > 0) {
        setLines((prev) => {
          const combined = [...prev, ...result.lines];
          // Keep max 2000 lines in memory
          return combined.length > 2000 ? combined.slice(-2000) : combined;
        });
      }
      offsetRef.current = result.offset;
    } catch {
      // Ignore tail errors (file might not exist yet)
    }
  }, [connected, selectedFile, paused, request]);

  // Poll every 2s
  useEffect(() => {
    if (!selectedFile || !connected) return;

    // Reset on file change
    setLines([]);
    offsetRef.current = 0;

    // Initial load
    tail();

    intervalRef.current = setInterval(tail, 2000);
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [selectedFile, connected, tail]);

  // Auto-scroll to bottom
  useEffect(() => {
    if (autoScroll && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [lines, autoScroll]);

  // Filter lines by level
  const filteredLines =
    levelFilter === "ALL" ? lines : lines.filter((l) => l.includes(`[${levelFilter}]`));

  const formatSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes}B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
  };

  return (
    <div className="min-h-screen bg-zinc-900 text-zinc-100 flex flex-col">
      {/* Header */}
      <div className="border-b border-zinc-800 px-6 py-4 flex-shrink-0">
        <div className="flex items-center justify-between max-w-7xl mx-auto">
          <div className="flex items-center gap-3">
            <Link
              to="/mission-control"
              className="text-zinc-500 hover:text-zinc-300 transition-colors"
            >
              &larr;
            </Link>
            <h1 className="text-lg font-semibold">Log Viewer</h1>
          </div>

          <div className="flex items-center gap-3">
            {/* File selector */}
            <select
              value={selectedFile}
              onChange={(e) => setSelectedFile(e.target.value)}
              className="text-xs bg-zinc-800 border border-zinc-700 rounded-md px-2 py-1.5 text-zinc-300 focus:outline-none focus:border-zinc-600"
            >
              {files.map((f) => (
                <option key={f.name} value={f.name}>
                  {f.name} ({formatSize(f.size)})
                </option>
              ))}
            </select>

            {/* Level filter */}
            <div className="flex gap-1">
              {(["ALL", "INFO", "WARN", "ERROR"] as LogLevel[]).map((level) => (
                <button
                  key={level}
                  onClick={() => setLevelFilter(level)}
                  className={`text-xs px-2 py-1 rounded-md transition-colors ${
                    levelFilter === level
                      ? level === "ERROR"
                        ? "bg-red-900/50 text-red-400"
                        : level === "WARN"
                          ? "bg-yellow-900/50 text-yellow-400"
                          : "bg-zinc-700 text-zinc-200"
                      : "bg-zinc-800/50 text-zinc-500 hover:text-zinc-300"
                  }`}
                >
                  {level}
                </button>
              ))}
            </div>

            {/* Pause/Resume */}
            <button
              onClick={() => setPaused(!paused)}
              className={`text-xs px-3 py-1.5 rounded-md transition-colors ${
                paused
                  ? "bg-emerald-900/30 text-emerald-400 hover:bg-emerald-900/50"
                  : "bg-zinc-800 text-zinc-400 hover:bg-zinc-700"
              }`}
            >
              {paused ? "▶ Resume" : "⏸ Pause"}
            </button>

            {/* Auto-scroll toggle */}
            <button
              onClick={() => setAutoScroll(!autoScroll)}
              className={`text-xs px-2 py-1.5 rounded-md transition-colors ${
                autoScroll ? "bg-zinc-700 text-zinc-200" : "bg-zinc-800/50 text-zinc-500"
              }`}
              title="Auto-scroll to bottom"
            >
              ↓
            </button>

            {/* Clear */}
            <button
              onClick={() => {
                setLines([]);
                offsetRef.current = 0;
              }}
              className="text-xs px-2 py-1.5 rounded-md bg-zinc-800/50 text-zinc-500 hover:text-zinc-300 transition-colors"
            >
              Clear
            </button>
          </div>
        </div>
      </div>

      {/* Log Output */}
      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto px-6 py-4 max-w-7xl mx-auto w-full"
        onScroll={() => {
          // Disable auto-scroll if user scrolls up
          if (scrollRef.current) {
            const { scrollTop, scrollHeight, clientHeight } = scrollRef.current;
            const isAtBottom = scrollHeight - scrollTop - clientHeight < 50;
            if (!isAtBottom && autoScroll) setAutoScroll(false);
            if (isAtBottom && !autoScroll) setAutoScroll(true);
          }
        }}
      >
        {filteredLines.length === 0 ? (
          <div className="text-center py-12 text-zinc-600">
            {selectedFile ? "Waiting for log entries..." : "Select a log file"}
          </div>
        ) : (
          filteredLines.map((line, i) => <LogLine key={i} line={line} />)
        )}
      </div>

      {/* Footer status bar */}
      <div className="border-t border-zinc-800 px-6 py-2 flex-shrink-0">
        <div className="flex items-center justify-between max-w-7xl mx-auto text-xs text-zinc-600">
          <span>
            {filteredLines.length} lines
            {levelFilter !== "ALL" && ` (filtered from ${lines.length})`}
          </span>
          <span>
            {paused && "⏸ Paused · "}
            {selectedFile && `offset: ${offsetRef.current.toLocaleString()} bytes`}
          </span>
        </div>
      </div>
    </div>
  );
}
