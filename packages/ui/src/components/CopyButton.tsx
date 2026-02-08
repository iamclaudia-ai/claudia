import { useState, useCallback } from "react";
import { Copy, Check } from "lucide-react";
import { useBridge } from "../bridge";

interface CopyButtonProps {
  text: string;
  className?: string;
}

export function CopyButton({ text, className = "" }: CopyButtonProps) {
  const [copied, setCopied] = useState(false);
  const bridge = useBridge();

  const handleCopy = useCallback(() => {
    bridge.copyToClipboard(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }, [text, bridge]);

  return (
    <button
      onClick={handleCopy}
      className={`p-1 rounded hover:bg-gray-200 transition-colors ${className}`}
      title="Copy"
    >
      {copied ? (
        <Check className="w-3.5 h-3.5 text-green-500" />
      ) : (
        <Copy className="w-3.5 h-3.5 text-gray-400" />
      )}
    </button>
  );
}
