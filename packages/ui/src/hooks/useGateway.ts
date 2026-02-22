import { useState, useEffect, useRef, useCallback } from "react";
import { useImmer } from "use-immer";
import type {
  Message,
  ContentBlock,
  TextBlock,
  ToolUseBlock,
  ErrorBlock,
  Usage,
  Attachment,
  GatewayMessage,
} from "../types";

function generateId(): string {
  return Math.random().toString(36).slice(2, 10);
}

// Re-export workspace/session types for consumers
export interface WorkspaceInfo {
  id: string;
  name: string;
  cwd: string;
  createdAt: string;
  updatedAt: string;
}

export interface SessionInfo {
  sessionId: string;
  created?: string;
  modified?: string;
  messageCount?: number;
  firstPrompt?: string;
  gitBranch?: string;
}

// ─── Options ─────────────────────────────────────────────────

export interface UseGatewayOptions {
  /**
   * Explicit session ID (CC UUID) to load.
   * Used by web client when navigating to /workspace/:wsId/session/:id.
   * When set, loads history for this specific session.
   */
  sessionId?: string;

  /**
   * Workspace ID — provides CWD context for session operations.
   * Used together with sessionId for the web client session route.
   */
  workspaceId?: string;

  /**
   * Auto-discover mode: get workspace by CWD, find active session.
   * Used by VS Code extension. Provide the CWD string.
   * When set, sends session.get_or_create_workspace on connect.
   */
  autoDiscoverCwd?: string;
}

// ─── Return Type ─────────────────────────────────────────────

/** Callback for subscribing to raw gateway events */
export type EventListener = (event: string, payload: unknown) => void;

export interface UseGatewayReturn {
  messages: Message[];
  isConnected: boolean;
  isQuerying: boolean;
  /** Whether context compaction is currently in progress */
  isCompacting: boolean;
  sessionId: string | null;
  usage: Usage | null;
  eventCount: number;
  visibleCount: number;
  /** Total messages in the full session history */
  totalMessages: number;
  /** Whether there are older messages available to load */
  hasMore: boolean;
  workspace: WorkspaceInfo | null;
  sessions: SessionInfo[];
  sendPrompt(text: string, attachments: Attachment[], tags?: string[]): void;
  sendToolResult(toolUseId: string, content: string, isError?: boolean): void;
  sendInterrupt(): void;
  loadEarlierMessages(): void;
  createNewSession(title?: string): void;
  switchSession(sessionId: string): void;
  /** Send a raw gateway request (for listing pages) */
  sendRequest(method: string, params?: Record<string, unknown>, tags?: string[]): void;
  /** Subscribe to raw gateway events. Returns unsubscribe function. */
  onEvent(listener: EventListener): () => void;
  /** Server-assigned connection ID for this WebSocket session */
  connectionId: string | null;
  /** Latest hook state per hookId (e.g., { "git-status": { modified: 2, ... } }) */
  hookState: Record<string, unknown>;
  messagesContainerRef: React.RefObject<HTMLDivElement | null>;
  messagesEndRef: React.RefObject<HTMLDivElement | null>;
}

// ─── Hook ────────────────────────────────────────────────────

export function useGateway(gatewayUrl: string, options: UseGatewayOptions = {}): UseGatewayReturn {
  const [messages, setMessages] = useImmer<Message[]>([]);
  const [isConnected, setIsConnected] = useState(false);
  const [isQuerying, setIsQuerying] = useState(false);
  const [isCompacting, setIsCompacting] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [usage, setUsage] = useState<Usage | null>(null);
  const [eventCount, setEventCount] = useState(0);
  const [visibleCount, setVisibleCount] = useState(50);
  const [totalMessages, setTotalMessages] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [workspace, setWorkspace] = useState<WorkspaceInfo | null>(null);
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [hookState, setHookState] = useState<Record<string, unknown>>({});

  const wsRef = useRef<WebSocket | null>(null);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const messagesContainerRef = useRef<HTMLDivElement | null>(null);
  const connectionIdRef = useRef<string | null>(null);
  const isQueryingRef = useRef(isQuerying);
  const sessionIdRef = useRef(sessionId);
  const workspaceRef = useRef(workspace);
  const historyLoadedRef = useRef(false);
  const pendingRequestsRef = useRef<Map<string, string>>(new Map());
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const subscribedSessionRef = useRef<string | null>(null);
  const ignoringHaikuMessageRef = useRef(false);
  const eventListenersRef = useRef<Set<EventListener>>(new Set());

  useEffect(() => {
    isQueryingRef.current = isQuerying;
  }, [isQuerying]);

  useEffect(() => {
    sessionIdRef.current = sessionId;
  }, [sessionId]);

  useEffect(() => {
    workspaceRef.current = workspace;
  }, [workspace]);

  // Auto-scroll to bottom (instant for history load, smooth for streaming)
  useEffect(() => {
    const behavior = historyLoadedRef.current ? "smooth" : "instant";
    messagesEndRef.current?.scrollIntoView({ behavior });
  }, [messages]);

  // Send a request to the gateway
  const sendRequest = useCallback(
    (method: string, params?: Record<string, unknown>, tags?: string[]) => {
      if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
      const id = generateId();
      const msg: GatewayMessage & { tags?: string[] } = { type: "req", id, method, params };
      if (tags?.length) msg.tags = tags;
      pendingRequestsRef.current.set(id, method);
      wsRef.current.send(JSON.stringify(msg));
    },
    [],
  );

  // Subscribe to session-scoped streaming events when we learn the sessionId
  const subscribeToSession = useCallback(
    (sid: string) => {
      if (subscribedSessionRef.current === sid) return;

      // Unsubscribe from old session's stream if any
      if (subscribedSessionRef.current) {
        sendRequest("gateway.unsubscribe", {
          events: [`session.${subscribedSessionRef.current}.*`],
        });
      }

      // Subscribe to this session's stream events
      sendRequest("gateway.subscribe", { events: [`session.${sid}.*`] });
      subscribedSessionRef.current = sid;
      console.log(`[WS] Subscribed to session: session.${sid.slice(0, 8)}...*`);
    },
    [sendRequest],
  );

  // ── Message mutation helpers ────────────────────────────────

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
    (toolUseId: string, result: { content: string; is_error?: boolean }) => {
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

  // ── Stream event handler ───────────────────────────────────

  const handleStreamEvent = useCallback(
    (eventType: string, payload: Record<string, unknown>) => {
      setEventCount((c) => c + 1);

      // Auto-enable thinking for streaming content events (mid-turn recovery after HMR/refresh)
      // Only after history has loaded — otherwise stale events during reconnect cause false positives
      if (
        !isQueryingRef.current &&
        historyLoadedRef.current &&
        ![
          "ping",
          "turn_start",
          "turn_stop",
          "user_message",
          "api_warning",
          "api_error",
          "process_started",
          "process_ended",
          "session_stale",
          "process_died",
        ].includes(eventType)
      ) {
        setIsQuerying(true);
        setEventCount(0);
      }

      switch (eventType) {
        case "user_message": {
          // Broadcast from another connection — add to our message list
          const senderConnectionId = payload.connectionId as string | undefined;
          if (senderConnectionId && senderConnectionId === connectionIdRef.current) break; // skip our own

          const rawContent = payload.content as string | unknown[];
          const blocks: ContentBlock[] = [];
          if (typeof rawContent === "string") {
            blocks.push({ type: "text", content: rawContent });
          } else if (Array.isArray(rawContent)) {
            for (const item of rawContent as Record<string, unknown>[]) {
              if (item.type === "text") {
                blocks.push({ type: "text", content: (item.text as string) || "" });
              } else if (item.type === "image") {
                const src = item.source as Record<string, string>;
                blocks.push({ type: "image", mediaType: src.media_type, data: src.data });
              } else if (item.type === "document") {
                const src = item.source as Record<string, string>;
                blocks.push({
                  type: "file",
                  mediaType: src.media_type,
                  data: src.data,
                  filename: "",
                });
              }
            }
          }
          if (blocks.length > 0) {
            setMessages((draft) => {
              draft.push({ role: "user", blocks, timestamp: Date.now() });
            });
          }
          break;
        }

        case "turn_start":
          setIsQuerying(true);
          setEventCount(0);
          break;

        case "turn_stop":
          setIsQuerying(false);
          break;

        case "message_start": {
          // Filter out Haiku model responses (they contain <is_displaying_contents> artifacts)
          const message = payload.message as { model?: string } | undefined;
          if (message?.model?.includes("haiku")) {
            ignoringHaikuMessageRef.current = true;
            return;
          }

          ignoringHaikuMessageRef.current = false;
          setMessages((draft) => {
            const lastMsg = draft[draft.length - 1];
            if (!lastMsg || lastMsg.role !== "assistant" || lastMsg.blocks.length > 0) {
              draft.push({ role: "assistant", blocks: [], timestamp: Date.now() });
            }
          });
          break;
        }

        case "message_stop":
          // Individual message done — turn may continue with tool calls
          if (ignoringHaikuMessageRef.current) {
            ignoringHaikuMessageRef.current = false;
            return;
          }
          break;

        case "content_block_start": {
          if (ignoringHaikuMessageRef.current) return;

          const block = payload.content_block as
            | { type: string; id?: string; name?: string }
            | undefined;
          if (!block) return;
          if (block.type === "text") addBlock({ type: "text", content: "" });
          else if (block.type === "thinking") addBlock({ type: "thinking", content: "" });
          else if (block.type === "tool_use") {
            addBlock({ type: "tool_use", id: block.id || "", name: block.name || "", input: "" });
          }
          break;
        }

        case "content_block_delta": {
          if (ignoringHaikuMessageRef.current) return;

          const delta = payload.delta as
            | { type: string; text?: string; thinking?: string; partial_json?: string }
            | undefined;
          if (!delta) return;
          if (delta.type === "text_delta" && delta.text) appendToCurrentBlock(delta.text);
          else if (delta.type === "thinking_delta" && delta.thinking)
            appendToCurrentBlock(delta.thinking);
          else if (delta.type === "input_json_delta" && delta.partial_json)
            appendToCurrentBlock(delta.partial_json, "input");
          break;
        }

        case "request_tool_results": {
          const results = payload.tool_results as
            | Array<{ tool_use_id: string; content: string; is_error?: boolean }>
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
          if (ignoringHaikuMessageRef.current) return;

          const delta = payload.delta as { stop_reason?: string } | undefined;
          if (delta?.stop_reason === "abort") {
            setMessages((draft) => {
              const lastMsg = draft[draft.length - 1];
              if (lastMsg?.role === "assistant") lastMsg.aborted = true;
            });
          }
          const usageData = payload.usage as Usage | undefined;
          if (usageData) {
            setUsage({
              input_tokens: usageData.input_tokens || 0,
              cache_creation_input_tokens: usageData.cache_creation_input_tokens || 0,
              cache_read_input_tokens: usageData.cache_read_input_tokens || 0,
              output_tokens: usageData.output_tokens || 0,
            });
          }
          break;
        }

        case "compaction_start":
          setIsCompacting(true);
          console.log("[Compaction] ⚡ Started");
          break;

        case "compaction_end": {
          setIsCompacting(false);
          const trigger = (payload.trigger as string) || "auto";
          const preTokens = (payload.pre_tokens as number) || 0;
          console.log(`[Compaction] ✓ Complete (trigger: ${trigger}, pre_tokens: ${preTokens})`);

          // Insert a compaction boundary marker into messages
          setMessages((draft) => {
            draft.push({
              role: "compaction_boundary",
              blocks: [],
              timestamp: Date.now(),
              compaction: {
                trigger: trigger as "manual" | "auto",
                pre_tokens: preTokens,
              },
            });
          });
          break;
        }

        case "process_died": {
          setIsCompacting(false); // Clear stuck compaction state
          setIsQuerying(false); // Clear stuck querying state
          const exitCode = (payload.exitCode as number) || 0;
          const reason = (payload.reason as string) || "Process died";
          console.error(`[Runtime] Process died unexpectedly (exit code: ${exitCode}): ${reason}`);

          // Add error message to chat
          setMessages((draft) => {
            draft.push({
              role: "assistant",
              blocks: [
                {
                  type: "error",
                  message: `Claude process died unexpectedly (exit code: ${exitCode}). Please restart the session.`,
                  status: exitCode,
                },
              ],
              timestamp: Date.now(),
            });
          });
          break;
        }

        case "session_stale": {
          const minutes = (payload.minutesSinceActivity as number) || 0;
          console.warn(`[Runtime] Session appears stale (${minutes}m since last activity)`);
          break;
        }

        case "api_error": {
          console.error(`[API Error] ${payload.status}: ${payload.message}`);
          const errorBlock: ErrorBlock = {
            type: "error",
            message: (payload.message as string) || `API error ${payload.status}`,
            status: payload.status as number,
          };
          // Ensure there's an assistant message to attach to
          setMessages((draft) => {
            const lastMsg = draft[draft.length - 1];
            if (lastMsg?.role === "assistant") {
              lastMsg.blocks.push(errorBlock);
            } else {
              draft.push({ role: "assistant", blocks: [errorBlock], timestamp: Date.now() });
            }
          });
          setIsQuerying(false);
          break;
        }

        case "api_warning": {
          console.warn(
            `[API Retry] Attempt ${payload.attempt}/${payload.maxRetries}: ${payload.message}`,
          );
          const warningBlock: ErrorBlock = {
            type: "error",
            message:
              (payload.message as string) || `API retry ${payload.attempt}/${payload.maxRetries}`,
            status: payload.status as number,
            isRetrying: true,
            attempt: payload.attempt as number,
            maxRetries: payload.maxRetries as number,
            retryInMs: payload.retryInMs as number,
          };
          // Add retry indicator to current assistant message
          setMessages((draft) => {
            const lastMsg = draft[draft.length - 1];
            if (lastMsg?.role === "assistant") {
              lastMsg.blocks.push(warningBlock);
            } else {
              draft.push({ role: "assistant", blocks: [warningBlock], timestamp: Date.now() });
            }
          });
          break;
        }

        default:
          break;
      }
    },
    [addBlock, appendToCurrentBlock, updateToolResult, setMessages],
  );

  // ── Gateway message handler ────────────────────────────────

  const handleGatewayMessage = useCallback(
    (msg: GatewayMessage) => {
      if (msg.type === "res") {
        if (msg.ok && msg.payload) {
          const payload = msg.payload as Record<string, unknown>;
          const method = msg.id ? pendingRequestsRef.current.get(msg.id) : undefined;
          if (msg.id) pendingRequestsRef.current.delete(msg.id);

          // Track session ID from any response that includes it
          if (payload.sessionId && typeof payload.sessionId === "string") {
            setSessionId(payload.sessionId as string);
          }

          // ── session.get_history ──
          if (method === "session.get_history") {
            const historyMessages = payload.messages as Message[] | undefined;
            const historyUsage = payload.usage as Usage | undefined;
            const total = (payload.total as number) || 0;
            const more = (payload.hasMore as boolean) || false;
            const offset = (payload.offset as number) || 0;

            if (historyMessages && historyMessages.length > 0) {
              if (offset > 0) {
                // Loading earlier messages — prepend to existing
                setMessages((draft) => {
                  draft.unshift(...historyMessages);
                });
                setVisibleCount((c) => c + historyMessages.length);
                // Preserve scroll position after prepend
                const container = messagesContainerRef.current;
                if (container) {
                  const prevScrollHeight = container.scrollHeight;
                  requestAnimationFrame(() => {
                    const newScrollHeight = container.scrollHeight;
                    container.scrollTop = newScrollHeight - prevScrollHeight;
                  });
                }
              } else {
                // Initial load — replace all messages
                setMessages(() => historyMessages);
                setVisibleCount(historyMessages.length);
              }
              console.log(
                `[History] Loaded ${historyMessages.length}/${total} messages (offset: ${offset}, hasMore: ${more})`,
              );
            }
            // Mark history as loaded (even if empty) so streaming auto-recovery can activate.
            // Brief delay lets any stale events from reconnect settle first.
            if (offset === 0) {
              setTimeout(() => {
                historyLoadedRef.current = true;
              }, 100);
            }
            setTotalMessages(total);
            setHasMore(more);
            if (historyUsage) setUsage(historyUsage);
          }

          // ── session.get_or_create_workspace (VS Code auto-discover) ──
          if (method === "session.get_or_create_workspace") {
            const ws = payload.workspace as WorkspaceInfo | undefined;
            if (ws) {
              setWorkspace(ws);
              console.log(
                `[Workspace] ${payload.created ? "Created" : "Loaded"}: ${ws.name} (${ws.id}), cwd: ${ws.cwd}`,
              );

              // Load session list for this workspace (uses cwd)
              sendRequest("session.list_sessions", { cwd: ws.cwd });
            }
          }

          // ── session.get_workspace (fetch single workspace) ──
          if (method === "session.get_workspace") {
            const ws = payload.workspace as WorkspaceInfo | undefined;
            if (ws) {
              setWorkspace(ws);
              console.log(`[Workspace] Loaded: ${ws.name} (${ws.id})`);
            }
          }

          // ── session.list_sessions ──
          if (method === "session.list_sessions") {
            const sessionList = payload.sessions as SessionInfo[] | undefined;
            if (sessionList) {
              setSessions(sessionList);
              console.log(
                `[Sessions] Loaded ${sessionList.length} sessions`,
                sessionList.map((s) => `${s.sessionId.slice(0, 8)}…`),
              );

              // If we don't have a session yet, auto-select the most recent one
              if (sessionList.length > 0 && !sessionIdRef.current) {
                const mostRecent = sessionList[0]; // already sorted by modified desc
                setSessionId(mostRecent.sessionId);
                subscribeToSession(mostRecent.sessionId);
                sendRequest("session.get_history", { sessionId: mostRecent.sessionId, limit: 50 });
              }
            }
          }

          // ── session.create_session ──
          if (method === "session.create_session") {
            const newSessionId = payload.sessionId as string | undefined;
            if (newSessionId) {
              setSessionId(newSessionId);
              subscribeToSession(newSessionId);
              setMessages(() => []);
              setUsage(null);
              setTotalMessages(0);
              setHasMore(false);
              historyLoadedRef.current = false;
              console.log(`[Session] Created: ${newSessionId}`);
              // Refresh session list
              if (workspaceRef.current?.cwd) {
                sendRequest("session.list_sessions", { cwd: workspaceRef.current.cwd });
              }
            }
          }

          // ── session.switch_session ──
          if (method === "session.switch_session") {
            const switchedSessionId = payload.sessionId as string | undefined;
            if (switchedSessionId) {
              setSessionId(switchedSessionId);
              subscribeToSession(switchedSessionId);
              setMessages(() => []);
              setUsage(null);
              setTotalMessages(0);
              setHasMore(false);
              historyLoadedRef.current = false;
              console.log(`[Session] Switched to: ${switchedSessionId}`);
              sendRequest("session.get_history", { sessionId: switchedSessionId, limit: 50 });
              if (workspaceRef.current?.cwd) {
                sendRequest("session.list_sessions", { cwd: workspaceRef.current.cwd });
              }
            }
          }

          // ── session.get_info ──
          if (method === "session.get_info") {
            if (payload.sessionId) {
              setSessionId(payload.sessionId as string);
              subscribeToSession(payload.sessionId as string);
            }
            if (payload.workspaceId && payload.workspaceName) {
              setWorkspace((prev) =>
                prev
                  ? {
                      ...prev,
                      id: payload.workspaceId as string,
                      name: payload.workspaceName as string,
                    }
                  : null,
              );
            }
          }
        }
        return;
      }

      if (msg.type === "event" && msg.event) {
        // Capture server-assigned connectionId on connect
        if (msg.event === "gateway.welcome") {
          const welcomePayload = msg.payload as { connectionId?: string };
          if (welcomePayload?.connectionId) {
            connectionIdRef.current = welcomePayload.connectionId;
          }
          return;
        }

        // Streaming events: "session.{sessionId}.{eventType}"
        // Extract the eventType (everything after "session.{sessionId}.")
        const parts = msg.event.split(".");
        if (parts[0] === "session" && parts.length >= 3) {
          const eventType = parts.slice(2).join(".");
          const payload = msg.payload as Record<string, unknown>;
          handleStreamEvent(eventType, payload);
        }

        // Hook events: "hook.{hookId}.{event}" — store latest state per hookId
        if (parts[0] === "hook" && parts.length >= 3) {
          const hookId = parts[1];
          setHookState((prev) => ({ ...prev, [hookId]: msg.payload }));
        }

        // Fire raw event listeners (for voice, extensions, etc.)
        for (const listener of eventListenersRef.current) {
          try {
            listener(msg.event, msg.payload);
          } catch {
            // Don't let listener errors break the event loop
          }
        }
      }
    },
    [handleStreamEvent, setMessages, sendRequest, subscribeToSession],
  );

  // ── WebSocket connection ───────────────────────────────────

  useEffect(() => {
    const ws = new WebSocket(gatewayUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      console.log("Connected to Claudia Gateway");
      setIsConnected(true);

      // Fetch session info on connect
      // Streaming events are subscribed per-session via subscribeToSession()
      // when we learn the sessionId from create/switch/info
      sendRequest("session.get_info");

      // Subscribe to voice and hook events (global, not session-scoped)
      sendRequest("gateway.subscribe", { events: ["voice.*", "hook.*"] });

      const opts = optionsRef.current;

      if (opts.sessionId) {
        // ── Web client: explicit session ID (CC UUID) ──
        // Load history and subscribe to stream
        setSessionId(opts.sessionId);
        subscribeToSession(opts.sessionId);
        sendRequest("session.get_history", { sessionId: opts.sessionId, limit: 50 });
        // Look up workspace for CWD context (needed for send-prompt auto-resume)
        if (opts.workspaceId) {
          sendRequest("session.get_workspace", { id: opts.workspaceId });
        }
      } else if (opts.autoDiscoverCwd) {
        // ── VS Code: auto-discover by CWD ──
        // This triggers workspace creation + session discovery + history loading
        sendRequest("session.get_or_create_workspace", { cwd: opts.autoDiscoverCwd });
      } else {
        // ── No session specified (e.g. listing pages) ──
        // Just get basic info
        sendRequest("session.get_info");
      }
    };

    ws.onclose = () => {
      console.log("Disconnected from Gateway");
      setIsConnected(false);
    };

    ws.onmessage = (event) => {
      const data = JSON.parse(event.data);

      // Respond to gateway pings to stay alive
      if (data.type === "ping") {
        ws.send(JSON.stringify({ type: "pong", id: data.id }));
        return;
      }

      handleGatewayMessage(data as GatewayMessage);
    };

    return () => {
      ws.close();
    };
  }, [gatewayUrl]);

  // ── Actions ────────────────────────────────────────────────

  const sendPrompt = useCallback(
    (text: string, attachments: Attachment[], tags?: string[]) => {
      if ((!text.trim() && attachments.length === 0) || !wsRef.current) return;

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
        ...(text.trim() ? [{ type: "text" as const, content: text }] : []),
      ];

      setMessages((draft) => {
        draft.push({ role: "user", blocks, timestamp: Date.now() });
      });

      // Build content for the API — plain string if text-only, array of content blocks if attachments
      let content: string | unknown[];
      if (attachments.length === 0) {
        content = text;
      } else {
        content = [
          ...attachments
            .filter((f) => f.type === "image")
            .map((f) => ({
              type: "image",
              source: { type: "base64", media_type: f.mediaType, data: f.data },
            })),
          ...attachments
            .filter((f) => f.type === "file")
            .map((f) => ({
              type: "document",
              source: { type: "base64", media_type: f.mediaType, data: f.data },
            })),
          ...(text.trim() ? [{ type: "text", text }] : []),
        ];
      }

      // Pass session ID so the gateway targets the right session
      const sid = sessionIdRef.current;
      if (!sid) {
        console.warn("[sendPrompt] missing sessionId");
        return;
      }
      const params: Record<string, unknown> = {
        content,
        sessionId: sid,
        cwd: workspaceRef.current?.cwd,
      };
      sendRequest("session.send_prompt", params, tags);
    },
    [sendRequest, setMessages],
  );

  const sendToolResult = useCallback(
    (toolUseId: string, content: string, isError = false) => {
      const sid = sessionIdRef.current;
      if (!sid) {
        console.warn("[sendToolResult] missing sessionId");
        return;
      }
      sendRequest("session.send_tool_result", { sessionId: sid, toolUseId, content, isError });
    },
    [sendRequest],
  );

  const sendInterrupt = useCallback(() => {
    if (!isQueryingRef.current) return;
    if (!sessionIdRef.current) return;
    sendRequest("session.interrupt_session", { sessionId: sessionIdRef.current });
  }, [sendRequest]);

  const loadEarlierMessages = useCallback(() => {
    if (!hasMore) return;
    if (!sessionIdRef.current) return;
    // Request next page of older messages from the server
    const offset = messages.length;
    const params: Record<string, unknown> = {
      sessionId: sessionIdRef.current,
      limit: 50,
      offset,
    };
    sendRequest("session.get_history", params);
  }, [hasMore, messages.length, sendRequest]);

  const createNewSession = useCallback(
    (_title?: string) => {
      if (!workspace?.cwd) return;
      sendRequest("session.create_session", { cwd: workspace.cwd });
    },
    [sendRequest, workspace?.cwd],
  );

  const switchSession = useCallback(
    (sid: string) => {
      sendRequest("session.switch_session", { sessionId: sid, cwd: workspace?.cwd });
    },
    [sendRequest, workspace?.cwd],
  );

  const onEvent = useCallback((listener: EventListener): (() => void) => {
    eventListenersRef.current.add(listener);
    return () => {
      eventListenersRef.current.delete(listener);
    };
  }, []);

  return {
    messages,
    isConnected,
    isQuerying,
    isCompacting,
    sessionId,
    usage,
    eventCount,
    visibleCount,
    totalMessages,
    hasMore,
    workspace,
    sessions,
    sendPrompt,
    sendToolResult,
    sendInterrupt,
    loadEarlierMessages,
    createNewSession,
    switchSession,
    sendRequest,
    onEvent,
    connectionId: connectionIdRef.current,
    hookState,
    messagesContainerRef,
    messagesEndRef,
  };
}
