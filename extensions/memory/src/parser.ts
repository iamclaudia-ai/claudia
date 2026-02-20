/**
 * Memory Extension — Claude Code JSONL Parser
 *
 * Extracts user and assistant messages from Claude Code session logs.
 * Designed for Libby: captures text content + tool names, skips everything else.
 *
 * Also handles Pi-converted files (same format after pi-to-cc.ts conversion).
 */

export interface ParsedEntry {
  sessionId: string;
  role: "user" | "assistant";
  content: string;
  toolNames?: string[];
  timestamp: string;
  cwd?: string;
}

interface ContentBlock {
  type: string;
  text?: string;
  name?: string;
  id?: string;
}

interface CCEntry {
  type: string;
  message?: {
    role: string;
    content: string | ContentBlock[];
  };
  timestamp?: string;
  sessionId?: string;
  cwd?: string;
  isMeta?: boolean;
  isSidechain?: boolean;
}

/**
 * Extract the session ID from a JSONL filename.
 * Claude Code files are named like: `<uuid>.jsonl`
 * Pi-converted files are named like: `<timestamp>_<uuid>.jsonl`
 */
export function sessionIdFromFilename(filePath: string): string {
  const basename = filePath.split("/").pop() || filePath;
  const withoutExt = basename.replace(/\.jsonl$/, "");

  // Pi format: 2025-11-12T19-10-02-283Z_<uuid>
  const piMatch = withoutExt.match(
    /_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/,
  );
  if (piMatch) return piMatch[1];

  // Claude Code format: just a UUID
  const uuidMatch = withoutExt.match(
    /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/,
  );
  if (uuidMatch) return uuidMatch[1];

  // Fallback: use the whole filename
  return withoutExt;
}

/**
 * Extract text content from a message's content field.
 */
function extractText(content: string | ContentBlock[]): string {
  if (typeof content === "string") return content;

  const parts: string[] = [];
  for (const block of content) {
    if (block.type === "text" && block.text) {
      parts.push(block.text);
    }
  }
  return parts.join("\n\n");
}

/**
 * Extract tool names from an assistant message's content blocks.
 */
function extractToolNames(content: string | ContentBlock[]): string[] {
  if (typeof content === "string") return [];

  const names: string[] = [];
  for (const block of content) {
    if (block.type === "tool_use" && block.name) {
      names.push(block.name);
    }
  }
  return names;
}

/**
 * Check if a user message contains tool_result blocks.
 */
function hasToolResult(content: string | ContentBlock[]): boolean {
  if (typeof content === "string") return false;
  return content.some((block) => block.type === "tool_result");
}

/**
 * Parse JSONL lines into transcript entries.
 * Lines can be the full file content or incremental new bytes.
 */
export function parseLines(content: string, sourceFile: string): ParsedEntry[] {
  const lines = content.split("\n").filter((l) => l.trim());
  const entries: ParsedEntry[] = [];

  // Derive fallback session ID from filename
  const fallbackSessionId = sessionIdFromFilename(sourceFile);

  for (const line of lines) {
    let parsed: CCEntry;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }

    // Only process user and assistant message types
    if (parsed.type !== "user" && parsed.type !== "assistant") continue;

    const message = parsed.message;
    if (!message) continue;

    const sessionId = parsed.sessionId || fallbackSessionId;
    const timestamp = parsed.timestamp || new Date().toISOString();
    const cwd = parsed.cwd;

    if (parsed.type === "user" && message.role === "user") {
      // Skip meta messages (command caveats etc.)
      if (parsed.isMeta) continue;
      // Skip sidechain messages (sub-agent conversations)
      if (parsed.isSidechain) continue;
      // Skip tool result messages
      if (hasToolResult(message.content)) continue;

      const text = extractText(message.content);
      if (!text.trim()) continue;

      entries.push({ sessionId, role: "user", content: text, timestamp, cwd });
    } else if (parsed.type === "assistant" && message.role === "assistant") {
      // Skip sidechain
      if (parsed.isSidechain) continue;

      const text = extractText(message.content);
      const toolNames = extractToolNames(message.content);

      // Build content: text + tool summary
      const parts: string[] = [];
      if (text.trim()) parts.push(text);
      if (toolNames.length > 0) {
        parts.push(`[Used tools: ${toolNames.join(", ")}]`);
      }

      if (parts.length === 0) continue;

      entries.push({
        sessionId,
        role: "assistant",
        content: parts.join("\n\n"),
        toolNames: toolNames.length > 0 ? toolNames : undefined,
        timestamp,
        cwd,
      });
    }
  }

  return entries;
}
