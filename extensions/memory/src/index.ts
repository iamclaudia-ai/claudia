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

import type {
  ClaudiaExtension,
  ExtensionContext,
  HealthCheckResponse,
  HealthItem,
} from "@claudia/shared";
import { existsSync, mkdirSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { z } from "zod";
import {
  getDb,
  closeDb,
  getStats,
  getReadyConversations,
  getEntriesForConversation,
  markConversationsReady,
  getProcessingConversations,
  resetConversationToQueued,
  updateConversationStatus,
  queueConversations,
  getQueuedCount,
  getActiveWorkItems,
} from "./db";
import { ingestFile, ingestDirectory, recoverStuckFiles } from "./ingest";
import { MemoryWatcher } from "./watcher";
import { formatTranscript } from "./transcript-formatter";
import { LibbyWorker, type LibbyConfig } from "./libby";

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
  /** Enable file watching + startup scan + poll timer (default: true) */
  watch?: boolean;
  /** Minutes of silence before a conversation is considered "done" (default: 60) */
  conversationGapMinutes?: number;
  /** Interval in ms to poll for conversations that became ready (default: 30000) */
  pollIntervalMs?: number;
  /** Minimum messages in a conversation for Libby to process it (default: 5) */
  minConversationMessages?: number;
  /** Timezone for Libby's transcript formatting (default: America/New_York) */
  timezone?: string;
  /** Gateway WebSocket URL for Libby's session.prompt calls (default: ws://localhost:30086/ws) */
  gatewayUrl?: string;
  /** Model for Libby to use via session.prompt (default: claude-sonnet-4-6) */
  model?: string;
  /** Max conversations per memory.process invocation (default: 10) */
  processBatchSize?: number;
  /** Auto-process ready conversations on poll timer (default: false) */
  autoProcess?: boolean;
}

const DEFAULT_CONFIG: Required<MemoryConfig> = {
  watchPath: "~/.claude/projects",
  watch: true,
  conversationGapMinutes: 60,
  pollIntervalMs: 30000,
  minConversationMessages: 5,
  timezone: "America/New_York",
  gatewayUrl: "ws://localhost:30086/ws",
  model: "claude-sonnet-4-6",
  processBatchSize: 10,
  autoProcess: false,
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
  let worker: LibbyWorker | null = null;

  return {
    id: "memory",
    name: "Memory (Ingestion + Libby)",
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
            .enum(["active", "ready", "queued", "processing", "archived", "skipped"])
            .optional()
            .describe("Filter by conversation status"),
          limit: z.number().optional().describe("Max conversations to return (default: 50)"),
        }),
      },
      {
        name: "memory.process",
        description:
          "Queue ready conversations for Libby to process into structured memories in ~/memory/. Worker processes them one at a time in the background.",
        inputSchema: z.object({
          batchSize: z
            .number()
            .optional()
            .describe("Max conversations to queue (default: from config)"),
        }),
      },
      {
        name: "memory.process-conversation",
        description:
          "Process a specific conversation by ID through Libby. Temporarily marks it as ready if needed.",
        inputSchema: z.object({
          id: z.number().describe("Conversation ID to process"),
          dryRun: z
            .boolean()
            .optional()
            .describe("Format transcript only, don't call API or write files"),
        }),
      },
    ],
    events: [
      "memory.ingested",
      "memory.conversation_ready",
      "memory.processing_started",
      "memory.conversation_processed",
      "memory.processing_complete",
    ],

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

      // Step 1a: Crash recovery — rollback any files stuck in "ingesting" state
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

      // Step 1b: Reset conversations stuck in "processing" state
      // TODO: Once we have a gateway client SDK, check if the runtime session
      // is still alive before resetting — avoid killing in-flight work.
      try {
        const processing = getProcessingConversations();
        if (processing.length > 0) {
          for (const conv of processing) {
            resetConversationToQueued(conv.id);
          }
          fileLog("INFO", `Reset ${processing.length} conversations stuck in processing`);
          ctx.log.info(`Reset ${processing.length} stuck processing conversations`);
        }
      } catch (error) {
        fileLog(
          "ERROR",
          `Processing recovery failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }

      if (cfg.watch) {
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
            fileLog(
              "ERROR",
              `Poll error: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }, cfg.pollIntervalMs);
      } else {
        ctx.log.info("File watching disabled (watch: false) — DB and methods available");
        fileLog("INFO", "File watching disabled (watch: false)");
      }

      // Step 5: Start Libby's background worker
      const libbyConfig: LibbyConfig = {
        gatewayUrl: cfg.gatewayUrl,
        model: cfg.model,
        timezone: cfg.timezone,
        minConversationMessages: cfg.minConversationMessages,
      };
      worker = new LibbyWorker(libbyConfig, ctx, fileLog);
      worker.start();

      // Check if there are already queued conversations from crash recovery
      const queuedCount = getQueuedCount();
      if (queuedCount > 0) {
        fileLog("INFO", `Found ${queuedCount} queued conversations from previous run`);
        worker.wake();
      }

      ctx.log.info("Memory extension started");
    },

    async stop() {
      ctx?.log.info("Stopping memory extension...");

      if (worker) {
        await worker.stop();
        worker = null;
      }

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
          const s = stats.conversationsByStatus;
          const workItems = getActiveWorkItems();

          const items: HealthItem[] = workItems.map((conv) => {
            const meta = conv.metadata
              ? (JSON.parse(conv.metadata) as Record<string, unknown>)
              : {};
            const isProcessing = conv.status === "processing";

            // Calculate elapsed time for processing items
            let elapsed = "";
            if (isProcessing && conv.statusAt) {
              const elapsedMs = Date.now() - new Date(conv.statusAt + "Z").getTime();
              elapsed =
                elapsedMs < 60_000
                  ? `${Math.round(elapsedMs / 1000)}s`
                  : `${Math.round(elapsedMs / 60_000)}m`;
            }

            // Keep keys consistent so table columns align
            let waiting = "";
            if (!isProcessing && conv.statusAt) {
              const queuedMs = Date.now() - new Date(conv.statusAt + "Z").getTime();
              waiting =
                queuedMs < 60_000
                  ? `${Math.round(queuedMs / 1000)}s`
                  : `${Math.round(queuedMs / 60_000)}m`;
            }

            const details: Record<string, string> = {
              entries: String(conv.entryCount),
              date: conv.firstMessageAt.slice(0, 10),
              transcript: isProcessing && meta.transcriptKB ? `${meta.transcriptKB}KB` : "",
              time: isProcessing && meta.timeRange ? (meta.timeRange as string) : "",
              elapsed: isProcessing ? elapsed : waiting,
            };

            return {
              id: String(conv.id),
              label: isProcessing
                ? `#${conv.id} ${((meta.cwd as string) || conv.sourceFile).replace(/^\/Users\/\w+/, "~")}`
                : `#${conv.id}`,
              status: isProcessing ? "healthy" : "inactive",
              details,
            };
          });

          const response: HealthCheckResponse = {
            ok: true,
            status: "healthy",
            label: "Memory (Transcript Ingestion + Libby)",
            metrics: [
              { label: "Files Tracked", value: String(stats.fileCount) },
              { label: "Entries", value: String(stats.entryCount) },
              { label: "Queued", value: String(s.queued || 0) },
              { label: "Processing", value: String(s.processing || 0) },
              { label: "Ready", value: String(s.ready || 0) },
              { label: "Archived", value: String(s.archived || 0) },
              { label: "Skipped", value: String(s.skipped || 0) },
              { label: "Active", value: String(s.active || 0) },
            ],
            items,
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

          const selectCols = `id, session_id AS sessionId, source_file AS sourceFile,
              first_message_at AS firstMessageAt,
              last_message_at AS lastMessageAt, entry_count AS entryCount,
              status, strategy, summary, processed_at AS processedAt,
              status_at AS statusAt, metadata,
              created_at AS createdAt`;

          if (status) {
            query = `SELECT ${selectCols} FROM memory_conversations
            WHERE status = ?
            ORDER BY last_message_at DESC
            LIMIT ?`;
            queryParams.push(status, limit);
          } else {
            query = `SELECT ${selectCols} FROM memory_conversations
            ORDER BY last_message_at DESC
            LIMIT ?`;
            queryParams.push(limit);
          }

          const conversations = d.query(query).all(...(queryParams as [string, number] | [number]));
          return { conversations, count: conversations.length };
        }

        case "memory.process": {
          const batchSize = (params.batchSize as number) || cfg.processBatchSize;

          const readyCount = getReadyConversations().length;
          const alreadyQueued = getQueuedCount();

          if (readyCount === 0 && alreadyQueued === 0) {
            return {
              status: "nothing_to_do",
              readyConversations: 0,
              queuedConversations: 0,
              message: "No conversations ready or queued for processing.",
            };
          }

          // Queue up to batchSize conversations (ready → queued)
          const newlyQueued = readyCount > 0 ? queueConversations(batchSize) : 0;
          const totalQueued = alreadyQueued + newlyQueued;

          fileLog(
            "INFO",
            `Libby: Queued ${newlyQueued} conversations (${totalQueued} total in queue)`,
          );

          // Wake the worker if it's sleeping
          worker?.wake();

          return {
            status: "queued",
            newlyQueued,
            totalQueued,
            readyConversations: readyCount - newlyQueued,
            message: `Queued ${newlyQueued} conversations (${totalQueued} total). Worker is processing. Watch memory.log for progress.`,
          };
        }

        case "memory.process-conversation": {
          const id = params.id as number;
          const dryRun = (params.dryRun as boolean) || false;

          // Look up conversation
          const d = getDb();
          const conv = d
            .query(
              `SELECT
                id, session_id AS sessionId, source_file AS sourceFile,
                first_message_at AS firstMessageAt,
                last_message_at AS lastMessageAt, entry_count AS entryCount,
                status, strategy, summary, processed_at AS processedAt,
                created_at AS createdAt
              FROM memory_conversations WHERE id = ?`,
            )
            .get(id) as Record<string, unknown> | null;

          if (!conv) {
            throw new Error(`Conversation ${id} not found`);
          }

          const originalStatus = conv.status as string;

          // Format transcript preview
          const entries = getEntriesForConversation(id);
          if (entries.length === 0) {
            return { error: "No entries found for this conversation", conversationId: id };
          }

          const transcript = formatTranscript(conv as any, entries, cfg.timezone);
          const preview = {
            conversationId: id,
            sessionId: conv.sessionId,
            date: transcript.date,
            timeRange: transcript.timeRange,
            cwd: transcript.primaryCwd,
            entryCount: transcript.entryCount,
            chars: transcript.text.length,
            status: originalStatus,
          };

          if (dryRun) {
            return {
              ...preview,
              dryRun: true,
              transcript:
                transcript.text.slice(0, 2000) + (transcript.text.length > 2000 ? "\n..." : ""),
            };
          }

          // Queue this specific conversation for processing
          if (originalStatus !== "queued") {
            fileLog("INFO", `Queuing conversation ${id} for processing (was: ${originalStatus})`);
            updateConversationStatus(id, "queued");
          }

          // Wake the worker to pick it up
          worker?.wake();

          return {
            ...preview,
            status: "queued",
            message: `Conversation ${id} queued for processing. Watch memory.log for progress.`,
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
