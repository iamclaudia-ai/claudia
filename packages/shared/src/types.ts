/**
 * Core types for Claudia
 */

export interface SessionState {
  id: string;
  createdAt: Date;
  lastActiveAt: Date;
  status: 'idle' | 'thinking' | 'streaming' | 'error';
}

// ============================================================================
// Workspace & Session Management
// ============================================================================

export interface Workspace {
  id: string;              // TypeID: ws_<ulid>
  name: string;
  cwd: string;
  activeSessionId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SessionRecord {
  id: string;              // TypeID: ses_<ulid>
  workspaceId: string;
  ccSessionId: string;     // Claude Code UUID (for resume)
  status: 'active' | 'archived';
  title: string | null;
  summary: string | null;
  previousSessionId: string | null;
  lastActivity: string;
  createdAt: string;
}

export interface Extension {
  id: string;
  name: string;
  methods: string[];
  events: string[];
  status: 'starting' | 'running' | 'stopped' | 'error';
}

export interface Client {
  id: string;
  connectedAt: Date;
  subscriptions: Subscription[];
}

export interface Subscription {
  events: string[];  // e.g., ["session.*", "voice.wake"]
  sessionId?: string;  // scope to specific session
  extensionId?: string;  // scope to specific extension
}

// Stream event types from Claude Code
export interface StreamEvent {
  type: string;
  [key: string]: unknown;
}

export interface ChunkEvent extends StreamEvent {
  type: 'chunk';
  text: string;
}

export interface ThinkingEvent extends StreamEvent {
  type: 'thinking';
  thinking: string;
}

export interface ToolUseEvent extends StreamEvent {
  type: 'tool_use';
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResultEvent extends StreamEvent {
  type: 'tool_result';
  output: string;
  isError?: boolean;
}

export interface CompleteEvent extends StreamEvent {
  type: 'complete';
  text: string;
  usage?: {
    inputTokens: number;
    outputTokens: number;
  };
}

export interface ErrorEvent extends StreamEvent {
  type: 'error';
  error: string;
}

// ============================================================================
// Extension System
// ============================================================================

/**
 * Gateway event that flows through the event bus
 */
export interface GatewayEvent {
  type: string;
  payload: unknown;
  timestamp: number;
  /** Event origin (e.g., "session", "extension:voice", "gateway") */
  origin?: string;
  /** Message source for routing (e.g., "imessage/+1555...", "web", "menubar") */
  source?: string;
  sessionId?: string;
}

/**
 * Source routing - maps source prefixes to handlers
 * e.g., "imessage" -> iMessage extension handles all "imessage/*" sources
 */
export interface SourceRoute {
  /** Source prefix this route handles (e.g., "imessage", "slack") */
  prefix: string;
  /** Extension ID that handles this source */
  extensionId: string;
  /** Callback to route responses back to this source */
  handler: (event: GatewayEvent) => Promise<void>;
}

/**
 * Context passed to extensions on start
 */
export interface ExtensionContext {
  /** Subscribe to gateway events */
  on(pattern: string, handler: (event: GatewayEvent) => void | Promise<void>): () => void;
  /** Emit an event to the gateway */
  emit(type: string, payload: unknown): void;
  /** Extension configuration */
  config: Record<string, unknown>;
  /** Logger */
  log: {
    info(msg: string, ...args: unknown[]): void;
    warn(msg: string, ...args: unknown[]): void;
    error(msg: string, ...args: unknown[]): void;
  };
}

/**
 * Extension interface - all extensions must implement this
 */
export interface ClaudiaExtension {
  /** Unique extension ID (e.g., "voice", "memory") */
  id: string;
  /** Human-readable name */
  name: string;
  /** Methods this extension handles (e.g., ["voice.speak", "voice.stop"]) */
  methods: string[];
  /** Events this extension emits (e.g., ["voice.speaking", "voice.done"]) */
  events: string[];
  /** Source prefixes this extension handles for routing (e.g., ["imessage", "slack"]) */
  sourceRoutes?: string[];

  /** Called when the extension is loaded */
  start(ctx: ExtensionContext): Promise<void>;
  /** Called when the extension is unloaded */
  stop(): Promise<void>;
  /** Handle a method call from a client */
  handleMethod(method: string, params: Record<string, unknown>): Promise<unknown>;
  /** Handle a response that needs to be routed back to a source this extension owns */
  handleSourceResponse?(source: string, event: GatewayEvent): Promise<void>;
  /** Health check */
  health(): { ok: boolean; details?: Record<string, unknown> };
}
