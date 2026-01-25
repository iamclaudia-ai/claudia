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
