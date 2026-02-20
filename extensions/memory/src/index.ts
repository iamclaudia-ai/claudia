/**
 * Claudia Memory Extension
 *
 * Ingests session transcripts from JSONL log files into SQLite,
 * groups them into conversations by detecting time gaps, and
 * provides the foundation for Libby (the Librarian) to process
 * completed conversations into durable memories.
 *
 * Startup flow:
 * 1. Connect to DB
 * 2. Scan all JSONL files in watchPath — incremental import (skip unchanged, import new/grown files)
 * 3. Start chokidar watcher for real-time changes
 * 4. Start poll timer for marking conversations as ready
 *
 * All files are keyed relative to watchPath, so importing from
 * ~/.claude/projects-backup and watching ~/.claude/projects produce
 * the same keys — no double imports.
 */

import type { ClaudiaExtension, ExtensionContext, HealthCheckResponse } from "@claudia/shared";
import { existsSync, mkdirSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { z } from "zod";
import { getDb, closeDb, getStats, getReadyConversations, markConversationsReady } from "./db";
import { ingestFile, ingestDirectory, recoverStuckFiles } from "./ingest";
import { MemoryWatcher } from "./watcher";

// ============================================================================
// File Logging (tail -f ~/.claudia/logs/memory.log)
// ============================================================================

const LOG_DIR = join(homedir(), ".claudia", "logs");
if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true });
const LOG_FILE = join(LOG_DIR, "memory.log");

function fileLog(level: string, msg: string): void {
  try {
    const ts = new Date().toISOString();
    appendFileSync(LOG_FILE, `[${ts}] [${level}] ${msg}\n`);
  } catch {
    // Ignore log write errors
  }
}

// ============================================================================
// Configuration
// ============================================================================

export interface MemoryConfig {
  /** Base directory to watch for JSONL sessions (default: ~/.claude/projects) */
  watchPath?: string;
  /** Minutes of silence before a conversation is considered "done" (default: 60) */
  conversationGapMinutes?: number;
  /** Interval in ms to poll for conversations that became ready (default: 30000) */
  pollIntervalMs?: number;
  /** Minimum messages in a conversation for Libby to process it (default: 5) */
  minConversationMessages?: number;
}

const DEFAULT_CONFIG: Required<MemoryConfig> = {
  watchPath: "~/.claude/projects",
  conversationGapMinutes: 60,
  pollIntervalMs: 30000,
  minConversationMessages: 5,
};

// ============================================================================
// Memory Extension
// ============================================================================

export function createMemoryExtension(config: MemoryConfig = {}): ClaudiaExtension {
  const defined = Object.fromEntries(Object.entries(config).filter(([, v]) => v !== undefined));
  const cfg: Required<MemoryConfig> = { ...DEFAULT_CONFIG, ...defined };

  // Expand ~ once
  const expandPath = (p: string) => p.replace(/^~/, homedir());
  const basePath = expandPath(cfg.watchPath);

  let ctx: ExtensionContext | null = null;
  let watcher: MemoryWatcher | null = null;
  let pollTimer: ReturnType<typeof setInterval> | null = null;

  return {
    id: "memory",
    name: "Memory (Transcript Ingestion)",
    methods: [
      {
        name: "memory.health-check",
        description: "Return memory system stats: file count, entry count, conversation breakdown",
        inputSchema: z.object({}),
      },
      {
        name: "memory.ingest",
        description:
          "Manually ingest JSONL file(s) into the memory database. Paths are relative to the watch directory unless absolute.",
        inputSchema: z.object({
          file: z.string().optional().describe("Path to a single JSONL file to ingest"),
          dir: z
            .string()
            .optional()
            .describe("Path to a directory of JSONL files to ingest recursively"),
          reimport: z
            .boolean()
            .optional()
            .describe("Force re-import: delete existing entries and re-ingest"),
        }),
      },
      {
        name: "memory.conversations",
        description: "List conversations with optional status filter",
        inputSchema: z.object({
          status: z
            .enum(["active", "ready", "processing", "archived", "skipped"])
            .optional()
            .describe("Filter by conversation status"),
          limit: z.number().optional().describe("Max conversations to return (default: 50)"),
        }),
      },
      {
        name: "memory.process",
        description: "Trigger Libby to process ready conversations into memories (Phase 2)",
        inputSchema: z.object({}),
      },
    ],
    events: ["memory.ingested", "memory.conversation_ready"],

    async start(context: ExtensionContext) {
      ctx = context;
      fileLog(
        "INFO",
        `Memory extension starting (watchPath=${basePath}, gap=${cfg.conversationGapMinutes}min)`,
      );
      ctx.log.info("Starting memory extension...");

      // Ensure DB connection works
      try {
        getDb();
        ctx.log.info("Database connection established");
      } catch (error) {
        ctx.log.error(
          `Database connection failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        return;
      }

      // Step 1: Crash recovery — rollback any files stuck in "ingesting" state
      try {
        const recovered = recoverStuckFiles(cfg.conversationGapMinutes, fileLog);
        if (recovered > 0) {
          fileLog("INFO", `Crash recovery: rolled back ${recovered} stuck file(s)`);
          ctx.log.info(`Crash recovery: rolled back ${recovered} stuck file(s)`);
        }
      } catch (error) {
        fileLog(
          "ERROR",
          `Crash recovery failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }

      // Step 2: Startup scan — import any new/changed files in watchPath
      if (existsSync(basePath)) {
        fileLog("INFO", `Startup scan: ${basePath}`);
        const scanResult = ingestDirectory(basePath, cfg.conversationGapMinutes);
        if (scanResult.filesProcessed > 0 || scanResult.entriesInserted > 0) {
          fileLog(
            "INFO",
            `Startup scan complete: ${scanResult.filesProcessed} files, ${scanResult.entriesInserted} new entries`,
          );
          ctx.log.info(
            `Startup scan: ${scanResult.filesProcessed} files processed, ${scanResult.entriesInserted} entries imported`,
          );
        } else {
          fileLog("INFO", "Startup scan complete: no changes");
          ctx.log.info("Startup scan: no changes");
        }
        if (scanResult.errors.length > 0) {
          for (const err of scanResult.errors) {
            fileLog("ERROR", `Startup scan error: ${err}`);
          }
        }
      }

      // Step 3: Start file watcher for real-time changes
      watcher = new MemoryWatcher({ basePath, gapMinutes: cfg.conversationGapMinutes }, fileLog);
      watcher.start();
      ctx.log.info(`File watcher started on ${basePath}`);

      // Step 4: Start poll timer to mark conversations as ready
      pollTimer = setInterval(() => {
        try {
          const marked = markConversationsReady(cfg.conversationGapMinutes);
          if (marked > 0) {
            fileLog("INFO", `Marked ${marked} conversations as ready`);
            ctx?.emit("memory.conversation_ready", { count: marked });
          }
        } catch (error) {
          fileLog("ERROR", `Poll error: ${error instanceof Error ? error.message : String(error)}`);
        }
      }, cfg.pollIntervalMs);

      ctx.log.info("Memory extension started");
    },

    async stop() {
      ctx?.log.info("Stopping memory extension...");

      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
      }

      if (watcher) {
        await watcher.stop();
        watcher = null;
      }

      closeDb();
      ctx = null;
    },

    async handleMethod(method: string, params: Record<string, unknown>) {
      switch (method) {
        case "memory.health-check": {
          const stats = getStats();
          const response: HealthCheckResponse = {
            ok: true,
            status: "healthy",
            label: "Memory (Transcript Ingestion)",
            metrics: [
              { label: "Files Tracked", value: String(stats.fileCount) },
              { label: "Entries", value: String(stats.entryCount) },
              ...Object.entries(stats.conversationsByStatus).map(([status, count]) => ({
                label: `Conversations (${status})`,
                value: String(count),
              })),
              { label: "Watch Path", value: cfg.watchPath },
              { label: "Gap (min)", value: String(cfg.conversationGapMinutes) },
            ],
          };
          return response;
        }

        case "memory.ingest": {
          const file = params.file as string | undefined;
          const dir = params.dir as string | undefined;
          const reimport = params.reimport as boolean | undefined;

          if (!file && !dir) {
            throw new Error('Provide either "file" or "dir" parameter');
          }

          if (file) {
            const expanded = expandPath(file);
            // Determine base path: if file is under a known directory, use that as base
            // Otherwise, use the file's parent directory
            const fileBasePath = findBasePath(expanded, basePath);
            fileLog(
              "INFO",
              `Manual ingest: file=${expanded}, base=${fileBasePath}, reimport=${!!reimport}`,
            );
            const result = ingestFile(expanded, fileBasePath, cfg.conversationGapMinutes, {
              forceReimport: reimport,
            });
            ctx?.emit("memory.ingested", result);
            return result;
          }

          if (dir) {
            const expanded = expandPath(dir);
            fileLog("INFO", `Manual ingest: dir=${expanded}, reimport=${!!reimport}`);
            const result = ingestDirectory(expanded, cfg.conversationGapMinutes, {
              forceReimport: reimport,
            });
            ctx?.emit("memory.ingested", result);
            return result;
          }

          return { error: "unreachable" };
        }

        case "memory.conversations": {
          const status = params.status as string | undefined;
          const limit = (params.limit as number) || 50;

          const d = getDb();
          let query: string;
          const queryParams: unknown[] = [];

          if (status) {
            query = `SELECT
              id, session_id AS sessionId, source_file AS sourceFile,
              first_message_at AS firstMessageAt,
              last_message_at AS lastMessageAt, entry_count AS entryCount,
              status, strategy, summary, processed_at AS processedAt,
              created_at AS createdAt
            FROM memory_conversations
            WHERE status = ?
            ORDER BY last_message_at DESC
            LIMIT ?`;
            queryParams.push(status, limit);
          } else {
            query = `SELECT
              id, session_id AS sessionId, source_file AS sourceFile,
              first_message_at AS firstMessageAt,
              last_message_at AS lastMessageAt, entry_count AS entryCount,
              status, strategy, summary, processed_at AS processedAt,
              created_at AS createdAt
            FROM memory_conversations
            ORDER BY last_message_at DESC
            LIMIT ?`;
            queryParams.push(limit);
          }

          const conversations = d.query(query).all(...(queryParams as [string, number] | [number]));
          return { conversations, count: conversations.length };
        }

        case "memory.process": {
          // Phase 2: Libby processing
          const ready = getReadyConversations();
          if (ready.length === 0) {
            return { message: "No conversations ready for processing", count: 0 };
          }

          return {
            message: `${ready.length} conversations ready for processing (Phase 2 not yet implemented)`,
            count: ready.length,
            conversations: ready.map((c) => ({
              id: c.id,
              sessionId: c.sessionId,
              entryCount: c.entryCount,
              firstMessageAt: c.firstMessageAt,
              lastMessageAt: c.lastMessageAt,
            })),
          };
        }

        default:
          throw new Error(`Unknown method: ${method}`);
      }
    },

    health() {
      try {
        const stats = getStats();
        return {
          ok: true,
          details: {
            fileCount: stats.fileCount,
            entryCount: stats.entryCount,
            conversations: stats.conversationsByStatus,
            watchPath: cfg.watchPath,
          },
        };
      } catch {
        return { ok: false, details: { error: "Database not accessible" } };
      }
    },
  };
}

/**
 * Determine the base path for a file.
 * If the file is under the configured watchPath (or its -backup sibling), use that.
 * Otherwise use the directory being imported from.
 */
function findBasePath(filePath: string, configuredBasePath: string): string {
  // Check if file is under the configured watch path
  if (filePath.startsWith(configuredBasePath + "/")) return configuredBasePath;

  // Check common backup pattern (e.g., ~/.claude/projects-backup)
  const backupPath = configuredBasePath + "-backup";
  if (filePath.startsWith(backupPath + "/")) return backupPath;

  // Fallback: use parent directory
  return filePath.substring(0, filePath.lastIndexOf("/"));
}

export default createMemoryExtension;
