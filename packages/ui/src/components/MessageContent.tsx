import { memo, useState, useCallback } from "react";
import ReactMarkdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import rehypeRaw from "rehype-raw";
import remarkGfm from "remark-gfm";
import remend from "remend";
import { ChevronDown, ChevronUp, Brain, Copy, Check, Loader2 } from "lucide-react";
import { useBridge } from "../bridge";

interface MessageContentProps {
  content: string;
  type: "user" | "assistant" | "thinking";
  isLoading?: boolean;
}

// Code block with copy button
function CodeBlock({ children, className, ...props }: any) {
  const [copied, setCopied] = useState(false);
  const bridge = useBridge();

  const getCodeText = (node: any): string => {
    if (typeof node === "string") return node;
    if (Array.isArray(node)) return node.map(getCodeText).join("");
    if (node?.props?.children) return getCodeText(node.props.children);
    return "";
  };

  const codeText = getCodeText(children);

  const handleCopy = useCallback(() => {
    bridge.copyToClipboard(codeText);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }, [codeText, bridge]);

  const isBlock = className?.includes("language-") || className?.includes("hljs");

  if (!isBlock) {
    return <code className={`${className || ""} break-all`} {...props}>{children}</code>;
  }

  return (
    <div className="relative group">
      <button
        onClick={handleCopy}
        className="absolute top-2 right-2 p-1.5 rounded bg-gray-700 hover:bg-gray-600 opacity-0 group-hover:opacity-100 transition-opacity"
        title="Copy code"
      >
        {copied ? (
          <Check className="w-4 h-4 text-green-400" />
        ) : (
          <Copy className="w-4 h-4 text-gray-300" />
        )}
      </button>
      <code className={className} {...props}>{children}</code>
    </div>
  );
}

function PreBlock({ children, ...props }: any) {
  return <pre className="overflow-x-auto" {...props}>{children}</pre>;
}

const markdownComponents = {
  code: CodeBlock,
  pre: PreBlock,
};

export const MessageContent = memo(function MessageContent({
  content,
  type,
  isLoading,
}: MessageContentProps) {
  const [isExpanded, setIsExpanded] = useState(false);

  const markdown = remend(content);

  if (type === "user") {
    return (
      <div className="prose max-w-none font-sans bg-blue-50 border-l-4 border-blue-500 rounded-r-lg px-4 py-2 overflow-hidden break-words
        prose-headings:font-bold prose-headings:text-foreground
        prose-p:text-foreground prose-p:leading-relaxed
        prose-a:text-blue-600 prose-a:no-underline hover:prose-a:underline
        prose-strong:text-foreground prose-strong:font-semibold
        prose-pre:overflow-x-auto prose-pre:bg-gray-900 prose-pre:text-gray-100
        prose-ul:list-disc prose-ul:pl-6
        prose-ol:list-decimal prose-ol:pl-6
        prose-li:text-foreground
      ">
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          rehypePlugins={[rehypeHighlight, rehypeRaw]}
          components={markdownComponents}
        >
          {markdown}
        </ReactMarkdown>
      </div>
    );
  }

  if (type === "thinking") {
    return (
      <div className="mb-2 border border-gray-200 rounded-lg overflow-hidden bg-gray-50">
        <button
          onClick={() => setIsExpanded(!isExpanded)}
          className="w-full flex items-center gap-2 px-3 py-2 bg-gray-100 hover:bg-gray-200 transition-colors text-left"
        >
          {isLoading ? (
            <Loader2 className="w-4 h-4 text-gray-400 animate-spin" />
          ) : (
            <Brain className="w-4 h-4 text-gray-400" />
          )}
          <span className="text-sm text-gray-500 italic flex-1">
            thinking...
          </span>
          {isLoading ? null : isExpanded ? (
            <ChevronUp className="w-4 h-4 text-gray-400" />
          ) : (
            <ChevronDown className="w-4 h-4 text-gray-400" />
          )}
        </button>

        {isExpanded && (
          <div className="prose max-w-none font-serif text-gray-500 italic px-4 py-2 overflow-hidden break-words
            prose-headings:font-bold prose-headings:text-gray-500
            prose-p:text-gray-500 prose-p:leading-relaxed
            prose-a:text-blue-600 prose-a:no-underline hover:prose-a:underline
            prose-strong:text-gray-500 prose-strong:font-semibold
            prose-pre:overflow-x-auto prose-pre:bg-gray-900 prose-pre:text-gray-100
            prose-ul:list-disc prose-ul:pl-6
            prose-ol:list-decimal prose-ol:pl-6
            prose-li:text-gray-500
          ">
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              rehypePlugins={[rehypeHighlight, rehypeRaw]}
              components={markdownComponents}
            >
              {markdown}
            </ReactMarkdown>
          </div>
        )}
      </div>
    );
  }

  // Assistant
  return (
    <div className="prose max-w-none font-serif overflow-hidden break-words
      prose-headings:font-bold prose-headings:text-foreground
      prose-p:text-foreground prose-p:leading-relaxed
      prose-a:text-blue-600 prose-a:no-underline hover:prose-a:underline
      prose-strong:text-foreground prose-strong:font-semibold
      prose-inline-code:text-pink-600 prose-inline-code:bg-pink-50 prose-inline-code:px-1 prose-inline-code:py-0.5 prose-inline-code:rounded prose-inline-code:before:content-none prose-inline-code:after:content-none
      prose-pre:overflow-x-auto prose-pre:bg-gray-900 prose-pre:text-gray-100 prose-pre:p-4 prose-pre:rounded-lg
      prose-ul:list-disc prose-ul:pl-6
      prose-ol:list-decimal prose-ol:pl-6
      prose-li:text-foreground
      prose-hr:border-gray-300 prose-hr:my-4
      prose-blockquote:border-l-4 prose-blockquote:border-blue-500 prose-blockquote:pl-4 prose-blockquote:italic prose-blockquote:text-gray-600
      prose-table:border-collapse prose-table:w-full
      prose-th:border prose-th:border-gray-300 prose-th:bg-gray-50 prose-th:px-4 prose-th:py-2
      prose-td:border prose-td:border-gray-300 prose-td:px-4 prose-td:py-2
      prose-img:rounded-lg prose-img:shadow-md
    ">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeHighlight, rehypeRaw]}
        components={markdownComponents}
      >
        {markdown}
      </ReactMarkdown>
    </div>
  );
});
