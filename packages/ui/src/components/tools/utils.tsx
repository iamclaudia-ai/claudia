import { cloneElement, isValidElement } from "react";
import type { ReactNode } from "react";
import { getToolBadgeConfig } from "./toolConfig";
import { useWorkspace } from "../../contexts/WorkspaceContext";

/** Strip CWD prefix from a file path to make it shorter.
 *  Falls back to stripping common home-dir prefixes when CWD doesn't match. */
function stripCwdPrefix(path: string, cwd?: string): string {
  // Try exact CWD match first
  if (cwd && path.startsWith(cwd)) {
    const stripped = path.slice(cwd.length).replace(/^\/+/, "");
    if (stripped) return stripped;
  }

  // Fallback: strip ~/Projects/*/ or ~/*/  to keep paths short
  const homeMatch = path.match(/^\/Users\/[^/]+\/(?:Projects\/)?[^/]+\/(.+)$/);
  if (homeMatch) return homeMatch[1];

  return path;
}

interface ToolHeaderProps {
  toolName: string;
  label: string;
}

/** Icon + label header for a tool, using the unified color config */
export function ToolHeader({ toolName, label }: ToolHeaderProps) {
  const config = getToolBadgeConfig(toolName);

  // Resize icon from size-2.5 (badge) to size-3 (header) for readability
  let displayIcon = config.icon;
  if (isValidElement(displayIcon)) {
    const element = displayIcon as React.ReactElement<{ className?: string }>;
    const existing = (element.props as { className?: string })?.className || "";
    const resized = existing ? existing.replace(/size-\d+(\.\d+)?/g, "size-3") : "size-3";
    displayIcon = cloneElement(element, { className: resized });
  }

  return (
    <div className={`flex items-center gap-1.5 text-sm font-medium ${config.colors.text}`}>
      {displayIcon && (
        <span className={`flex h-4 w-4 items-center justify-center ${config.colors.iconColor}`}>
          {displayIcon}
        </span>
      )}
      <span className="tracking-tight">{label}</span>
    </div>
  );
}

/** Monospace text */
export function MonoText({
  children,
  className = "",
  title,
}: {
  children: ReactNode;
  className?: string;
  title?: string;
}) {
  return (
    <code
      title={title}
      className={`font-mono text-sm tracking-tight text-neutral-800 ${className}`}
    >
      {children}
    </code>
  );
}

/** File path pill with neutral border */
export function FilePath({ path, cwd: explicitCwd }: { path: string; cwd?: string }) {
  const workspace = useWorkspace();
  const cwd = explicitCwd || workspace.cwd;
  const displayPath = stripCwdPrefix(path, cwd);

  return (
    <MonoText
      className="max-w-xs truncate rounded border border-neutral-200/50 bg-neutral-50/50 px-1.5 py-0.5"
      title={path}
    >
      {displayPath}
    </MonoText>
  );
}

/** Inline code pill */
export function InlineCode({ children }: { children: ReactNode }) {
  return (
    <MonoText className="rounded border border-neutral-200/50 bg-neutral-50/50 px-1.5 py-0.5">
      {children}
    </MonoText>
  );
}

/** Scrollable result block */
export function ResultBlock({
  content,
  isError,
  maxHeight = "max-h-72",
}: {
  content: string;
  isError?: boolean;
  maxHeight?: string;
}) {
  const bg = isError ? "bg-red-100/50" : "bg-neutral-100/50";
  const text = isError ? "text-red-700" : "text-neutral-600";

  return (
    <pre
      className={`${maxHeight} overflow-x-hidden rounded ${bg} px-2 py-1 font-mono text-sm break-words whitespace-pre-wrap ${text}`}
    >
      {content}
    </pre>
  );
}
