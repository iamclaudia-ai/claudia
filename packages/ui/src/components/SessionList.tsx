import { useState, useEffect, useRef, useCallback } from "react";
import type { GatewayMessage } from "../types";
import type { WorkspaceInfo, SessionInfo } from "../hooks/useGateway";

interface SessionListProps {
  gatewayUrl: string;
  workspaceId: string;
  onSelectSession: (sessionId: string, workspaceId: string) => void;
  onBack: () => void;
}

function generateId(): string {
  return Math.random().toString(36).slice(2, 10);
}

export function SessionList({
  gatewayUrl,
  workspaceId,
  onSelectSession,
  onBack,
}: SessionListProps) {
  const [workspace, setWorkspace] = useState<WorkspaceInfo | null>(null);
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [isConnected, setIsConnected] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [isCreating, setIsCreating] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const pendingRef = useRef<Map<string, string>>(new Map());

  const sendRequest = useCallback((method: string, params?: Record<string, unknown>) => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
    const id = generateId();
    const msg: GatewayMessage = { type: "req", id, method, params };
    pendingRef.current.set(id, method);
    wsRef.current.send(JSON.stringify(msg));
  }, []);

  useEffect(() => {
    const ws = new WebSocket(gatewayUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      setIsConnected(true);
      // First get the workspace to learn its CWD, then list sessions
      sendRequest("session.get-workspace", { id: workspaceId });
    };

    ws.onclose = () => setIsConnected(false);

    ws.onmessage = (event) => {
      const data: GatewayMessage = JSON.parse(event.data);
      if (data.type === "res" && data.ok && data.payload) {
        const payload = data.payload as Record<string, unknown>;
        const method = data.id ? pendingRef.current.get(data.id) : undefined;
        if (data.id) pendingRef.current.delete(data.id);

        if (method === "session.get-workspace") {
          const ws = payload.workspace as WorkspaceInfo | undefined;
          if (ws) {
            setWorkspace(ws);
            // Now list sessions using the workspace CWD
            sendRequest("session.list-sessions", { cwd: ws.cwd });
          }
        }

        if (method === "session.list-sessions") {
          const list = payload.sessions as SessionInfo[] | undefined;
          setSessions(list || []);
          setIsLoading(false);
        }

        if (method === "session.create-session") {
          const newSessionId = payload.sessionId as string | undefined;
          if (newSessionId) {
            setIsCreating(false);
            // Navigate straight to the new session
            onSelectSession(newSessionId, workspaceId);
          }
        }
      }

      // Handle errors
      if (data.type === "res" && !data.ok) {
        setIsCreating(false);
      }
    };

    return () => {
      ws.close();
    };
  }, [gatewayUrl, workspaceId, sendRequest]);

  const formatSessionName = (s: SessionInfo) => {
    if (s.firstPrompt) {
      // Truncate to ~60 chars
      return s.firstPrompt.length > 60 ? s.firstPrompt.slice(0, 57) + "..." : s.firstPrompt;
    }
    return `Session ${s.sessionId.slice(0, 8)}...`;
  };

  const formatTime = (dateStr: string) => {
    const date = new Date(dateStr);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    if (diffMins < 1) return "just now";
    if (diffMins < 60) return `${diffMins}m ago`;
    const diffHours = Math.floor(diffMins / 60);
    if (diffHours < 24) return `${diffHours}h ago`;
    const diffDays = Math.floor(diffHours / 24);
    if (diffDays < 30) return `${diffDays}d ago`;
    return date.toLocaleDateString();
  };

  // Sort by most recently modified
  const sortedSessions = [...sessions].sort((a, b) => {
    const aTime = new Date(a.modified || a.created || 0).getTime();
    const bTime = new Date(b.modified || b.created || 0).getTime();
    return bTime - aTime;
  });

  return (
    <div className="flex flex-col h-screen max-w-3xl mx-auto">
      <header className="p-6 border-b border-gray-200">
        <div className="flex items-center gap-3">
          <button
            onClick={onBack}
            className="p-1 rounded hover:bg-gray-100 transition-colors text-gray-400 hover:text-gray-600"
            title="Back to workspaces"
          >
            <svg
              className="w-5 h-5"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
            </svg>
          </button>
          <div>
            <h1 className="text-2xl font-semibold">{workspace?.name || "..."}</h1>
            {workspace && <p className="text-xs text-gray-400 mt-0.5">{workspace.cwd}</p>}
          </div>
        </div>
        <div className="flex items-center justify-between mt-2">
          <p className="text-gray-500">Sessions</p>
          <div className="flex items-center gap-3 text-sm">
            <button
              onClick={() => {
                if (!workspace?.cwd) return;
                setIsCreating(true);
                sendRequest("session.create-session", { cwd: workspace.cwd });
              }}
              disabled={isCreating || !workspace?.cwd}
              className="flex items-center gap-1.5 px-3 py-1 rounded-lg text-xs font-medium text-blue-600 bg-blue-50 hover:bg-blue-100 disabled:opacity-50 transition-colors"
            >
              <svg
                className="w-3.5 h-3.5"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2}
              >
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
              </svg>
              {isCreating ? "Creating..." : "New Session"}
            </button>
            <div className="flex items-center gap-1.5">
              <span
                className={`w-2 h-2 rounded-full ${isConnected ? "bg-green-500" : "bg-red-500"}`}
              />
              <span className="text-gray-500">
                {sessions.length} session{sessions.length !== 1 ? "s" : ""}
              </span>
            </div>
          </div>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto p-6">
        {isLoading ? (
          <div className="text-center text-gray-400 py-12">Loading sessions...</div>
        ) : sessions.length === 0 ? (
          <div className="text-center text-gray-400 py-12">
            <p className="text-lg mb-2">No sessions yet</p>
            <p className="text-sm">
              Start a conversation in this workspace to create your first session.
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            {sortedSessions.map((s) => (
              <SessionCard
                key={s.sessionId}
                session={s}
                formatName={formatSessionName}
                formatTime={formatTime}
                onClick={() => onSelectSession(s.sessionId, workspaceId)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function SessionCard({
  session,
  formatName,
  formatTime,
  onClick,
}: {
  session: SessionInfo;
  formatName: (s: SessionInfo) => string;
  formatTime: (dateStr: string) => string;
  onClick: () => void;
}) {
  const timeStr = session.modified || session.created;

  return (
    <button
      onClick={onClick}
      className="w-full text-left px-4 py-3 rounded-lg border border-gray-200 hover:border-gray-300 hover:bg-gray-50/50 transition-colors group"
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 min-w-0">
          <span className="w-2 h-2 rounded-full flex-shrink-0 bg-green-400" />
          <span className="font-medium text-gray-900 truncate">{formatName(session)}</span>
          {session.gitBranch && (
            <span className="text-xs bg-gray-100 text-gray-500 px-1.5 py-0.5 rounded font-mono">
              {session.gitBranch}
            </span>
          )}
        </div>
        <div className="flex items-center gap-3 flex-shrink-0 ml-4">
          {session.messageCount != null && (
            <span className="text-xs text-gray-400">{session.messageCount} msgs</span>
          )}
          {timeStr && <span className="text-xs text-gray-400">{formatTime(timeStr)}</span>}
          <svg
            className="w-4 h-4 text-gray-300 group-hover:text-gray-400"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2}
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
          </svg>
        </div>
      </div>
    </button>
  );
}
