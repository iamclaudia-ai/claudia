/**
 * StatusBar — Displays hook output below the chat area.
 *
 * Renders compact status info from hooks (git-status, cost-tracker, etc.)
 * without cluttering the chat messages.
 */

import { useState } from "react";

interface GitStatusData {
  modified: number;
  added: number;
  deleted: number;
  untracked: number;
  total: number;
  files: { status: string; path: string }[];
}

interface StatusBarProps {
  hookState: Record<string, unknown>;
}

function GitStatusBadge({ data }: { data: GitStatusData }) {
  const [expanded, setExpanded] = useState(false);

  const badges: { label: string; count: number; color: string }[] = [];
  if (data.added > 0) badges.push({ label: "+", count: data.added, color: "text-emerald-600" });
  if (data.modified > 0) badges.push({ label: "~", count: data.modified, color: "text-amber-600" });
  if (data.deleted > 0) badges.push({ label: "-", count: data.deleted, color: "text-red-600" });
  if (data.untracked > 0)
    badges.push({ label: "!", count: data.untracked, color: "text-purple-600" });

  if (badges.length === 0) return null;

  const statusIcon = (status: string) => {
    if (status === "M" || status === "MM" || status === "AM") return "~";
    if (status === "A") return "+";
    if (status === "D") return "-";
    if (status === "??") return "!";
    if (status === "R") return "~";
    return status;
  };

  const statusColor = (status: string) => {
    if (status === "M" || status === "MM" || status === "AM" || status === "R")
      return "text-amber-600";
    if (status === "A") return "text-emerald-600";
    if (status === "D") return "text-red-600";
    if (status === "??") return "text-purple-600";
    return "text-gray-500";
  };

  return (
    <div className="relative">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-2 text-xs font-mono font-bold transition-colors"
      >
        {badges.map((b) => (
          <span key={b.label} className={b.color}>
            {b.label}
            {b.count}
          </span>
        ))}
      </button>

      {expanded && (
        <div className="absolute bottom-full left-0 mb-1 bg-white border border-gray-200 rounded-lg shadow-xl p-2 min-w-[240px] max-h-[200px] overflow-y-auto z-50">
          {data.files.map((file, i) => (
            <div key={i} className="flex items-center gap-2 py-0.5 text-xs font-mono">
              <span className={`w-4 text-center font-bold ${statusColor(file.status)}`}>
                {statusIcon(file.status)}
              </span>
              <span className="text-gray-700 truncate">{file.path}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function StatusBar({ hookState }: StatusBarProps) {
  const gitStatus = hookState["git-status"] as GitStatusData | undefined;

  // Don't render if no hook data
  const hasContent = gitStatus && gitStatus.total > 0;
  if (!hasContent) return null;

  return (
    <div className="flex items-center gap-4 px-4 py-1.5 border-t border-gray-200 bg-gray-50">
      {gitStatus && gitStatus.total > 0 && <GitStatusBadge data={gitStatus} />}
    </div>
  );
}
