/**
 * Parse Claude Code session JSONL files into UI-friendly Message[] format.
 *
 * Reads the JSONL files that Claude Code writes to ~/.claude/projects/ and
 * transforms them into the same Message/ContentBlock structure the UI expects.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// ── Types matching @claudia/ui ──────────────────────────────

interface TextBlock {
  type: "text" | "thinking";
  content: string;
}

interface ImageBlock {
  type: "image";
  mediaType: string;
  data: string;
}

interface FileBlock {
  type: "file";
  mediaType: string;
  data: string;
  filename?: string;
}

interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: string;
  result?: {
    content: string;
    is_error?: boolean;
  };
}

type ContentBlock = TextBlock | ImageBlock | FileBlock | ToolUseBlock;

export interface HistoryMessage {
  role: "user" | "assistant";
  blocks: ContentBlock[];
  timestamp?: string;
}

export interface HistoryUsage {
  input_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  output_tokens: number;
}

// ── Raw JSONL entry ─────────────────────────────────────────

interface JsonlEntry {
  type: string;
  timestamp?: string;
  message?: {
    role: string;
    content: string | unknown[];
    usage?: Record<string, number>;
  };
  isCompactSummary?: boolean;
  isMeta?: boolean;
}

// ── Parsers ─────────────────────────────────────────────────

function parseUserContent(content: string | unknown[]): ContentBlock[] {
  if (typeof content === "string") {
    return content.trim() ? [{ type: "text", content }] : [];
  }

  const blocks: ContentBlock[] = [];
  for (const item of content as Record<string, unknown>[]) {
    if (typeof item === "string") {
      if ((item as string).trim()) blocks.push({ type: "text", content: item as string });
    } else if (item.type === "text" && item.text) {
      blocks.push({ type: "text", content: item.text as string });
    } else if (item.type === "image" && item.source) {
      const src = item.source as Record<string, string>;
      blocks.push({
        type: "image",
        mediaType: src.media_type || "image/png",
        data: src.data || "",
      });
    } else if (item.type === "document" && item.source) {
      const src = item.source as Record<string, string>;
      blocks.push({
        type: "file",
        mediaType: src.media_type || "application/octet-stream",
        data: src.data || "",
        filename: item.filename as string | undefined,
      });
    }
  }
  return blocks;
}

function parseAssistantContent(content: unknown[]): ContentBlock[] {
  if (!Array.isArray(content)) return [];

  const blocks: ContentBlock[] = [];
  for (const item of content as Record<string, unknown>[]) {
    if (item.type === "text" && item.text) {
      blocks.push({ type: "text", content: item.text as string });
    } else if (item.type === "thinking" && item.thinking) {
      blocks.push({ type: "thinking", content: item.thinking as string });
    } else if (item.type === "tool_use") {
      blocks.push({
        type: "tool_use",
        id: (item.id as string) || "",
        name: (item.name as string) || "Unknown",
        input:
          typeof item.input === "string"
            ? item.input
            : JSON.stringify(item.input || {}, null, 2),
      });
    }
  }
  return blocks;
}

function extractToolResults(
  content: unknown[],
): Map<string, { content: string; is_error?: boolean }> {
  const results = new Map<string, { content: string; is_error?: boolean }>();
  if (!Array.isArray(content)) return results;

  for (const item of content as Record<string, unknown>[]) {
    if (item.type === "tool_result" && item.tool_use_id) {
      let resultContent = "";
      if (typeof item.content === "string") {
        resultContent = item.content;
      } else if (Array.isArray(item.content)) {
        resultContent = (item.content as Record<string, unknown>[])
          .filter((c) => c.type === "text")
          .map((c) => (c.text as string) || "")
          .join("\n");
      }
      results.set(item.tool_use_id as string, {
        content: resultContent,
        is_error: item.is_error as boolean | undefined,
      });
    }
  }
  return results;
}

// ── Public API ──────────────────────────────────────────────

/**
 * Parse a Claude Code session JSONL file into Message[] for the UI.
 */
export function parseSessionFile(filepath: string): HistoryMessage[] {
  const content = readFileSync(filepath, "utf-8");
  const lines = content.split("\n").filter((line) => line.trim());

  const messages: HistoryMessage[] = [];
  const pendingToolResults = new Map<
    string,
    { content: string; is_error?: boolean }
  >();

  for (const line of lines) {
    let entry: JsonlEntry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }

    if (entry.type !== "user" && entry.type !== "assistant") continue;
    if (entry.isMeta) continue;

    const message = entry.message;
    if (!message || !message.content) continue;

    if (entry.type === "user") {
      const toolResults = extractToolResults(message.content as unknown[]);

      if (toolResults.size > 0) {
        // Attach tool results to previous assistant's tool_use blocks
        for (const [toolId, result] of toolResults) {
          pendingToolResults.set(toolId, result);
        }
        for (const msg of messages) {
          if (msg.role === "assistant") {
            for (const block of msg.blocks) {
              if (block.type === "tool_use" && pendingToolResults.has(block.id)) {
                block.result = pendingToolResults.get(block.id);
                pendingToolResults.delete(block.id);
              }
            }
          }
        }

        // Only add if there's non-tool-result content
        const userBlocks = parseUserContent(message.content);
        const hasContent = userBlocks.some(
          (b) => b.type === "text" || b.type === "image",
        );
        if (hasContent) {
          messages.push({ role: "user", blocks: userBlocks, timestamp: entry.timestamp });
        }
      } else {
        const blocks = parseUserContent(message.content);
        if (blocks.length > 0) {
          messages.push({ role: "user", blocks, timestamp: entry.timestamp });
        }
      }
    } else if (entry.type === "assistant") {
      const blocks = parseAssistantContent(message.content as unknown[]);
      if (blocks.length > 0) {
        messages.push({ role: "assistant", blocks, timestamp: entry.timestamp });
      }
    }
  }

  return messages;
}

/**
 * Extract the last usage data from a session JSONL file.
 */
export function parseSessionUsage(filepath: string): HistoryUsage | null {
  const content = readFileSync(filepath, "utf-8");
  const lines = content.split("\n").filter((line) => line.trim());

  let lastUsage: HistoryUsage | null = null;

  for (const line of lines) {
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }

    if (entry.type === "assistant") {
      const message = entry.message as Record<string, unknown> | undefined;
      const usage = message?.usage as Record<string, number> | undefined;
      if (usage) {
        lastUsage = {
          input_tokens: usage.input_tokens || 0,
          cache_creation_input_tokens: usage.cache_creation_input_tokens || 0,
          cache_read_input_tokens: usage.cache_read_input_tokens || 0,
          output_tokens: usage.output_tokens || 0,
        };
      }
    }
  }

  return lastUsage;
}

/**
 * Resolve a session ID to a JSONL file path.
 * Searches ~/.claude/projects/ recursively.
 */
export function resolveSessionPath(sessionId: string): string | null {
  // If already a full path, use it
  if (sessionId.includes("/")) {
    return existsSync(sessionId) ? sessionId : null;
  }

  const projectsDir = join(homedir(), ".claude", "projects");

  const searchDir = (dir: string): string | null => {
    if (!existsSync(dir)) return null;

    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        const found = searchDir(fullPath);
        if (found) return found;
      } else if (entry.isFile() && entry.name === `${sessionId}.jsonl`) {
        return fullPath;
      }
    }
    return null;
  };

  return searchDir(projectsDir);
}
