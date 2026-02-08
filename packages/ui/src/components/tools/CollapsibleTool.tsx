import { ChevronDown, ChevronUp, Loader2 } from "lucide-react";
import { useState, type ReactNode } from "react";
import { getToolBadgeConfig } from "./toolConfig";

interface CollapsibleToolProps {
  collapsedContent: ReactNode;
  expandedContent: ReactNode | null;
  defaultExpanded?: boolean;
  isLoading?: boolean;
  toolName?: string;
}

export function CollapsibleTool({
  collapsedContent,
  expandedContent,
  defaultExpanded = false,
  isLoading = false,
  toolName,
}: CollapsibleToolProps) {
  const [isExpanded, setIsExpanded] = useState(defaultExpanded);
  const hasExpandedContent =
    expandedContent !== null && expandedContent !== undefined;

  // Get tool-specific colors for the container
  const config = toolName ? getToolBadgeConfig(toolName) : null;
  const chevronColor = config?.colors.chevron || "text-neutral-400";
  const containerBorder = config?.colors.border || "border-neutral-200/60";
  const containerBg = config?.colors.bg || "bg-neutral-50/80";
  const containerHover = config?.colors.hoverBg || "hover:bg-neutral-100/80";

  return (
    <div className="my-1">
      <button
        type="button"
        onClick={() => hasExpandedContent && setIsExpanded(!isExpanded)}
        disabled={!hasExpandedContent && !isLoading}
        aria-expanded={isExpanded}
        className={`flex w-full items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-left transition-colors ${containerBorder} ${containerBg} ${
          hasExpandedContent ? `cursor-pointer ${containerHover}` : "cursor-default"
        }`}
      >
        <div className="flex-1">{collapsedContent}</div>
        <span className="flex h-5 w-5 flex-shrink-0 items-center justify-center">
          {isLoading ? (
            <Loader2 className={`size-3 animate-spin ${chevronColor}`} />
          ) : hasExpandedContent ? (
            isExpanded ? (
              <ChevronUp className={`size-3 ${chevronColor}`} />
            ) : (
              <ChevronDown className={`size-3 ${chevronColor}`} />
            )
          ) : null}
        </span>
      </button>
      {isExpanded && hasExpandedContent && (
        <div className="mt-1 ml-3 border-l border-neutral-200/30 pl-2.5">
          <div className="space-y-1.5">{expandedContent}</div>
        </div>
      )}
    </div>
  );
}
