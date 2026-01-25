/**
 * ClaudiaThinking - Animated thinking indicator with circuit brain
 * Event-driven animation that advances with each agent event
 */

import ThinkingFrame from "./ThinkingFrame";

interface ClaudiaThinkingProps {
  count?: number; // Event counter to drive animation
  size?: "sm" | "md" | "lg"; // Size of the animation
  speed?: number; // Divisor for animation speed (higher = slower)
}

export function ClaudiaThinking({
  count = 0,
  size = "md",
  speed = 2, // Default: slower than raw event count
}: ClaudiaThinkingProps) {
  // Cycle through frames 1-8 based on event count
  // Speed divisor slows down the animation (2 = half speed, 3 = third speed)
  const adjustedCount = Math.floor(count / speed);
  // Size classes
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
