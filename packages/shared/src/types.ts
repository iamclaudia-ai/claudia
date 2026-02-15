import type { ZodTypeAny } from "zod";

/**
 * Core types for Claudia
 */

export interface SessionState {
  id: string;
  createdAt: Date;
  lastActiveAt: Date;
  status: "idle" | "thinking" | "streaming" | "error";
}

// ============================================================================
// Workspace & Session Management
// ============================================================================

export interface Workspace {
  id: string; // TypeID: ws_<ulid>
  name: string;
  cwd: string;
  activeSessionId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SessionRecord {
  id: string; // TypeID: ses_<ulid>
  workspaceId: string;
  ccSessionId: string; // Claude Code UUID (for resume)
  status: "active" | "archived";
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
  status: "starting" | "running" | "stopped" | "error";
}

export interface Client {
  id: string;
  connectedAt: Date;
  subscriptions: Subscription[];
}

export interface Subscription {
  events: string[]; // e.g., ["session.*", "voice.wake"]
  sessionId?: string; // scope to specific session
  extensionId?: string; // scope to specific extension
}

// Stream event types from Claude Code
export interface StreamEvent {
  type: string;
  [key: string]: unknown;
}

export interface ChunkEvent extends StreamEvent {
  type: "chunk";
  text: string;
}

export interface ThinkingEvent extends StreamEvent {
  type: "thinking";
  thinking: string;
}

export interface ToolUseEvent extends StreamEvent {
  type: "tool_use";
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResultEvent extends StreamEvent {
  type: "tool_result";
  output: string;
  isError?: boolean;
}

export interface CompleteEvent extends StreamEvent {
  type: "complete";
  text: string;
  usage?: {
    inputTokens: number;
    outputTokens: number;
  };
}

export interface ErrorEvent extends StreamEvent {
  type: "error";
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
  /** Logger — writes to console + file at ~/.claudia/logs/{extensionId}.log */
  log: {
    info(msg: string, meta?: unknown): void;
    warn(msg: string, meta?: unknown): void;
    error(msg: string, meta?: unknown): void;
  };
}

/**
 * Extension interface - all extensions must implement this
 */
export interface ClaudiaExtension {
  /** Extension method definitions (inputSchema required for validation + discovery) */
  methods: ExtensionMethodDefinition[];
  /** Unique extension ID (e.g., "voice", "memory") */
  id: string;
  /** Human-readable name */
  name: string;
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

export interface ExtensionMethodDefinition {
  /** Fully-qualified method name (e.g., "voice.speak") */
  name: string;
  /** Short human-readable description for CLI/help output */
  description: string;
  /** Required request schema used by gateway as a pre-dispatch bouncer */
  inputSchema: ZodTypeAny;
  /** Optional output schema (future use) */
  outputSchema?: ZodTypeAny;
}

// ============================================================================
// Health Check Contract (for Mission Control)
// ============================================================================

/**
 * Standardized health check response returned by extensions that
 * implement a `{id}.health-check` method. Mission Control discovers
 * these extensions and renders their status generically.
 */
export interface HealthCheckResponse {
  ok: boolean;
  /** Overall status: "healthy", "degraded", "error", "disconnected" */
  status: string;
  /** Display name: "Chat Sessions", "Voice (ElevenLabs)" */
  label: string;
  /** Key stats to display */
  metrics?: HealthMetric[];
  /** Callable actions (kill, restart, etc.) */
  actions?: HealthAction[];
  /** Managed resources (sessions, connections, etc.) */
  items?: HealthItem[];
}

export interface HealthMetric {
  label: string;
  value: string | number;
}

export interface HealthAction {
  /** WebSocket method to call: "runtime.kill-session" */
  method: string;
  /** Button label: "Kill Session" */
  label: string;
  /** Confirmation prompt (shows dialog if set) */
  confirm?: string;
  /** Parameters the UI needs to resolve and pass */
  params: ActionParam[];
  /** "item" = per-row button, "global" = card-level button */
  scope?: "item" | "global";
}

export interface ActionParam {
  /** Parameter name: "sessionId" */
  name: string;
  /** Where to get the value: "item.id" auto-fills from row, "input" prompts user */
  source: "item.id" | "input";
}

export interface HealthItem {
  /** Resource identifier (e.g., session ID) */
  id: string;
  /** Display label: "~/Projects/claudia" */
  label: string;
  /** Status for colored indicator */
  status: "healthy" | "stale" | "dead" | "inactive";
  /** Extra columns: { model: "sonnet-4", lastActivity: "2m ago" } */
  details?: Record<string, string>;
}

// ============================================================================
// Hooks System
// ============================================================================

/**
 * A hook is a lightweight event handler that reacts to gateway lifecycle events.
 * Hooks are loaded by the hooks extension from ~/.claudia/hooks/ and ./hooks/.
 */
export interface HookDefinition {
  /** Events to subscribe to (e.g., "turn_stop", "session.created") */
  event: string | string[];
  /** Human-readable description */
  description?: string;
  /** Handler called when a matching event fires */
  handler(payload: unknown, ctx: HookContext): Promise<void> | void;
}

/**
 * Context passed to hook handlers
 */
export interface HookContext {
  /** Emit an event to the gateway (namespaced as hook.{hookId}.{event}) */
  emit(event: string, payload: unknown): void;
  /** Current workspace info (if available) */
  workspace: { cwd: string } | null;
  /** Current session ID (if available) */
  sessionId: string | null;
  /** Logger */
  log: {
    info(msg: string, meta?: unknown): void;
    warn(msg: string, meta?: unknown): void;
    error(msg: string, meta?: unknown): void;
  };
}
