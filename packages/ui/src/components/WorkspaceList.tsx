import { useState, useEffect, useRef, useCallback } from "react";
import type { GatewayMessage } from "../types";
import type { WorkspaceInfo, SessionInfo } from "../hooks/useGateway";

const DEFAULT_MODEL = "claude-opus-4-6";
const DEFAULT_THINKING = true;
const DEFAULT_EFFORT = "medium";

interface WorkspaceListProps {
  gatewayUrl: string;
  onSelectWorkspace: (workspaceId: string) => void;
  /** Called when a new workspace is created and its first session is ready */
  onSessionReady?: (sessionId: string) => void;
}

function generateId(): string {
  return Math.random().toString(36).slice(2, 10);
}

export function WorkspaceList({
  gatewayUrl,
  onSelectWorkspace,
  onSessionReady,
}: WorkspaceListProps) {
  const [workspaces, setWorkspaces] = useState<WorkspaceInfo[]>([]);
  const [isConnected, setIsConnected] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [newCwd, setNewCwd] = useState("");
  const [newName, setNewName] = useState("");
  const [isCreating, setIsCreating] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const pendingRef = useRef<Map<string, string>>(new Map());
  // Track workspace ID for auto-session-create flow
  const pendingWorkspaceRef = useRef<string | null>(null);

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
      sendRequest("workspace.list");
    };

    ws.onclose = () => setIsConnected(false);

    ws.onmessage = (event) => {
      const data: GatewayMessage = JSON.parse(event.data);
      if (data.type === "res" && data.ok && data.payload) {
        const payload = data.payload as Record<string, unknown>;
        const method = data.id ? pendingRef.current.get(data.id) : undefined;
        if (data.id) pendingRef.current.delete(data.id);

        if (method === "workspace.list") {
          const list = payload.workspaces as WorkspaceInfo[] | undefined;
          setWorkspaces(list || []);
          setIsLoading(false);
        }

        if (method === "workspace.get-or-create") {
          const ws = payload.workspace as WorkspaceInfo | undefined;
          if (ws) {
            // If workspace has an active session, navigate straight to it
            if (ws.activeSessionId && onSessionReady) {
              setIsCreating(false);
              onSessionReady(ws.activeSessionId);
            } else {
              // Create first session for the new workspace
              pendingWorkspaceRef.current = ws.id;
              sendRequest("workspace.create-session", {
                workspaceId: ws.id,
                model: DEFAULT_MODEL,
                thinking: DEFAULT_THINKING,
                effort: DEFAULT_EFFORT,
              });
            }
          }
        }

        if (method === "workspace.create-session") {
          const session = payload.session as SessionInfo | undefined;
          if (session && onSessionReady) {
            setIsCreating(false);
            onSessionReady(session.id);
          } else {
            // Fallback: refresh workspace list
            setIsCreating(false);
            sendRequest("workspace.list");
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
  }, [gatewayUrl, sendRequest, onSessionReady]);

  const handleCreateWorkspace = useCallback(() => {
    const cwd = newCwd.trim();
    if (!cwd) return;

    setIsCreating(true);
    sendRequest("workspace.get-or-create", {
      cwd,
      name: newName.trim() || undefined,
    });
  }, [newCwd, newName, sendRequest]);

  // Sort by most recently updated
  const sorted = [...workspaces].sort(
    (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
  );

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

  return (
    <div className="flex flex-col h-screen max-w-3xl mx-auto">
      <header className="p-6 border-b border-gray-200">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-semibold">💙 Claudia</h1>
          <div className="flex items-center gap-3 text-sm">
            <button
              onClick={() => setShowCreateForm(!showCreateForm)}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium text-blue-600 bg-blue-50 hover:bg-blue-100 transition-colors"
            >
              <svg
                className="w-4 h-4"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2}
              >
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
              </svg>
              New Workspace
            </button>
            <div className="flex items-center gap-1.5">
              <span
                className={`w-2 h-2 rounded-full ${isConnected ? "bg-green-500" : "bg-red-500"}`}
              />
              <span className="text-gray-500">{isConnected ? "Connected" : "Disconnected"}</span>
            </div>
          </div>
        </div>
        <p className="text-gray-500 mt-1">Workspaces</p>
      </header>

      {/* Create workspace form */}
      {showCreateForm && (
        <div className="p-6 border-b border-gray-200 bg-gray-50/50">
          <div className="space-y-3">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Project Path <span className="text-red-400">*</span>
              </label>
              <input
                type="text"
                value={newCwd}
                onChange={(e) => setNewCwd(e.target.value)}
                placeholder="/Users/michael/Projects/my-project"
                className="w-full px-3 py-2 rounded-lg border border-gray-300 text-sm focus:border-blue-400 focus:ring-1 focus:ring-blue-400 outline-none"
                autoFocus
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleCreateWorkspace();
                  if (e.key === "Escape") setShowCreateForm(false);
                }}
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Name{" "}
                <span className="text-gray-400 font-normal">
                  (optional — defaults to folder name)
                </span>
              </label>
              <input
                type="text"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="my-project"
                className="w-full px-3 py-2 rounded-lg border border-gray-300 text-sm focus:border-blue-400 focus:ring-1 focus:ring-blue-400 outline-none"
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleCreateWorkspace();
                  if (e.key === "Escape") setShowCreateForm(false);
                }}
              />
            </div>
            <div className="flex items-center gap-2 justify-end">
              <button
                onClick={() => setShowCreateForm(false)}
                className="px-3 py-1.5 rounded-lg text-sm text-gray-600 hover:bg-gray-200 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleCreateWorkspace}
                disabled={!newCwd.trim() || isCreating}
                className="px-4 py-1.5 rounded-lg text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                {isCreating ? "Creating..." : "Create & Start Session"}
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="flex-1 overflow-y-auto p-6">
        {isLoading ? (
          <div className="text-center text-gray-400 py-12">Loading workspaces...</div>
        ) : sorted.length === 0 ? (
          <div className="text-center text-gray-400 py-12">
            <p className="text-lg mb-2">No workspaces yet</p>
            <p className="text-sm">
              Create a workspace to start chatting, or open a project in VS Code with the Claudia
              extension.
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            {sorted.map((ws) => (
              <button
                key={ws.id}
                onClick={() => onSelectWorkspace(ws.id)}
                className="w-full text-left px-4 py-3 rounded-lg border border-gray-200 hover:border-blue-300 hover:bg-blue-50/50 transition-colors group"
              >
                <div className="flex items-center justify-between">
                  <div className="min-w-0">
                    <div className="font-medium text-gray-900 group-hover:text-blue-700 truncate">
                      {ws.name}
                    </div>
                    <div className="text-xs text-gray-400 truncate mt-0.5">{ws.cwd}</div>
                  </div>
                  <div className="flex items-center gap-3 flex-shrink-0 ml-4">
                    <span className="text-xs text-gray-400">{formatTime(ws.updatedAt)}</span>
                    <svg
                      className="w-4 h-4 text-gray-300 group-hover:text-blue-400"
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
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
