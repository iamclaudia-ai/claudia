import { useState, useRef, useEffect } from "react";
import { useBridge } from "../bridge";
import type { WorkspaceInfo, SessionInfo, SessionConfigInfo } from "../hooks/useGateway";

interface HeaderProps {
  isConnected: boolean;
  sessionId: string | null;
  sessionRecordId: string | null;
  workspace: WorkspaceInfo | null;
  sessions: SessionInfo[];
  sessionConfig: SessionConfigInfo | null;
  onCreateSession: () => void;
  onSwitchSession: (sessionId: string) => void;
  /** Optional back navigation (web client uses this to go to session list) */
  onBack?: () => void;
}

export function Header({
  isConnected,
  sessionId,
  sessionRecordId,
  workspace,
  sessions,
  sessionConfig,
  onCreateSession,
  onSwitchSession,
  onBack,
}: HeaderProps) {
  const bridge = useBridge();
  const [isDropdownOpen, setIsDropdownOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Close dropdown when clicking outside
  useEffect(() => {
    if (!isDropdownOpen) return;
    const handleClick = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setIsDropdownOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [isDropdownOpen]);

  // Find current session in the list (match by record ID or CC session ID)
  const currentSession = sessions.find(
    (s) => s.id === sessionRecordId || s.ccSessionId === sessionId,
  );

  // Format session display name
  const formatSessionName = (s: SessionInfo) => {
    if (s.title) return s.title;
    return `Session ${s.id.slice(4)}`;
  };

  // Format relative time
  const formatTime = (dateStr: string) => {
    const date = new Date(dateStr + "Z"); // JSONL dates are UTC
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    if (diffMins < 1) return "just now";
    if (diffMins < 60) return `${diffMins}m ago`;
    const diffHours = Math.floor(diffMins / 60);
    if (diffHours < 24) return `${diffHours}h ago`;
    const diffDays = Math.floor(diffHours / 24);
    return `${diffDays}d ago`;
  };

  return (
    <header className="p-4 border-b border-gray-200">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          {onBack && (
            <button
              onClick={onBack}
              className="text-gray-400 hover:text-gray-200 transition-colors"
              title="Back to sessions"
            >
              ←
            </button>
          )}
          <h1 className="text-xl font-semibold">💙 Claudia</h1>
        </div>
        <div className="flex items-center gap-2 text-sm">
          {bridge.openTerminal && (
            <button
              onClick={() => bridge.openTerminal!()}
              className="px-2 py-1 rounded text-xs bg-gray-100 hover:bg-gray-200 text-gray-600 transition-colors"
              title="Split terminal below"
            >
              ⌨ Terminal
            </button>
          )}

          {/* Session switcher */}
          <div className="relative" ref={dropdownRef}>
            <button
              onClick={() => setIsDropdownOpen(!isDropdownOpen)}
              className="flex items-center gap-1.5 px-2 py-1 rounded text-xs bg-gray-100 hover:bg-gray-200 text-gray-600 transition-colors"
              title="Switch session"
            >
              <span
                className={`w-2 h-2 rounded-full flex-shrink-0 ${
                  isConnected ? "bg-green-500" : "bg-red-500"
                }`}
              />
              <span className="max-w-[300px] truncate">
                {isConnected ? (workspace ? workspace.name : "...") : "Disconnected"}
                {currentSession ? (
                  <span className="text-gray-400 ml-1">· {formatSessionName(currentSession)}</span>
                ) : sessionId ? (
                  <span className="text-gray-400 ml-1">· {sessionId.slice(0, 8)}…</span>
                ) : null}
              </span>
              <svg
                className={`w-3 h-3 transition-transform ${isDropdownOpen ? "rotate-180" : ""}`}
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2}
              >
                <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
              </svg>
            </button>

            {isDropdownOpen && (
              <div className="absolute right-0 top-full mt-1 w-72 bg-white rounded-lg shadow-lg border border-gray-200 z-50 overflow-hidden">
                {/* New session button */}
                <button
                  onClick={() => {
                    onCreateSession();
                    setIsDropdownOpen(false);
                  }}
                  className="flex items-center gap-2 w-full px-3 py-2 text-sm text-blue-600 hover:bg-blue-50 transition-colors border-b border-gray-100"
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
                  New Session
                </button>

                {/* Session list */}
                <div className="max-h-64 overflow-y-auto">
                  {sessions.length === 0 ? (
                    <div className="px-3 py-4 text-sm text-gray-400 text-center">
                      No sessions yet
                    </div>
                  ) : (
                    sessions.map((s) => {
                      const isCurrent = s.id === sessionRecordId || s.ccSessionId === sessionId;
                      return (
                        <button
                          key={s.id}
                          onClick={() => {
                            if (!isCurrent) {
                              onSwitchSession(s.id);
                            }
                            setIsDropdownOpen(false);
                          }}
                          className={`flex items-center justify-between w-full px-3 py-2 text-sm transition-colors ${
                            isCurrent
                              ? "bg-blue-50 text-blue-700"
                              : "text-gray-700 hover:bg-gray-50"
                          }`}
                        >
                          <div className="flex items-center gap-2 min-w-0">
                            <span
                              className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${
                                s.status === "active" ? "bg-green-400" : "bg-gray-300"
                              }`}
                            />
                            <span className="truncate">{formatSessionName(s)}</span>
                          </div>
                          <span className="text-xs text-gray-400 flex-shrink-0 ml-2">
                            {formatTime(s.lastActivity)}
                          </span>
                        </button>
                      );
                    })
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Session config badges */}
      {sessionConfig && (
        <div className="flex items-center gap-2 mt-2 text-xs">
          <span className="px-2 py-0.5 rounded-full bg-blue-50 text-blue-600 font-medium">
            {sessionConfig.model}
          </span>
          <span
            className={`px-2 py-0.5 rounded-full font-medium ${
              sessionConfig.thinking ? "bg-purple-50 text-purple-600" : "bg-gray-100 text-gray-400"
            }`}
          >
            {sessionConfig.thinking ? `🧠 adaptive (${sessionConfig.effort})` : "thinking off"}
          </span>
        </div>
      )}
    </header>
  );
}
