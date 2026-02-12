import { useState, useEffect, useRef, useCallback } from "react";
import type { GatewayMessage } from "../types";
import type { WorkspaceInfo, SessionInfo } from "../hooks/useGateway";

interface SessionListProps {
  gatewayUrl: string;
  workspaceId: string;
  onSelectSession: (sessionId: string) => void;
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
      sendRequest("session.list", { workspaceId });
      sendRequest("workspace.get", { workspaceId });
    };

    ws.onclose = () => setIsConnected(false);

    ws.onmessage = (event) => {
      const data: GatewayMessage = JSON.parse(event.data);
      if (data.type === "res" && data.ok && data.payload) {
        const payload = data.payload as Record<string, unknown>;
        const method = data.id ? pendingRef.current.get(data.id) : undefined;
        if (data.id) pendingRef.current.delete(data.id);

        if (method === "session.list") {
          const list = payload.sessions as SessionInfo[] | undefined;
          setSessions(list || []);
          setIsLoading(false);
        }

        if (method === "workspace.get") {
          const ws = payload.workspace as WorkspaceInfo | undefined;
          if (ws) setWorkspace(ws);
        }

        if (method === "session.create") {
          const session = payload.session as SessionInfo | undefined;
          if (session) {
            setIsCreating(false);
            // Navigate straight to the new session
            onSelectSession(session.id);
          }
        }
      }

      // Handle errors
      if (data.type === "res" && !data.ok) {
        setIsCreating(false);
      }
    };

    return () => { ws.close(); };
  }, [gatewayUrl, workspaceId, sendRequest]);

  const formatSessionName = (s: SessionInfo) => {
    if (s.title) return s.title;
    return `Session ${s.id.slice(4)}`;
  };

  const formatTime = (dateStr: string) => {
    const date = new Date(dateStr + "Z");
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

  // Separate active vs archived, sort by last activity
  const activeSessions = sessions
    .filter((s) => s.status === "active")
    .sort((a, b) => new Date(b.lastActivity).getTime() - new Date(a.lastActivity).getTime());
  const archivedSessions = sessions
    .filter((s) => s.status === "archived")
    .sort((a, b) => new Date(b.lastActivity).getTime() - new Date(a.lastActivity).getTime());

  return (
    <div className="flex flex-col h-screen max-w-3xl mx-auto">
      <header className="p-6 border-b border-gray-200">
        <div className="flex items-center gap-3">
          <button
            onClick={onBack}
            className="p-1 rounded hover:bg-gray-100 transition-colors text-gray-400 hover:text-gray-600"
            title="Back to workspaces"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
            </svg>
          </button>
          <div>
            <h1 className="text-2xl font-semibold">
              💙 {workspace?.name || "..."}
            </h1>
            {workspace && (
              <p className="text-xs text-gray-400 mt-0.5">{workspace.cwd}</p>
            )}
          </div>
        </div>
        <div className="flex items-center justify-between mt-2">
          <p className="text-gray-500">Sessions</p>
          <div className="flex items-center gap-3 text-sm">
            <button
              onClick={() => {
                setIsCreating(true);
                sendRequest("session.create", { workspaceId });
              }}
              disabled={isCreating}
              className="flex items-center gap-1.5 px-3 py-1 rounded-lg text-xs font-medium text-blue-600 bg-blue-50 hover:bg-blue-100 disabled:opacity-50 transition-colors"
            >
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
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
          <div className="space-y-6">
            {/* Active sessions */}
            {activeSessions.length > 0 && (
              <div>
                <h3 className="text-xs font-medium text-gray-400 uppercase tracking-wider mb-2 px-1">
                  Active
                </h3>
                <div className="space-y-2">
                  {activeSessions.map((s) => (
                    <SessionCard
                      key={s.id}
                      session={s}
                      isActive={workspace?.activeSessionId === s.id}
                      formatName={formatSessionName}
                      formatTime={formatTime}
                      onClick={() => onSelectSession(s.id)}
                    />
                  ))}
                </div>
              </div>
            )}

            {/* Archived sessions */}
            {archivedSessions.length > 0 && (
              <div>
                <h3 className="text-xs font-medium text-gray-400 uppercase tracking-wider mb-2 px-1">
                  Archived
                </h3>
                <div className="space-y-2">
                  {archivedSessions.map((s) => (
                    <SessionCard
                      key={s.id}
                      session={s}
                      isActive={false}
                      formatName={formatSessionName}
                      formatTime={formatTime}
                      onClick={() => onSelectSession(s.id)}
                    />
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function SessionCard({
  session,
  isActive,
  formatName,
  formatTime,
  onClick,
}: {
  session: SessionInfo;
  isActive: boolean;
  formatName: (s: SessionInfo) => string;
  formatTime: (dateStr: string) => string;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`w-full text-left px-4 py-3 rounded-lg border transition-colors group ${
        isActive
          ? "border-blue-200 bg-blue-50/50 hover:border-blue-300"
          : "border-gray-200 hover:border-gray-300 hover:bg-gray-50/50"
      }`}
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 min-w-0">
          <span
            className={`w-2 h-2 rounded-full flex-shrink-0 ${
              session.status === "active" ? "bg-green-400" : "bg-gray-300"
            }`}
          />
          <span className={`font-medium truncate ${isActive ? "text-blue-700" : "text-gray-900"}`}>
            {formatName(session)}
          </span>
          {isActive && (
            <span className="text-xs bg-blue-100 text-blue-600 px-1.5 py-0.5 rounded font-medium">
              current
            </span>
          )}
        </div>
        <div className="flex items-center gap-3 flex-shrink-0 ml-4">
          <span className="text-xs text-gray-400">
            {formatTime(session.lastActivity)}
          </span>
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
      {session.summary && (
        <p className="text-sm text-gray-500 mt-1 truncate pl-4">{session.summary}</p>
      )}
    </button>
  );
}
