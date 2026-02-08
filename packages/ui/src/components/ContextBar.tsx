import type { EditorContext } from "../types";

interface ContextBarProps {
  context?: EditorContext;
}

export function ContextBar({ context }: ContextBarProps) {
  if (!context) {
    return (
      <div className="px-4 py-1.5 bg-gray-50 border-b border-gray-200 text-xs text-gray-400 font-mono">
        No file open
      </div>
    );
  }

  return (
    <div className="px-4 py-1.5 bg-gray-50 border-b border-gray-200 text-xs text-gray-500 font-mono truncate">
      {context.relativePath || context.fileName}
      {" | "}
      {context.languageId}
      {" | Line "}
      {context.currentLine}
      {context.selectionRange && (
        <span className="text-blue-500">
          {" | Selection: "}
          {context.selectionRange.startLine}-{context.selectionRange.endLine}
        </span>
      )}
    </div>
  );
}
