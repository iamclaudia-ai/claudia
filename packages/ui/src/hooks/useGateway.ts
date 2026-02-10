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
  activeSessionId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SessionInfo {
  id: string;
  workspaceId: string;
  ccSessionId: string;
  status: "active" | "archived";
  title: string | null;
  summary: string | null;
  previousSessionId: string | null;
  lastActivity: string;
  createdAt: string;
}

export interface SessionConfigInfo {
  model: string;
  thinking: boolean;
  thinkingBudget: number;
  systemPrompt: string | null;
}

// ─── Options ─────────────────────────────────────────────────

export interface UseGatewayOptions {
  /**
   * Explicit session ID (ses_...) to load.
   * Used by web client when navigating to /session/:id.
   * When set, loads history for this specific session.
   */
  sessionId?: string;

  /**
   * Auto-discover mode: get workspace by CWD, find active session.
   * Used by VS Code extension. Provide the CWD string.
   * When set, sends workspace.getOrCreate on connect.
   */
  autoDiscoverCwd?: string;
}

// ─── Return Type ─────────────────────────────────────────────

export interface UseGatewayReturn {
  messages: Message[];
  isConnected: boolean;
  isQuerying: boolean;
  sessionId: string | null;
  /** The TypeID (ses_...) of the current session record */
  sessionRecordId: string | null;
  usage: Usage | null;
  eventCount: number;
  visibleCount: number;
  /** Total messages in the full session history */
  totalMessages: number;
  /** Whether there are older messages available to load */
  hasMore: boolean;
  workspace: WorkspaceInfo | null;
  sessions: SessionInfo[];
  sessionConfig: SessionConfigInfo | null;
  sendPrompt(text: string, attachments: Attachment[]): void;
  sendInterrupt(): void;
  loadEarlierMessages(): void;
  createNewSession(title?: string): void;
  switchSession(sessionId: string): void;
  /** Send a raw gateway request (for listing pages) */
  sendRequest(method: string, params?: Record<string, unknown>): void;
  messagesContainerRef: React.RefObject<HTMLDivElement | null>;
  messagesEndRef: React.RefObject<HTMLDivElement | null>;
}

// ─── Hook ────────────────────────────────────────────────────

export function useGateway(
  gatewayUrl: string,
  options: UseGatewayOptions = {},
): UseGatewayReturn {
  const [messages, setMessages] = useImmer<Message[]>([]);
  const [isConnected, setIsConnected] = useState(false);
  const [isQuerying, setIsQuerying] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [sessionRecordId, setSessionRecordId] = useState<string | null>(null);
  const [usage, setUsage] = useState<Usage | null>(null);
  const [eventCount, setEventCount] = useState(0);
  const [visibleCount, setVisibleCount] = useState(50);
  const [totalMessages, setTotalMessages] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [workspace, setWorkspace] = useState<WorkspaceInfo | null>(null);
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [sessionConfig, setSessionConfig] = useState<SessionConfigInfo | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const messagesContainerRef = useRef<HTMLDivElement | null>(null);
  const isQueryingRef = useRef(isQuerying);
  const sessionRecordIdRef = useRef(sessionRecordId);
  const historyLoadedRef = useRef(false);
  const pendingRequestsRef = useRef<Map<string, string>>(new Map());
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const subscribedSessionRef = useRef<string | null>(null);
  const ignoringHaikuMessageRef = useRef(false);

  useEffect(() => {
    isQueryingRef.current = isQuerying;
  }, [isQuerying]);

  useEffect(() => {
    sessionRecordIdRef.current = sessionRecordId;
  }, [sessionRecordId]);

  // Auto-scroll to bottom (instant for history load, smooth for streaming)
  useEffect(() => {
    const behavior = historyLoadedRef.current ? "smooth" : "instant";
    messagesEndRef.current?.scrollIntoView({ behavior });
  }, [messages]);

  // Send a request to the gateway
  const sendRequest = useCallback(
    (method: string, params?: Record<string, unknown>) => {
      if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
      const id = generateId();
      const msg: GatewayMessage = { type: "req", id, method, params };
      pendingRequestsRef.current.set(id, method);
      wsRef.current.send(JSON.stringify(msg));
    },
    [],
  );

  // Subscribe to session-scoped streaming events when we learn the ccSessionId
  const subscribeToSession = useCallback(
    (ccSessionId: string) => {
      if (subscribedSessionRef.current === ccSessionId) return;

      // Unsubscribe from old session's stream if any
      if (subscribedSessionRef.current) {
        sendRequest("unsubscribe", { events: [`stream.${subscribedSessionRef.current}.*`] });
      }

      // Subscribe to this session's stream events
      sendRequest("subscribe", { events: [`stream.${ccSessionId}.*`] });
      subscribedSessionRef.current = ccSessionId;
      console.log(`[WS] Subscribed to stream: stream.${ccSessionId.slice(0, 8)}…*`);
    },
    [sendRequest],
  );

  // ── Message mutation helpers ────────────────────────────────

  const addBlock = useCallback(
    (block: ContentBlock) => {
      // Debug: Check for blocks with display directives
      if (block.type === "text" && typeof block.content === "string" && block.content.startsWith("<")) {
        console.log(`[DEBUG] Assistant text block starting with '<':`, {
          blockType: block.type,
          content: block.content,
          fullBlock: block,
          blockJSON: JSON.stringify(block, null, 2)
        });
      }

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
      // Debug: Check for display directives being appended
      if (text.includes("<is_displaying_contents>") || text.includes("displaying_contents") || text.includes("<") && text.includes(">")) {
        console.log(`[DEBUG] Appending text with angle brackets:`, {
          text,
          field,
          textLength: text.length,
          containsDisplayDirective: text.includes("<is_displaying_contents>")
        });
      }

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

      // Auto-enable thinking for any streaming event (mid-turn recovery after HMR/refresh)
      // Skip for non-content events
      if (!isQueryingRef.current &&
          !["ping", "turn_start", "turn_stop", "stream_end", "request_start", "response_end", "process_started", "process_ended"].includes(eventType)) {
        console.log(`[WS] Mid-turn recovery: enabling thinking for ${eventType}`);
        setIsQuerying(true);
        setEventCount(0);
      }

      switch (eventType) {
        case "request_start": {
          const reqSeq = payload.seq || "?";
          addBlock({
            type: "text",
            content: `🟢 #${reqSeq} request_start - ${new Date().toLocaleTimeString()}`
          });
          break;
        }

        case "response_end": {
          const resSeq = payload.seq || "?";
          const responseStopReason = payload.stop_reason || "unknown";
          addBlock({
            type: "text",
            content: `🔴 #${resSeq} response_end (${responseStopReason}) - ${new Date().toLocaleTimeString()}`
          });
          break;
        }

        case "turn_start": {
          const turnStartSeq = payload.seq || "?";
          setIsQuerying(true);
          setEventCount(0);
          addBlock({
            type: "text",
            content: `🚀 #${turnStartSeq} turn_start - ${new Date().toLocaleTimeString()}`
          });
          break;
        }

        case "stream_end": {
          const streamSeq = payload.seq || "?";
          const streamStopReason = payload.stop_reason || "unknown";
          addBlock({
            type: "text",
            content: `📡 #${streamSeq} stream_end (${streamStopReason}) - ${new Date().toLocaleTimeString()}`
          });
          break;
        }

        case "turn_stop": {
          const turnStopSeq = payload.seq || "?";
          setIsQuerying(false);
          const turnStopReason = payload.stop_reason || "unknown";
          addBlock({
            type: "text",
            content: `🛑 #${turnStopSeq} turn_stop (${turnStopReason}) - ${new Date().toLocaleTimeString()}`
          });
          break;
        }

        case "message_start": {
          // Filter out Haiku model responses (they contain <is_displaying_contents> artifacts)
          const message = payload.message as { model?: string } | undefined;
          if (message?.model?.includes("haiku")) {
            console.log(`[WS] Filtering out Haiku model response: ${message.model}`);
            ignoringHaikuMessageRef.current = true;
            return;
          }

          ignoringHaikuMessageRef.current = false;
          setMessages((draft) => {
            const lastMsg = draft[draft.length - 1];
            if (!lastMsg || lastMsg.role !== "assistant" || lastMsg.blocks.length > 0) {
              draft.push({ role: "assistant", blocks: [] });
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

          const block = payload.content_block as { type: string; id?: string; name?: string } | undefined;
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

          const delta = payload.delta as { type: string; text?: string; thinking?: string; partial_json?: string } | undefined;
          if (!delta) return;
          if (delta.type === "text_delta" && delta.text) appendToCurrentBlock(delta.text);
          else if (delta.type === "thinking_delta" && delta.thinking) appendToCurrentBlock(delta.thinking);
          else if (delta.type === "input_json_delta" && delta.partial_json) appendToCurrentBlock(delta.partial_json, "input");
          break;
        }

        case "request_tool_results": {
          const results = payload.tool_results as Array<{ tool_use_id: string; content: string; is_error?: boolean }> | undefined;
          for (const result of results || []) {
            updateToolResult(result.tool_use_id, { content: result.content, is_error: result.is_error });
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

        case "api_error": {
          console.error(`[API Error] ${payload.status}: ${payload.message}`);
          const errorBlock: ErrorBlock = {
            type: "error",
            message: payload.message as string || `API error ${payload.status}`,
            status: payload.status as number,
          };
          // Ensure there's an assistant message to attach to
          setMessages((draft) => {
            const lastMsg = draft[draft.length - 1];
            if (lastMsg?.role === "assistant") {
              lastMsg.blocks.push(errorBlock);
            } else {
              draft.push({ role: "assistant", blocks: [errorBlock] });
            }
          });
          setIsQuerying(false);
          break;
        }

        case "api_warning": {
          console.warn(`[API Retry] Attempt ${payload.attempt}/${payload.maxRetries}: ${payload.message}`);
          const warningBlock: ErrorBlock = {
            type: "error",
            message: payload.message as string || `API retry ${payload.attempt}/${payload.maxRetries}`,
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
              draft.push({ role: "assistant", blocks: [warningBlock] });
            }
          });
          break;
        }

        default: {
          console.warn(`[WS] Unknown stream event: ${eventType}`, payload);

          // Special debugging for messages containing display directives
          if (payload && typeof payload === "object") {
            const payloadStr = JSON.stringify(payload);
            if (payloadStr.includes("<is_displaying_contents>") ||
                payloadStr.includes("displaying_contents") ||
                payloadStr.includes("display")) {
              console.log(`[DEBUG] Display-related event detected:`, {
                eventType,
                payload: payload,
                rawPayload: payloadStr
              });
            }
          }
          break;
        }
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

          // ── session.history ──
          if (method === "session.history") {
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
                setTimeout(() => { historyLoadedRef.current = true; }, 100);
              }
              console.log(`[History] Loaded ${historyMessages.length}/${total} messages (offset: ${offset}, hasMore: ${more})`);
            }
            setTotalMessages(total);
            setHasMore(more);
            if (historyUsage) setUsage(historyUsage);
          }

          // ── workspace.getOrCreate (VS Code auto-discover) ──
          if (method === "workspace.getOrCreate") {
            const ws = payload.workspace as WorkspaceInfo | undefined;
            if (ws) {
              setWorkspace(ws);
              console.log(`[Workspace] ${payload.created ? "Created" : "Loaded"}: ${ws.name} (${ws.id}), cwd: ${ws.cwd}`);
              console.log(`[Workspace] activeSessionId: ${ws.activeSessionId || "none"}`);

              // If workspace has an active session, load its history
              if (ws.activeSessionId) {
                setSessionRecordId(ws.activeSessionId);
                sendRequest("session.history", { sessionId: ws.activeSessionId, limit: 50 });
                // Also get the CC session ID for this record
                sendRequest("session.get", { sessionId: ws.activeSessionId });
              } else {
                // No active session — auto-create first session for this workspace
                console.log("[Workspace] No active session — creating first session");
                sendRequest("session.create", { workspaceId: ws.id });
              }

              // Load session list for this workspace
              sendRequest("session.list", { workspaceId: ws.id });
            }
          }

          // ── session.get (fetch single session record) ──
          if (method === "session.get") {
            const sessionRecord = payload.session as SessionInfo | undefined;
            if (sessionRecord) {
              setSessionId(sessionRecord.ccSessionId);
              setSessionRecordId(sessionRecord.id);
              subscribeToSession(sessionRecord.ccSessionId);
              console.log(`[Session] Got record: ${sessionRecord.id} (cc: ${sessionRecord.ccSessionId})`);

              // If we don't have workspace/sessions yet, fetch them
              // (this happens in web explicit-session flow)
              if (sessionRecord.workspaceId) {
                sendRequest("workspace.get", { workspaceId: sessionRecord.workspaceId });
                sendRequest("session.list", { workspaceId: sessionRecord.workspaceId });
              }
            }
          }

          // ── workspace.get (fetch single workspace) ──
          if (method === "workspace.get") {
            const ws = payload.workspace as WorkspaceInfo | undefined;
            if (ws) {
              setWorkspace(ws);
              console.log(`[Workspace] Loaded: ${ws.name} (${ws.id})`);
            }
          }

          // ── session.list ──
          if (method === "session.list") {
            const sessionList = payload.sessions as SessionInfo[] | undefined;
            if (sessionList) {
              setSessions(sessionList);
              console.log(`[Sessions] Loaded ${sessionList.length} sessions`, sessionList.map(s => `${s.id} (cc: ${s.ccSessionId.slice(0,8)}…)`));
            }
          }

          // ── session.create ──
          if (method === "session.create") {
            const newSession = payload.session as SessionInfo | undefined;
            if (newSession) {
              setSessionId(newSession.ccSessionId);
              setSessionRecordId(newSession.id);
              subscribeToSession(newSession.ccSessionId);
              setMessages(() => []);
              setUsage(null);
              setTotalMessages(0);
              setHasMore(false);
              historyLoadedRef.current = false;
              console.log(`[Session] Created: ${newSession.id}`);
              sendRequest("session.list");
            }
          }

          // ── session.switch ──
          if (method === "session.switch") {
            const switched = payload.session as SessionInfo | undefined;
            if (switched) {
              setSessionId(switched.ccSessionId);
              setSessionRecordId(switched.id);
              subscribeToSession(switched.ccSessionId);
              setMessages(() => []);
              setUsage(null);
              setTotalMessages(0);
              setHasMore(false);
              historyLoadedRef.current = false;
              console.log(`[Session] Switched to: ${switched.id}`);
              sendRequest("session.history", { sessionId: switched.id, limit: 50 });
              sendRequest("session.list");
            }
          }

          // ── session.info ──
          if (method === "session.info") {
            if (payload.sessionId) {
              setSessionId(payload.sessionId as string);
              subscribeToSession(payload.sessionId as string);
            }
            const sessionRecord = payload.session as SessionInfo | undefined;
            if (sessionRecord) setSessionRecordId(sessionRecord.id);
            if (payload.workspaceId && payload.workspaceName) {
              setWorkspace((prev) => prev ? {
                ...prev,
                id: payload.workspaceId as string,
                name: payload.workspaceName as string,
              } : null);
            }
            // Extract session config (model, thinking, etc.)
            const cfg = payload.sessionConfig as SessionConfigInfo | undefined;
            if (cfg) {
              setSessionConfig(cfg);
              console.log(`[Config] model: ${cfg.model}, thinking: ${cfg.thinking}, budget: ${cfg.thinkingBudget}`);
            }
          }
        }
        return;
      }

      if (msg.type === "event" && msg.event) {
        // Streaming events: "stream.{sessionId}.{eventType}"
        // Extract the eventType (everything after "stream.{sessionId}.")
        const parts = msg.event.split(".");
        if (parts[0] === "stream" && parts.length >= 3) {
          const eventType = parts.slice(2).join(".");
          const payload = msg.payload as Record<string, unknown>;
          handleStreamEvent(eventType, payload);
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
      // when we learn the ccSessionId from session.get/create/switch/info
      sendRequest("session.info");

      const opts = optionsRef.current;

      if (opts.sessionId) {
        // ── Web client: explicit session ID ──
        // Load history for this specific session
        setSessionRecordId(opts.sessionId);
        sendRequest("session.history", { sessionId: opts.sessionId, limit: 50 });
        sendRequest("session.get", { sessionId: opts.sessionId });
      } else if (opts.autoDiscoverCwd) {
        // ── VS Code: auto-discover by CWD ──
        // This triggers workspace creation + session discovery + history loading
        sendRequest("workspace.getOrCreate", { cwd: opts.autoDiscoverCwd });
      } else {
        // ── No session specified (e.g. listing pages) ──
        // Just get basic info
        sendRequest("session.info");
      }
    };

    ws.onclose = () => {
      console.log("Disconnected from Gateway");
      setIsConnected(false);
    };

    ws.onmessage = (event) => {
      const data: GatewayMessage = JSON.parse(event.data);
      handleGatewayMessage(data);
    };

    return () => { ws.close(); };
  }, [gatewayUrl]);

  // ── Actions ────────────────────────────────────────────────

  const sendPrompt = useCallback(
    (text: string, attachments: Attachment[]) => {
      if ((!text.trim() && attachments.length === 0) || !wsRef.current) return;

      const blocks: ContentBlock[] = [
        ...attachments.filter((f) => f.type === "image").map((f) => ({
          type: "image" as const, mediaType: f.mediaType, data: f.data,
        })),
        ...attachments.filter((f) => f.type === "file").map((f) => ({
          type: "file" as const, mediaType: f.mediaType, data: f.data, filename: f.filename,
        })),
        ...(text.trim() ? [{ type: "text" as const, content: text }] : []),
      ];

      setMessages((draft) => { draft.push({ role: "user", blocks }); });
      // Pass session record ID so the gateway targets the right session
      const params: Record<string, unknown> = { content: text };
      if (sessionRecordIdRef.current) params.sessionId = sessionRecordIdRef.current;
      sendRequest("session.prompt", params);
    },
    [sendRequest, setMessages],
  );

  const sendInterrupt = useCallback(() => {
    if (!isQueryingRef.current) return;
    sendRequest("session.interrupt");
  }, [sendRequest]);

  const loadEarlierMessages = useCallback(() => {
    if (!hasMore) return;
    // Request next page of older messages from the server
    const offset = messages.length;
    const params: Record<string, unknown> = { limit: 50, offset };
    if (sessionRecordIdRef.current) params.sessionId = sessionRecordIdRef.current;
    sendRequest("session.history", params);
  }, [hasMore, messages.length, sendRequest]);

  const createNewSession = useCallback(
    (title?: string) => { sendRequest("session.create", title ? { title } : undefined); },
    [sendRequest],
  );

  const switchSession = useCallback(
    (sid: string) => { sendRequest("session.switch", { sessionId: sid }); },
    [sendRequest],
  );

  return {
    messages, isConnected, isQuerying, sessionId, sessionRecordId,
    usage, eventCount, visibleCount, totalMessages, hasMore,
    workspace, sessions, sessionConfig,
    sendPrompt, sendInterrupt, loadEarlierMessages,
    createNewSession, switchSession, sendRequest,
    messagesContainerRef, messagesEndRef,
  };
}
