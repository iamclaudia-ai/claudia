import { useState, useEffect, useRef, useCallback } from "react";
import { useImmer } from "use-immer";
import type {
  Message,
  ContentBlock,
  TextBlock,
  ToolUseBlock,
  Usage,
  Attachment,
  GatewayMessage,
} from "../types";

function generateId(): string {
  return Math.random().toString(36).slice(2, 10);
}

export interface UseGatewayReturn {
  messages: Message[];
  isConnected: boolean;
  isQuerying: boolean;
  sessionId: string | null;
  usage: Usage | null;
  eventCount: number;
  visibleCount: number;
  sendPrompt(text: string, attachments: Attachment[]): void;
  sendInterrupt(): void;
  loadEarlierMessages(): void;
  messagesContainerRef: React.RefObject<HTMLDivElement | null>;
  messagesEndRef: React.RefObject<HTMLDivElement | null>;
}

export function useGateway(gatewayUrl: string): UseGatewayReturn {
  const [messages, setMessages] = useImmer<Message[]>([]);
  const [isConnected, setIsConnected] = useState(false);
  const [isQuerying, setIsQuerying] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [usage, setUsage] = useState<Usage | null>(null);
  const [eventCount, setEventCount] = useState(0);
  const [visibleCount, setVisibleCount] = useState(50);

  const wsRef = useRef<WebSocket | null>(null);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const messagesContainerRef = useRef<HTMLDivElement | null>(null);
  const isQueryingRef = useRef(isQuerying);

  useEffect(() => {
    isQueryingRef.current = isQuerying;
  }, [isQuerying]);

  // Auto-scroll to bottom
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // Send a request to the gateway
  const sendRequest = useCallback(
    (method: string, params?: Record<string, unknown>) => {
      if (!wsRef.current) return;
      const msg: GatewayMessage = {
        type: "req",
        id: generateId(),
        method,
        params,
      };
      wsRef.current.send(JSON.stringify(msg));
    },
    [],
  );

  // Message mutation helpers
  const addBlock = useCallback(
    (block: ContentBlock) => {
      setMessages((draft) => {
        const lastMsg = draft[draft.length - 1];
        if (lastMsg && lastMsg.role === "assistant") {
          lastMsg.blocks.push(block);
        }
      });
    },
    [setMessages],
  );

  const appendToCurrentBlock = useCallback(
    (text: string, field: string = "content") => {
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
    },
    [setMessages],
  );

  const updateToolResult = useCallback(
    (
      toolUseId: string,
      result: { content: string; is_error?: boolean },
    ) => {
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
    },
    [setMessages],
  );

  // Stream event handler
  const handleStreamEvent = useCallback(
    (eventType: string, payload: Record<string, unknown>) => {
      setEventCount((c) => c + 1);

      switch (eventType) {
        case "message_start": {
          setIsQuerying(true);
          setEventCount(0);
          setMessages((draft) => {
            const lastMsg = draft[draft.length - 1];
            if (
              !lastMsg ||
              lastMsg.role !== "assistant" ||
              lastMsg.blocks.length > 0
            ) {
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
          const block = payload.content_block as
            | { type: string; id?: string; name?: string }
            | undefined;
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
          const delta = payload.delta as
            | {
                type: string;
                text?: string;
                thinking?: string;
                partial_json?: string;
              }
            | undefined;
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
          const results = payload.tool_results as
            | Array<{
                tool_use_id: string;
                content: string;
                is_error?: boolean;
              }>
            | undefined;
          for (const result of results || []) {
            updateToolResult(result.tool_use_id, {
              content: result.content,
              is_error: result.is_error,
            });
          }
          break;
        }

        case "message_delta": {
          const delta = payload.delta as
            | { stop_reason?: string }
            | undefined;
          if (delta?.stop_reason === "abort") {
            setMessages((draft) => {
              const lastMsg = draft[draft.length - 1];
              if (lastMsg?.role === "assistant") {
                lastMsg.aborted = true;
              }
            });
          }

          const usageData = payload.usage as Usage | undefined;
          if (usageData) {
            setUsage({
              input_tokens: usageData.input_tokens || 0,
              cache_creation_input_tokens:
                usageData.cache_creation_input_tokens || 0,
              cache_read_input_tokens: usageData.cache_read_input_tokens || 0,
              output_tokens: usageData.output_tokens || 0,
            });
          }
          break;
        }
      }
    },
    [addBlock, appendToCurrentBlock, updateToolResult, setMessages],
  );

  // Gateway message handler
  const handleGatewayMessage = useCallback(
    (msg: GatewayMessage) => {
      if (msg.type === "res") {
        if (msg.ok && msg.payload) {
          const payload = msg.payload as Record<string, unknown>;
          if (payload.sessionId) {
            setSessionId(payload.sessionId as string);
          }
        }
        return;
      }

      if (msg.type === "event" && msg.event) {
        const eventType = msg.event.replace("session.", "");
        const payload = msg.payload as Record<string, unknown>;
        handleStreamEvent(eventType, payload);
      }
    },
    [handleStreamEvent],
  );

  // WebSocket connection
  useEffect(() => {
    const ws = new WebSocket(gatewayUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      console.log("Connected to Claudia Gateway");
      setIsConnected(true);
      sendRequest("subscribe", { events: ["session.*"] });
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
  }, [gatewayUrl]);

  // Send prompt
  const sendPrompt = useCallback(
    (text: string, attachments: Attachment[]) => {
      if ((!text.trim() && attachments.length === 0) || !wsRef.current) return;

      // Build blocks for UI display
      const blocks: ContentBlock[] = [
        ...attachments
          .filter((f) => f.type === "image")
          .map((f) => ({
            type: "image" as const,
            mediaType: f.mediaType,
            data: f.data,
          })),
        ...attachments
          .filter((f) => f.type === "file")
          .map((f) => ({
            type: "file" as const,
            mediaType: f.mediaType,
            data: f.data,
            filename: f.filename,
          })),
        ...(text.trim()
          ? [{ type: "text" as const, content: text }]
          : []),
      ];

      setMessages((draft) => {
        draft.push({ role: "user", blocks });
      });

      sendRequest("session.prompt", { content: text });
    },
    [sendRequest, setMessages],
  );

  // Send interrupt
  const sendInterrupt = useCallback(() => {
    if (!isQueryingRef.current) return;
    sendRequest("session.interrupt");
  }, [sendRequest]);

  // Load earlier messages (pagination)
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

  return {
    messages,
    isConnected,
    isQuerying,
    sessionId,
    usage,
    eventCount,
    visibleCount,
    sendPrompt,
    sendInterrupt,
    loadEarlierMessages,
    messagesContainerRef,
    messagesEndRef,
  };
}
