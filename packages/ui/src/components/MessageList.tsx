import type { Message, TextBlock, ImageBlock, FileBlock, ErrorBlock, ContentBlock } from "../types";
import { MessageContent } from "./MessageContent";
import { ToolCallBlock } from "./ToolCallBlock";
import { CopyButton } from "./CopyButton";
import { FileText, FileImage, File } from "lucide-react";

function getFileIcon(mediaType: string) {
  if (mediaType.startsWith("image/")) return FileImage;
  if (mediaType.startsWith("text/") || mediaType === "application/pdf") return FileText;
  return File;
}

function getMessageRawContent(blocks: ContentBlock[]): string {
  return blocks
    .filter((b): b is TextBlock => b.type === "text" || b.type === "thinking")
    .map((b) => b.content)
    .join("\n\n");
}

interface MessageListProps {
  messages: Message[];
  visibleCount: number;
  isQuerying: boolean;
  hasMore?: boolean;
  totalMessages?: number;
  onLoadEarlier(): void;
  messagesContainerRef: React.RefObject<HTMLDivElement | null>;
  messagesEndRef: React.RefObject<HTMLDivElement | null>;
}

export function MessageList({
  messages,
  visibleCount,
  isQuerying,
  hasMore = false,
  totalMessages = 0,
  onLoadEarlier,
  messagesContainerRef,
  messagesEndRef,
}: MessageListProps) {
  const remainingCount = totalMessages - messages.length;

  return (
    <main
      ref={messagesContainerRef}
      className="flex-1 overflow-y-auto overflow-x-hidden p-4 space-y-4"
    >
      {hasMore && (
        <button
          onClick={onLoadEarlier}
          className="w-full py-2 text-sm text-gray-500 hover:text-gray-700 hover:bg-gray-100 rounded-lg transition-colors"
        >
          Load {Math.min(50, remainingCount)} earlier messages
          {totalMessages > 0 && (
            <span className="ml-1 text-gray-400">
              ({messages.length} of {totalMessages})
            </span>
          )}
        </button>
      )}
      {messages.map((msg, msgIdx) => (
        <div
          key={msgIdx}
          className={msg.role === "user" ? "ml-12" : "mr-12"}
        >
          {/* Only show copy button for user messages or assistant messages with text content */}
          {((msg.role === "user") ||
            (msg.role === "assistant" && msg.blocks.some(b => b.type === "text" || b.type === "thinking"))) && (
            <div
              className={`flex items-center gap-2 mb-1 ${msg.role === "user" ? "justify-end" : ""}`}
            >
              <CopyButton text={getMessageRawContent(msg.blocks)} />
            </div>
          )}
          {msg.role === "user" ? (
            <div className="space-y-2">
              {msg.blocks.filter((b) => b.type === "image").length > 0 && (
                <div className="flex flex-wrap gap-2 justify-end">
                  {msg.blocks
                    .filter((b): b is ImageBlock => b.type === "image")
                    .map((img, idx) => (
                      <img
                        key={idx}
                        src={`data:${img.mediaType};base64,${img.data}`}
                        alt={`Attachment ${idx + 1}`}
                        className="max-h-48 max-w-xs rounded-md border border-gray-300"
                      />
                    ))}
                </div>
              )}
              {msg.blocks.filter((b) => b.type === "file").length > 0 && (
                <div className="flex flex-wrap gap-2 justify-end">
                  {msg.blocks
                    .filter((b): b is FileBlock => b.type === "file")
                    .map((file, idx) => {
                      const FileIcon = getFileIcon(file.mediaType);
                      return (
                        <div
                          key={idx}
                          className="flex items-center gap-2 px-3 py-2 rounded-md border border-gray-300 bg-gray-50"
                        >
                          <FileIcon className="w-5 h-5 text-gray-500" />
                          <span className="text-sm text-gray-700">
                            {file.filename || "file"}
                          </span>
                        </div>
                      );
                    })}
                </div>
              )}
              {msg.blocks
                .filter((b): b is TextBlock => b.type === "text")
                .map((block, idx) => (
                  <MessageContent key={idx} content={block.content} type="user" />
                ))}
            </div>
          ) : (
            <>
              {msg.blocks.map((block, blockIdx) => {
                if (block.type === "text") {
                  return (
                    <MessageContent
                      key={blockIdx}
                      content={block.content}
                      type="assistant"
                    />
                  );
                }
                if (block.type === "thinking") {
                  return (
                    <MessageContent
                      key={blockIdx}
                      content={block.content}
                      type="thinking"
                      isLoading={isQuerying}
                    />
                  );
                }
                if (block.type === "tool_use") {
                  return (
                    <ToolCallBlock
                      key={block.id}
                      name={block.name}
                      input={block.input}
                      result={block.result}
                      isLoading={!block.result && isQuerying}
                    />
                  );
                }
                if (block.type === "error") {
                  const err = block as ErrorBlock;
                  if (err.isRetrying) {
                    return (
                      <div key={blockIdx} className="mt-2 px-3 py-2 text-sm bg-amber-50 border border-amber-200 rounded-md flex items-center gap-2">
                        <svg className="w-4 h-4 text-amber-500 animate-spin flex-shrink-0" fill="none" viewBox="0 0 24 24">
                          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                        </svg>
                        <span className="text-amber-700">{err.message}</span>
                        {err.retryInMs && (
                          <span className="text-amber-500 text-xs ml-auto">
                            retrying in {(err.retryInMs / 1000).toFixed(0)}s
                          </span>
                        )}
                      </div>
                    );
                  }
                  return (
                    <div key={blockIdx} className="mt-2 px-3 py-2 text-sm bg-red-50 border border-red-200 rounded-md">
                      <div className="flex items-center gap-2">
                        <svg className="w-4 h-4 text-red-500 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
                          <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z" />
                        </svg>
                        <span className="text-red-700 font-medium">{err.message}</span>
                        {err.status && (
                          <span className="text-red-400 text-xs ml-auto">HTTP {err.status}</span>
                        )}
                      </div>
                    </div>
                  );
                }
                // Fallback: render unknown block types as raw JSON for debugging
                return (
                  <div key={blockIdx} className="mt-2 p-3 bg-yellow-50 border border-yellow-200 rounded-md">
                    <div className="text-sm font-mono text-yellow-800">
                      <strong>Unknown message type:</strong> {(block as any).type || 'undefined'}
                    </div>
                    <pre className="text-xs text-yellow-700 mt-1 whitespace-pre-wrap">
                      {JSON.stringify(block, null, 2)}
                    </pre>
                  </div>
                );
              })}
              {msg.aborted && (
                <div className="mt-2 px-3 py-1.5 text-sm text-orange-600 bg-orange-50 border border-orange-200 rounded-md inline-block">
                  Response interrupted
                </div>
              )}
            </>
          )}
        </div>
      ))}
      <div ref={messagesEndRef} />
    </main>
  );
}
