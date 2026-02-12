/**
 * ClaudiaThinking - Animated thinking indicator with circuit brain
 * Event-driven animation that advances with each agent event
 */

import ThinkingFrame from "./ThinkingFrame";

interface ClaudiaThinkingProps {
  count?: number;
  size?: "sm" | "md" | "lg";
  speed?: number;
}

export function ClaudiaThinking({ count = 0, size = "md", speed = 2 }: ClaudiaThinkingProps) {
  const adjustedCount = Math.floor(count / speed);
  const sizeClasses = {
    sm: "w-12 h-12",
    md: "w-24 h-24",
    lg: "w-32 h-32",
  };

  return (
    <div className="flex items-center justify-center">
      <ThinkingFrame
        count={adjustedCount}
        className={`${sizeClasses[size]} transition-opacity duration-100`}
      />
    </div>
  );
}
