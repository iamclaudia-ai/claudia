/**
 * WebSocket Protocol Types
 *
 * All communication between clients and the gateway uses JSON over WebSocket.
 */

// ============================================================================
// Request/Response Pattern
// ============================================================================

/** Client → Gateway request */
export interface Request {
  type: "req";
  id: string; // Client-generated, used to match response
  method: string; // e.g., "session.create", "voice.speak"
  params?: Record<string, unknown>;
}

/** Gateway → Client response */
export interface Response {
  type: "res";
  id: string; // Matches the request id
  ok: boolean;
  payload?: unknown;
  error?: string;
}

/** Gateway → Client push event */
export interface Event {
  type: "event";
  event: string; // e.g., "session.chunk", "voice.wake"
  payload: unknown;
}

export type Message = Request | Response | Event;

// ============================================================================
// Session Methods
// ============================================================================

export interface SessionCreateParams {
  systemPrompt?: string;
  resumeSessionId?: string;
}

export interface SessionCreateResult {
  sessionId: string;
}

export interface SessionPromptParams {
  sessionId: string;
  content: string | ContentBlock[];
}

export interface ContentBlock {
  type: "text" | "image";
  text?: string;
  source?: {
    type: "base64";
    mediaType: string;
    data: string;
  };
}

export interface SessionInterruptParams {
  sessionId: string;
}

export interface SessionCloseParams {
  sessionId: string;
}

// ============================================================================
// Session Events
// ============================================================================

export interface SessionChunkEvent {
  sessionId: string;
  text: string;
}

export interface SessionThinkingEvent {
  sessionId: string;
  thinking: string;
}

export interface SessionToolUseEvent {
  sessionId: string;
  name: string;
  input: Record<string, unknown>;
}

export interface SessionCompleteEvent {
  sessionId: string;
  text: string;
  usage?: {
    inputTokens: number;
    outputTokens: number;
  };
}

export interface SessionErrorEvent {
  sessionId: string;
  error: string;
}

// ============================================================================
// Client Methods
// ============================================================================

export interface SubscribeParams {
  events: string[]; // e.g., ["session.*", "voice.wake"]
  sessionId?: string;
  extensionId?: string;
}

export interface UnsubscribeParams {
  events: string[];
}

// ============================================================================
// Extension Methods (namespaced by extension)
// ============================================================================

// voice.*
export interface VoiceSpeakParams {
  text: string;
  voice?: string;
}

export interface VoiceListenParams {
  timeoutMs?: number;
}

// memory.*
export interface MemorySearchParams {
  query: string;
  limit?: number;
}

export interface MemoryStoreParams {
  content: string;
  metadata?: Record<string, unknown>;
}

// browser.*
export interface BrowserNavigateParams {
  url: string;
  tabId?: string;
}

export interface BrowserSnapshotParams {
  tabId?: string;
}
