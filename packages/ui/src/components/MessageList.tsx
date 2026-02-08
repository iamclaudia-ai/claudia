import type { Message, TextBlock, ImageBlock, FileBlock, ContentBlock } from "../types";
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
  onLoadEarlier(): void;
  messagesContainerRef: React.RefObject<HTMLDivElement | null>;
  messagesEndRef: React.RefObject<HTMLDivElement | null>;
}

export function MessageList({
  messages,
  visibleCount,
  isQuerying,
  onLoadEarlier,
  messagesContainerRef,
  messagesEndRef,
}: MessageListProps) {
  return (
    <main
      ref={messagesContainerRef}
      className="flex-1 overflow-y-auto p-4 space-y-4"
    >
      {messages.length > visibleCount && (
        <button
          onClick={onLoadEarlier}
          className="w-full py-2 text-sm text-gray-500 hover:text-gray-700 hover:bg-gray-100 rounded-lg transition-colors"
        >
          Load {Math.min(50, messages.length - visibleCount)} earlier messages
        </button>
      )}
      {messages.slice(-visibleCount).map((msg, msgIdx) => (
        <div
          key={messages.length - visibleCount + msgIdx}
          className={msg.role === "user" ? "ml-12" : "mr-12"}
        >
          <div
            className={`flex items-center gap-2 mb-1 ${msg.role === "user" ? "justify-end" : ""}`}
          >
            <CopyButton text={getMessageRawContent(msg.blocks)} />
          </div>
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
                return null;
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
