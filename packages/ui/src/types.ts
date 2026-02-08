// UI-specific types for message display

export interface TextBlock {
  type: "text" | "thinking";
  content: string;
}

export interface ImageBlock {
  type: "image";
  mediaType: string;
  data: string; // base64
}

export interface FileBlock {
  type: "file";
  mediaType: string;
  data: string; // base64
  filename?: string;
}

export interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: string;
  result?: {
    content: string;
    is_error?: boolean;
  };
}

export interface ErrorBlock {
  type: "error";
  message: string;
  status?: number;
  isRetrying?: boolean;
  attempt?: number;
  maxRetries?: number;
  retryInMs?: number;
}

export type ContentBlock = TextBlock | ImageBlock | FileBlock | ToolUseBlock | ErrorBlock;

export interface Message {
  role: "user" | "assistant";
  blocks: ContentBlock[];
  aborted?: boolean;
}

export interface Usage {
  input_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  output_tokens: number;
}

export interface Attachment {
  type: "image" | "file";
  mediaType: string;
  data: string; // base64
  filename?: string;
}

// Gateway protocol types
export interface GatewayMessage {
  type: "req" | "res" | "event";
  id?: string;
  method?: string;
  params?: Record<string, unknown>;
  ok?: boolean;
  payload?: unknown;
  error?: string;
  event?: string;
}

// Editor context (for VS Code integration)
export interface EditorContext {
  filePath: string;
  fileName: string;
  languageId: string;
  relativePath?: string;
  currentLine: number;
  selection?: string;
  selectionRange?: {
    startLine: number;
    endLine: number;
  };
}
