import { useState, memo } from "react";
import { ChevronDown, ChevronUp, Loader2, Check, X } from "lucide-react";

interface ToolCallBlockProps {
  name: string;
  input: string;
  result?: {
    content: string;
    is_error?: boolean;
  };
  isLoading?: boolean;
}

// Try to parse and format JSON input
function formatInput(input: string): string {
  try {
    const parsed = JSON.parse(input);
    return JSON.stringify(parsed, null, 2);
  } catch {
    return input;
  }
}

// Truncate long content
function truncate(str: string, maxLength: number = 500): string {
  if (str.length <= maxLength) return str;
  return str.slice(0, maxLength) + "...";
}

export const ToolCallBlock = memo(function ToolCallBlock({ name, input, result, isLoading }: ToolCallBlockProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const formattedInput = formatInput(input);

  // Determine status icon
  const StatusIcon = () => {
    if (isLoading) {
      return <Loader2 className="w-4 h-4 text-blue-500 animate-spin" />;
    }
    if (result?.is_error) {
      return <X className="w-4 h-4 text-red-500" />;
    }
    if (result) {
      return <Check className="w-4 h-4 text-green-500" />;
    }
    return null;
  };

  return (
    <div className="my-3 border border-gray-200 rounded-lg overflow-hidden bg-gray-50">
      {/* Header - clickable to expand */}
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className="w-full flex items-center gap-2 px-3 py-2 bg-gray-100 border-b border-gray-200 hover:bg-gray-200 transition-colors text-left"
      >
        <StatusIcon />
        <span className="font-mono text-sm font-medium text-gray-700 flex-1">{name}</span>
        {result ? (
          isExpanded ? (
            <ChevronUp className="w-4 h-4 text-gray-400" />
          ) : (
            <ChevronDown className="w-4 h-4 text-gray-400" />
          )
        ) : null}
      </button>

      {/* Expanded content */}
      {isExpanded && (
        <>
          {/* Input */}
          {input && (
            <div className="px-3 py-2 border-b border-gray-200">
              <div className="text-xs text-gray-500 mb-1">Input:</div>
              <pre className="text-xs font-mono text-gray-600 whitespace-pre-wrap break-all">
                {truncate(formattedInput, 300)}
              </pre>
            </div>
          )}

          {/* Result */}
          {result && (
            <div className={`px-3 py-2 ${result.is_error ? "bg-red-50" : "bg-green-50"}`}>
              <div className={`text-xs mb-1 ${result.is_error ? "text-red-500" : "text-green-600"}`}>
                {result.is_error ? "Error:" : "Result:"}
              </div>
              <pre
                className={`text-xs font-mono whitespace-pre-wrap break-all ${
                  result.is_error ? "text-red-600" : "text-gray-600"
                }`}
              >
                {truncate(result.content)}
              </pre>
            </div>
          )}
        </>
      )}

      {/* Loading state - always visible when loading */}
      {isLoading && !result && (
        <div className="px-3 py-2 text-sm text-gray-500 italic">
          Executing...
        </div>
      )}
    </div>
  );
});
