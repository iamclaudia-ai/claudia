import { useState, useEffect, useRef, useCallback } from "react";
import { useImmer } from "use-immer";
import { Transition } from "@headlessui/react";
import { FileText, FileImage, File, X, Copy, Check } from "lucide-react";
import { MessageContent } from "./components/MessageContent";
import { ToolCallBlock } from "./components/ToolCallBlock";
import { ClaudiaThinking } from "./components/ClaudiaThinking";

// Gateway URL - connects directly to Claudia Gateway
const GATEWAY_URL = "ws://localhost:30086/ws";

// Attachment types
interface Attachment {
  type: "image" | "file";
  mediaType: string;
  data: string; // base64
  filename?: string;
}

// Get icon for file type
function getFileIcon(mediaType: string) {
  if (mediaType.startsWith("image/")) return FileImage;
  if (mediaType.startsWith("text/") || mediaType === "application/pdf") return FileText;
  return File;
}

// Generate request ID
function generateId(): string {
  return Math.random().toString(36).slice(2, 10);
}

// Extract raw text content from message blocks
function getMessageRawContent(blocks: ContentBlock[]): string {
  return blocks
    .filter((b): b is TextBlock => b.type === "text" || b.type === "thinking")
    .map((b) => b.content)
    .join("\n\n");
}

// Copy button with checkmark feedback
function CopyButton({ text, className = "" }: { text: string; className?: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }, [text]);

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

// Types for our message state
interface TextBlock {
  type: "text" | "thinking";
  content: string;
}

interface ImageBlock {
  type: "image";
  mediaType: string;
  data: string; // base64
}

interface FileBlock {
  type: "file";
  mediaType: string;
  data: string; // base64
  filename?: string;
}

interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: string;
  result?: {
    content: string;
    is_error?: boolean;
  };
}

type ContentBlock = TextBlock | ImageBlock | FileBlock | ToolUseBlock;

interface Message {
  role: "user" | "assistant";
  blocks: ContentBlock[];
  aborted?: boolean;
}

interface Usage {
  input_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  output_tokens: number;
}

// Gateway protocol types
interface GatewayMessage {
  type: "req" | "res" | "event";
  id?: string;
  method?: string;
  params?: Record<string, unknown>;
  ok?: boolean;
  payload?: unknown;
  error?: string;
  event?: string;
}

export function App() {
  const [messages, setMessages] = useImmer<Message[]>([]);
  const [input, setInput] = useState(() => {
    if (typeof window !== "undefined") {
      return localStorage.getItem("claudia-draft") || "";
    }
    return "";
  });
  const [isConnected, setIsConnected] = useState(false);
  const [isQuerying, setIsQuerying] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [usage, setUsage] = useState<Usage | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const [eventCount, setEventCount] = useState(0);
  const [visibleCount, setVisibleCount] = useState(50);

  // Refs to avoid recreating callbacks
  const inputRef = useRef(input);
  const attachmentsRef = useRef(attachments);
  const isQueryingRef = useRef(isQuerying);
  const isConnectedRef = useRef(isConnected);

  useEffect(() => { inputRef.current = input; }, [input]);
  useEffect(() => { attachmentsRef.current = attachments; }, [attachments]);
  useEffect(() => { isQueryingRef.current = isQuerying; }, [isQuerying]);
  useEffect(() => { isConnectedRef.current = isConnected; }, [isConnected]);

  // Auto-scroll to bottom
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // Send a request to the gateway
  const sendRequest = useCallback((method: string, params?: Record<string, unknown>) => {
    if (!wsRef.current) return;
    const msg: GatewayMessage = {
      type: "req",
      id: generateId(),
      method,
      params,
    };
    wsRef.current.send(JSON.stringify(msg));
  }, []);

  // WebSocket connection to Gateway
  useEffect(() => {
    const ws = new WebSocket(GATEWAY_URL);
    wsRef.current = ws;

    ws.onopen = () => {
      console.log("Connected to Claudia Gateway");
      setIsConnected(true);

      // Subscribe to session events
      sendRequest("subscribe", { events: ["session.*"] });

      // Get session info
      sendRequest("session.info");
    };

    ws.onclose = () => {
      console.log("Disconnected from Gateway");
      setIsConnected(false);
    };

    ws.onmessage = (event) => {
      const data: GatewayMessage = JSON.parse(event.data);
      handleGatewayMessage(data);
    };

    return () => {
      ws.close();
    };
  }, []);

  const handleGatewayMessage = useCallback((msg: GatewayMessage) => {
    // Handle responses
    if (msg.type === "res") {
      if (msg.ok && msg.payload) {
        const payload = msg.payload as Record<string, unknown>;
        if (payload.sessionId) {
          setSessionId(payload.sessionId as string);
        }
      }
      return;
    }

    // Handle events from gateway
    if (msg.type === "event" && msg.event) {
      // Events are prefixed with "session."
      const eventType = msg.event.replace("session.", "");
      const payload = msg.payload as Record<string, unknown>;
      handleStreamEvent(eventType, payload);
    }
  }, []);

  const handleStreamEvent = useCallback((eventType: string, payload: Record<string, unknown>) => {
    setEventCount((c) => c + 1);

    switch (eventType) {
      case "message_start": {
        setIsQuerying(true);
        setEventCount(0);
        setMessages((draft) => {
          const lastMsg = draft[draft.length - 1];
          if (!lastMsg || lastMsg.role !== "assistant" || lastMsg.blocks.length > 0) {
            draft.push({ role: "assistant", blocks: [] });
          }
        });
        break;
      }

      case "message_stop": {
        setIsQuerying(false);
        break;
      }

      case "content_block_start": {
        const block = payload.content_block as { type: string; id?: string; name?: string } | undefined;
        if (!block) return;

        if (block.type === "text") {
          addBlock({ type: "text", content: "" });
        } else if (block.type === "thinking") {
          addBlock({ type: "thinking", content: "" });
        } else if (block.type === "tool_use") {
          addBlock({
            type: "tool_use",
            id: block.id || "",
            name: block.name || "",
            input: "",
          });
        }
        break;
      }

      case "content_block_delta": {
        const delta = payload.delta as { type: string; text?: string; thinking?: string; partial_json?: string } | undefined;
        if (!delta) return;

        if (delta.type === "text_delta" && delta.text) {
          appendToCurrentBlock(delta.text);
        } else if (delta.type === "thinking_delta" && delta.thinking) {
          appendToCurrentBlock(delta.thinking);
        } else if (delta.type === "input_json_delta" && delta.partial_json) {
          appendToCurrentBlock(delta.partial_json, "input");
        }
        break;
      }

      case "request_tool_results": {
        const results = payload.tool_results as Array<{ tool_use_id: string; content: string; is_error?: boolean }> | undefined;
        for (const result of results || []) {
          updateToolResult(result.tool_use_id, {
            content: result.content,
            is_error: result.is_error,
          });
        }
        break;
      }

      case "message_delta": {
        const delta = payload.delta as { stop_reason?: string } | undefined;
        if (delta?.stop_reason === "abort") {
          setMessages((draft) => {
            const lastMsg = draft[draft.length - 1];
            if (lastMsg?.role === "assistant") {
              lastMsg.aborted = true;
            }
          });
        }

        const usage = payload.usage as Usage | undefined;
        if (usage) {
          setUsage({
            input_tokens: usage.input_tokens || 0,
            cache_creation_input_tokens: usage.cache_creation_input_tokens || 0,
            cache_read_input_tokens: usage.cache_read_input_tokens || 0,
            output_tokens: usage.output_tokens || 0,
          });
        }
        break;
      }
    }
  }, []);

  const addBlock = useCallback((block: ContentBlock) => {
    setMessages((draft) => {
      const lastMsg = draft[draft.length - 1];
      if (lastMsg && lastMsg.role === "assistant") {
        lastMsg.blocks.push(block);
      }
    });
  }, []);

  const appendToCurrentBlock = useCallback((text: string, field: string = "content") => {
    setMessages((draft) => {
      const lastMsg = draft[draft.length - 1];
      if (lastMsg?.role === "assistant") {
        const lastBlock = lastMsg.blocks[lastMsg.blocks.length - 1];
        if (lastBlock) {
          if (field === "content" && "content" in lastBlock) {
            (lastBlock as TextBlock).content += text;
          } else if (field === "input" && "input" in lastBlock) {
            (lastBlock as ToolUseBlock).input += text;
          }
        }
      }
    });
  }, []);

  const updateToolResult = useCallback((toolUseId: string, result: { content: string; is_error?: boolean }) => {
    setMessages((draft) => {
      for (const msg of draft) {
        if (msg.role !== "assistant") continue;
        for (const block of msg.blocks) {
          if (block.type === "tool_use" && block.id === toolUseId) {
            block.result = result;
            return;
          }
        }
      }
    });
  }, []);

  const sendPrompt = useCallback(() => {
    const text = inputRef.current;
    const files = attachmentsRef.current;
    if ((!text.trim() && files.length === 0) || !wsRef.current) return;

    setInput("");
    setAttachments([]);
    localStorage.removeItem("claudia-draft");

    // Build blocks for UI display
    const blocks: ContentBlock[] = [
      ...files.filter((f) => f.type === "image").map((f) => ({
        type: "image" as const,
        mediaType: f.mediaType,
        data: f.data
      })),
      ...files.filter((f) => f.type === "file").map((f) => ({
        type: "file" as const,
        mediaType: f.mediaType,
        data: f.data,
        filename: f.filename,
      })),
      ...(text.trim() ? [{ type: "text" as const, content: text }] : []),
    ];

    // Add user message immediately
    setMessages((draft) => {
      draft.push({ role: "user", blocks });
    });

    // Send to gateway - for now just send text (images TODO)
    sendRequest("session.prompt", { content: text });
  }, [sendRequest]);

  const sendInterrupt = useCallback(() => {
    if (!isQueryingRef.current) return;
    sendRequest("session.interrupt");
  }, [sendRequest]);

  // File processing
  const processFile = useCallback((file: File) => {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result as string;
      const [header, data] = dataUrl.split(",");
      const mediaType = header.match(/data:(.*?);/)?.[1] || "application/octet-stream";
      const isImage = mediaType.startsWith("image/");
      setAttachments((prev) => [
        ...prev,
        {
          type: isImage ? "image" : "file",
          mediaType,
          data,
          filename: file.name,
        },
      ]);
    };
    reader.readAsDataURL(file);
  }, []);

  const handlePaste = useCallback((e: React.ClipboardEvent) => {
    const items = e.clipboardData.items;
    for (const item of items) {
      if (item.type.startsWith("image/") || item.type.startsWith("text/") || item.type === "application/pdf") {
        const file = item.getAsFile();
        if (!file) continue;
        e.preventDefault();
        processFile(file);
      }
    }
  }, [processFile]);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    const files = Array.from(e.dataTransfer.files);
    for (const file of files) {
      processFile(file);
    }
  }, [processFile]);

  const removeAttachment = useCallback((index: number) => {
    setAttachments((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const handleInputChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const value = e.target.value;
    setInput(value);
    localStorage.setItem("claudia-draft", value);
  }, []);

  const loadEarlierMessages = useCallback(() => {
    const container = messagesContainerRef.current;
    if (!container) return;
    const prevScrollHeight = container.scrollHeight;
    setVisibleCount((c) => c + 50);
    requestAnimationFrame(() => {
      const newScrollHeight = container.scrollHeight;
      container.scrollTop = newScrollHeight - prevScrollHeight;
    });
  }, []);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === "Enter" && e.metaKey) {
      e.preventDefault();
      sendPrompt();
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      sendInterrupt();
      return;
    }
  }, [sendPrompt, sendInterrupt]);

  return (
    <div className="flex flex-col h-screen max-w-4xl mx-auto">
      {/* Header */}
      <header className="p-4 border-b border-gray-200">
        <div className="flex items-center justify-between">
          <h1 className="text-xl font-semibold">💙 Claudia</h1>
          <div className="flex items-center gap-2 text-sm">
            <span
              className={`w-2 h-2 rounded-full ${
                isConnected ? "bg-green-500" : "bg-red-500"
              }`}
            />
            <span className="text-gray-500">
              {isConnected ? `Session: ${sessionId?.slice(0, 8) || "..."}` : "Disconnected"}
            </span>
          </div>
        </div>
      </header>

      {/* Messages */}
      <main ref={messagesContainerRef} className="flex-1 overflow-y-auto p-4 space-y-4">
        {messages.length > visibleCount && (
          <button
            onClick={loadEarlierMessages}
            className="w-full py-2 text-sm text-gray-500 hover:text-gray-700 hover:bg-gray-100 rounded-lg transition-colors"
          >
            Load {Math.min(50, messages.length - visibleCount)} earlier messages
          </button>
        )}
        {messages.slice(-visibleCount).map((msg, msgIdx) => (
          <div key={messages.length - visibleCount + msgIdx} className={msg.role === "user" ? "ml-12" : "mr-12"}>
            <div className={`flex items-center gap-2 mb-1 ${msg.role === "user" ? "justify-end" : ""}`}>
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

      {/* Thinking indicator */}
      <Transition
        show={isQuerying}
        enter="transition-all duration-300 ease-out"
        enterFrom="opacity-0 translate-y-4 scale-95"
        enterTo="opacity-100 translate-y-0 scale-100"
        leave="transition-all duration-200 ease-in"
        leaveFrom="opacity-100 translate-y-0 scale-100"
        leaveTo="opacity-0 translate-y-2 scale-95"
      >
        <div className="fixed bottom-40 right-8 z-50 bg-white/50 backdrop-blur-sm rounded-2xl shadow-2xl drop-shadow-xl p-4 border border-purple-100/50">
          <ClaudiaThinking count={eventCount} size="lg" />
        </div>
      </Transition>

      {/* Input */}
      <footer className="p-4 border-t border-gray-200">
        {attachments.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-2">
            {attachments.map((attachment, idx) => {
              const FileIcon = getFileIcon(attachment.mediaType);
              return (
                <div key={idx} className="relative group">
                  {attachment.type === "image" ? (
                    <img
                      src={`data:${attachment.mediaType};base64,${attachment.data}`}
                      alt={attachment.filename || `Attachment ${idx + 1}`}
                      className="h-16 w-16 object-cover rounded-md border border-gray-300"
                    />
                  ) : (
                    <div className="h-16 px-3 flex items-center gap-2 rounded-md border border-gray-300 bg-gray-50">
                      <FileIcon className="w-5 h-5 text-gray-500" />
                      <span className="text-xs text-gray-700 max-w-24 truncate">
                        {attachment.filename || "file"}
                      </span>
                    </div>
                  )}
                  <button
                    onClick={() => removeAttachment(idx)}
                    className="absolute -top-1 -right-1 w-5 h-5 bg-red-500 text-white rounded-full flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
                  >
                    <X className="w-3 h-3" />
                  </button>
                </div>
              );
            })}
          </div>
        )}
        <div
          className={`relative ${isDragging ? "ring-2 ring-blue-500 ring-offset-2" : ""}`}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
        >
          <textarea
            value={input}
            onChange={handleInputChange}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            placeholder="Type a message... (⌘↵ send, ESC stop)"
            disabled={!isConnected}
            className="w-full p-3 pr-24 border border-gray-300 rounded-lg resize-none focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:bg-gray-100 placeholder:text-gray-300"
            rows={3}
          />
          {isDragging && (
            <div className="absolute inset-0 bg-blue-50/80 rounded-lg flex items-center justify-center pointer-events-none">
              <span className="text-blue-600 font-medium">Drop files here</span>
            </div>
          )}
          <div className="absolute right-2 bottom-2 flex gap-2">
            {isQuerying && (
              <button
                onClick={sendInterrupt}
                className="px-3 py-2 rounded-md text-white bg-red-500 hover:bg-red-600"
              >
                Stop
              </button>
            )}
            <button
              onClick={sendPrompt}
              disabled={!isConnected || (!input.trim() && attachments.length === 0)}
              className="px-4 py-2 rounded-md text-white bg-blue-500 hover:bg-blue-600 disabled:bg-gray-300"
            >
              Send
            </button>
          </div>
        </div>

        {usage && (() => {
          const total = usage.input_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens;
          const max = 200000;
          const percent = Math.round((total / max) * 100);
          const colorClass = percent >= 80 ? "text-red-600" : percent >= 60 ? "text-orange-500" : "text-gray-600";
          return (
            <div className={`mt-2 text-xs font-mono ${colorClass}`}>
              Context: {total.toLocaleString()}/{max.toLocaleString()} {percent}%
            </div>
          );
        })()}
      </footer>
    </div>
  );
}
