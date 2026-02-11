/**
 * CompactionIndicator — real-time indicator shown while Claude Code
 * is performing context compaction.
 *
 * Positioned inline in the message area (like a thinking indicator).
 * Shows elapsed time and a pulsing animation.
 */

import { useState, useEffect } from "react";
import { Scissors } from "lucide-react";

export default function CompactionIndicator() {
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    const start = Date.now();
    const interval = setInterval(() => {
      setElapsed(Math.floor((Date.now() - start) / 1000));
    }, 1000);
    return () => clearInterval(interval);
  }, []);

  return (
    <div className="flex items-center gap-2 px-4 py-3">
      <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg border border-purple-200/60 bg-purple-50/80 backdrop-blur-sm animate-pulse">
        <Scissors className="size-3.5 text-purple-500 animate-spin" style={{ animationDuration: "3s" }} />
        <span className="text-xs font-medium text-purple-600">
          Compacting context...
        </span>
        {elapsed > 0 && (
          <span className="text-[10px] text-purple-400 tabular-nums">
            {elapsed}s
          </span>
        )}
      </div>
    </div>
  );
}
