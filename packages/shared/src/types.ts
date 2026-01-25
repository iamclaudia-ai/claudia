/**
 * Core types for Claudia
 */

export interface Session {
  id: string;
  createdAt: Date;
  lastActiveAt: Date;
  status: 'idle' | 'thinking' | 'streaming' | 'error';
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
  source?: string; // "session" | "extension:voice" | "gateway"
  sessionId?: string;
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

  /** Called when the extension is loaded */
  start(ctx: ExtensionContext): Promise<void>;
  /** Called when the extension is unloaded */
  stop(): Promise<void>;
  /** Handle a method call from a client */
  handleMethod(method: string, params: Record<string, unknown>): Promise<unknown>;
  /** Health check */
  health(): { ok: boolean; details?: Record<string, unknown> };
}
