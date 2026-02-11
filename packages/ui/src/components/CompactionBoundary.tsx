/**
 * CompactionBoundary — visual marker rendered in message history
 * when Claude Code performed context compaction.
 *
 * Shows a horizontal divider with compaction metadata (trigger, token count).
 */

import { Scissors } from "lucide-react";

interface CompactionBoundaryProps {
  trigger: "manual" | "auto";
  preTokens: number;
  timestamp?: number;
}

function formatTokens(tokens: number): string {
  if (tokens >= 1000) {
    return `${Math.round(tokens / 1000)}K`;
  }
  return tokens.toLocaleString();
}

export default function CompactionBoundary({ trigger, preTokens, timestamp }: CompactionBoundaryProps) {
  const label = trigger === "auto" ? "Auto-compacted" : "Manually compacted";
  const timeStr = timestamp
    ? new Date(timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : null;

  return (
    <div className="relative flex items-center justify-center my-4 px-4">
      {/* Gradient line left */}
      <div className="flex-1 h-px bg-gradient-to-r from-transparent via-purple-300/60 to-purple-300/60" />

      {/* Center badge */}
      <div className="flex items-center gap-1.5 px-3 py-1 mx-3 rounded-full border border-purple-200/60 bg-purple-50/80 backdrop-blur-sm">
        <Scissors className="size-3 text-purple-400" />
        <span className="text-[11px] font-medium text-purple-600">
          {label}
        </span>
        {preTokens > 0 && (
          <span className="text-[10px] text-purple-400">
            {formatTokens(preTokens)} tokens
          </span>
        )}
        {timeStr && (
          <span className="text-[10px] text-purple-300">
            {timeStr}
          </span>
        )}
      </div>

      {/* Gradient line right */}
      <div className="flex-1 h-px bg-gradient-to-l from-transparent via-purple-300/60 to-purple-300/60" />
    </div>
  );
}
