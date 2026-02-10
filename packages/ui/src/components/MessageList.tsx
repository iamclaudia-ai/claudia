import type { Message, TextBlock, ImageBlock, FileBlock, ToolUseBlock, ErrorBlock, ContentBlock } from "../types";
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

function formatTimestamp(ts?: number): string | null {
  if (!ts) return null;
  return new Date(ts).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

/** Check if a message contains only tool-like blocks (thinking / tool_use / empty text) */
function isToolOnlyMessage(msg: Message): boolean {
  if (msg.role !== "assistant") return false;
  return msg.blocks.every(
    (b) => b.type === "thinking" || b.type === "tool_use" || (b.type === "text" && !b.content?.trim()),
  );
}

/** A "display row" is either a single message or a group of consecutive tool-only messages */
type DisplayRow =
  | { kind: "message"; msg: Message; msgIdx: number }
  | { kind: "tool-row"; messages: Array<{ msg: Message; msgIdx: number }> };

/** Group consecutive tool-only assistant messages into combined rows */
function buildDisplayRows(messages: Message[]): DisplayRow[] {
  const rows: DisplayRow[] = [];

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];

    if (isToolOnlyMessage(msg)) {
      const lastRow = rows[rows.length - 1];
      if (lastRow?.kind === "tool-row") {
        lastRow.messages.push({ msg, msgIdx: i });
      } else {
        rows.push({ kind: "tool-row", messages: [{ msg, msgIdx: i }] });
      }
    } else {
      rows.push({ kind: "message", msg, msgIdx: i });
    }
  }

  return rows;
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
  isQuerying,
  hasMore = false,
  totalMessages = 0,
  onLoadEarlier,
  messagesContainerRef,
  messagesEndRef,
}: MessageListProps) {
  const remainingCount = totalMessages - messages.length;
  const displayRows = buildDisplayRows(messages);

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
      {displayRows.map((row, rowIdx) => {
        // ── Tool row: grouped badges in a single flex-wrap container ──
        if (row.kind === "tool-row") {
          return (
            <div key={`toolrow-${rowIdx}`} className="mr-12">
              <div className="flex flex-wrap gap-2 my-1">
                {row.messages.flatMap(({ msg, msgIdx }) =>
                  msg.blocks.map((block, blockIdx) => {
                    if (block.type === "thinking") {
                      const isLast = msgIdx === messages.length - 1 && blockIdx === msg.blocks.length - 1;
                      return (
                        <MessageContent
                          key={`${msgIdx}-${blockIdx}`}
                          content={block.content}
                          type="thinking"
                          isLoading={isLast && isQuerying}
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
                    // Skip empty text blocks in tool rows
                    return null;
                  }),
                )}
              </div>
            </div>
          );
        }

        // ── Regular message ──
        const { msg, msgIdx } = row;
        return (
          <div
            key={msgIdx}
            className={msg.role === "user" ? "ml-12" : "mr-12"}
          >
            {/* Copy button + timestamp — only for messages with text content */}
            {(() => {
              const hasText = msg.blocks.some(b => b.type === "text" && b.content?.trim());
              if (!hasText) return null;
              const rawContent = getMessageRawContent(msg.blocks);
              const time = formatTimestamp(msg.timestamp);
              const isUser = msg.role === "user";
              return (
                <div
                  className={`flex items-center gap-2 mb-1 ${isUser ? "justify-end" : ""}`}
                >
                  {isUser ? (
                    <>
                      {time && <span className="text-xs text-gray-400">{time}</span>}
                      <CopyButton text={rawContent} />
                    </>
                  ) : (
                    <>
                      <CopyButton text={rawContent} />
                      {time && <span className="text-xs text-gray-400">{time}</span>}
                    </>
                  )}
                </div>
              );
            })()}
            {msg.role === "user" ? (
              <UserMessage msg={msg} />
            ) : (
              <AssistantMessage msg={msg} msgIdx={msgIdx} totalMessages={messages.length} isQuerying={isQuerying} />
            )}
          </div>
        );
      })}
      <div ref={messagesEndRef} />
    </main>
  );
}

// ── Sub-components ──────────────────────────────────────────

function UserMessage({ msg }: { msg: Message }) {
  return (
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
  );
}

function AssistantMessage({
  msg,
  isQuerying,
}: {
  msg: Message;
  msgIdx: number;
  totalMessages: number;
  isQuerying: boolean;
}) {
  // Group blocks within this message: consecutive tool-like → flex row, text/error → standalone
  const groups: Array<{
    type: "text" | "tool-group" | "error" | "unknown";
    blocks: Array<ContentBlock & { originalIndex: number }>;
  }> = [];

  for (let i = 0; i < msg.blocks.length; i++) {
    const block = { ...msg.blocks[i], originalIndex: i };
    const isToolLike = block.type === "thinking" || block.type === "tool_use";

    if (isToolLike) {
      const lastGroup = groups[groups.length - 1];
      if (lastGroup?.type === "tool-group") {
        lastGroup.blocks.push(block);
      } else {
        groups.push({ type: "tool-group", blocks: [block] });
      }
    } else if (block.type === "error") {
      groups.push({ type: "error", blocks: [block] });
    } else if (block.type === "text") {
      groups.push({ type: "text", blocks: [block] });
    } else {
      groups.push({ type: "unknown", blocks: [block] });
    }
  }

  return (
    <>
      {groups.map((group, groupIdx) => {
        if (group.type === "tool-group") {
          return (
            <div key={`group-${groupIdx}`} className="flex flex-wrap gap-2 my-1">
              {group.blocks.map((block) => {
                const blockIdx = block.originalIndex;
                if (block.type === "thinking") {
                  const isLast = blockIdx === msg.blocks.length - 1;
                  return (
                    <MessageContent
                      key={blockIdx}
                      content={(block as TextBlock).content}
                      type="thinking"
                      isLoading={isLast && isQuerying}
                    />
                  );
                }
                if (block.type === "tool_use") {
                  const tool = block as ToolUseBlock;
                  return (
                    <ToolCallBlock
                      key={tool.id}
                      name={tool.name}
                      input={tool.input}
                      result={tool.result}
                      isLoading={!tool.result && isQuerying}
                    />
                  );
                }
                return null;
              })}
            </div>
          );
        }

        if (group.type === "error") {
          const err = group.blocks[0] as ErrorBlock & { originalIndex: number };
          if (err.isRetrying) {
            return (
              <div key={err.originalIndex} className="mt-2 px-3 py-2 text-sm bg-amber-50 border border-amber-200 rounded-md flex items-center gap-2">
                <svg className="w-4 h-4 text-amber-500 animate-spin shrink-0" fill="none" viewBox="0 0 24 24">
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
            <div key={err.originalIndex} className="mt-2 px-3 py-2 text-sm bg-red-50 border border-red-200 rounded-md">
              <div className="flex items-center gap-2">
                <svg className="w-4 h-4 text-red-500 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
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

        if (group.type === "text") {
          const text = group.blocks[0] as TextBlock & { originalIndex: number };
          if (!text.content || text.content.trim().length === 0) return null;
          return (
            <MessageContent
              key={text.originalIndex}
              content={text.content}
              type="assistant"
            />
          );
        }

        // Unknown block type fallback
        const block = group.blocks[0];
        return (
          <div key={`unknown-${groupIdx}`} className="mt-2 p-3 bg-yellow-50 border border-yellow-200 rounded-md">
            <div className="text-sm font-mono text-yellow-800">
              <strong>Unknown message type:</strong> {(block as any).type || "undefined"}
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
  );
}
