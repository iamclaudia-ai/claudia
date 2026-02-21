/**
 * Libby — Claudia's Librarian
 *
 * Processes conversations through a queue-based background worker.
 * Conversations are marked "queued" by memory.process, then the worker
 * picks them up one at a time: queued → processing → archived.
 *
 * Libby uses tools (Read, Write, Edit, Glob) to write memories directly
 * to ~/memory/ — no JSON extraction, no memory-writer intermediary.
 * After each conversation, episode ordering is verified and changes
 * are committed to git.
 *
 * Uses a dedicated workspace at ~/libby for Libby's sessions.
 * One session is reused across sequential processing — this means:
 * - Less overhead (one CLI process, not one per conversation)
 * - Natural cross-conversation coherence
 * - System prompt sent once as the first message, transcripts follow
 * - Single long-lived session — relies on auto-compaction for context management
 *
 * The worker sleeps when idle and can be woken via AbortController
 * when new conversations are queued. Survives crashes: on startup,
 * any conversations stuck in "processing" are reset to "queued".
 */

import { readFileSync, mkdirSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { join } from "node:path";
import { homedir } from "node:os";
import type { ExtensionContext } from "@claudia/shared";
import {
  getNextQueued,
  getQueuedCount,
  getEntriesForConversation,
  getProcessingConversations,
  updateConversationStatus,
  updateConversationProcessed,
  getPreviousConversationContext,
  type ConversationRow,
} from "./db";
import { formatTranscript } from "./transcript-formatter";

// ============================================================================
// System Prompt (loaded once at module level)
// ============================================================================

const SYSTEM_PROMPT = readFileSync(join(import.meta.dir, "prompts", "libby-system.md"), "utf-8");

// Ensure ~/libby exists as Libby's working directory
const LIBBY_CWD = join(homedir(), "libby");
if (!existsSync(LIBBY_CWD)) mkdirSync(LIBBY_CWD, { recursive: true });

const MEMORY_ROOT = join(homedir(), "memory");

// ============================================================================
// Types
// ============================================================================

export interface LibbyConfig {
  gatewayUrl: string;
  model: string;
  timezone: string;
  minConversationMessages: number;
}

// ============================================================================
// Gateway WebSocket Session
// ============================================================================

/**
 * Send a req over a WebSocket and await the response payload.
 */
function wsRequest(
  ws: WebSocket,
  method: string,
  params: Record<string, unknown>,
  timeoutMs = 30_000,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const reqId = `libby-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Gateway '${method}' timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    function handler(event: MessageEvent) {
      try {
        const msg = JSON.parse(event.data as string);
        if (msg.type === "res" && msg.id === reqId) {
          cleanup();
          if (!msg.ok) reject(new Error(msg.error || `Gateway error on ${method}`));
          else resolve(msg.payload ?? {});
        }
      } catch {
        // Ignore parse errors
      }
    }

    function cleanup() {
      clearTimeout(timeout);
      ws.removeEventListener("message", handler);
    }

    ws.addEventListener("message", handler);
    ws.send(JSON.stringify({ type: "req", id: reqId, method, params }));
  });
}

/**
 * A persistent session for Libby's processing.
 *
 * Creates one WebSocket connection and one gateway session,
 * then reuses it for sequential prompts. The system prompt
 * is sent as the first message to establish Libby's identity.
 */
class LibbySession {
  private ws: WebSocket | null = null;
  private sessionId: string | null = null; // Gateway record ID
  private runtimeSessionId: string | null = null; // CLI session ID (ccSessionId)
  private initialized = false;
  promptCount = 0;

  constructor(
    private gatewayUrl: string,
    private model: string,
    private log: (level: string, msg: string) => void,
  ) {}

  get isOpen(): boolean {
    return this.initialized && this.ws !== null;
  }

  /** The runtime session ID (ccSessionId) for this Libby session */
  get ccSessionId(): string | null {
    return this.runtimeSessionId;
  }

  /**
   * Connect to gateway, create workspace + session, send system prompt.
   */
  async open(): Promise<void> {
    this.close(); // Clean up any existing connection

    this.ws = new WebSocket(this.gatewayUrl);

    await new Promise<void>((resolve, reject) => {
      this.ws!.addEventListener("open", () => resolve());
      this.ws!.addEventListener("error", (e) =>
        reject(new Error(`WebSocket connect failed: ${e}`)),
      );
    });

    // Respond to gateway ping/pong to avoid connection pruning
    this.ws.addEventListener("message", (event) => {
      try {
        const msg = JSON.parse(event.data as string);
        if (msg.type === "ping") {
          this.ws?.send(JSON.stringify({ type: "pong", id: msg.id }));
        }
      } catch {
        /* ignore */
      }
    });

    // Get or create Libby's workspace
    const wsResult = await wsRequest(this.ws, "workspace.get-or-create", { cwd: LIBBY_CWD });
    const workspaceId = (wsResult.workspace as Record<string, unknown>)?.id as string;
    if (!workspaceId) throw new Error("Failed to get workspace ID");

    // Create a session — reused for sequential processing
    const sesResult = await wsRequest(this.ws, "workspace.create-session", {
      workspaceId,
      model: this.model,
      thinking: false,
      effort: "low",
    });
    const session = sesResult.session as Record<string, unknown>;
    this.sessionId = session?.id as string;
    this.runtimeSessionId = session?.ccSessionId as string;
    if (!this.sessionId) throw new Error("Failed to get session ID");

    // Send system prompt as first message
    const initPrompt = `${SYSTEM_PROMPT}\n\n---\n\nYou are now ready to process conversation transcripts. For each transcript I send, use your tools to write memories to ~/memory/, then respond with a SUMMARY or SKIP line.\n\nRespond with "ready" to confirm you understand.`;

    await wsRequest(
      this.ws,
      "session.prompt",
      {
        sessionId: this.sessionId,
        content: initPrompt,
        model: this.model,
        thinking: false,
        effort: "low",
        streaming: false,
      },
      60_000,
    );

    this.initialized = true;
    this.promptCount = 0;
  }

  /**
   * Send a transcript for processing and return Libby's response.
   *
   * Libby uses tools (Read/Write/Edit) to write memories directly,
   * then responds with SUMMARY or SKIP. The runtime handles tool
   * execution automatically via bypassPermissions.
   *
   * Fresh session per conversation — no compaction overhead.
   * Previous context is injected via DB-backed summaries.
   */
  async processTranscript(content: string): Promise<string> {
    if (!this.ws || !this.sessionId || !this.initialized) {
      throw new Error("Session not initialized");
    }

    this.promptCount++;

    const promptResult = await wsRequest(
      this.ws,
      "session.prompt",
      {
        sessionId: this.sessionId,
        content,
        model: this.model,
        thinking: false,
        effort: "low",
        streaming: false,
      },
      300_000, // 5 minute timeout — no compaction, just tool use
    );

    const text = promptResult.text as string;
    if (!text) throw new Error("No text in prompt response");
    return text;
  }

  /**
   * Close the session — kill the runtime CLI process via gateway, then drop WebSocket.
   */
  close(): void {
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        /* ignore */
      }
      this.ws = null;
    }
    this.sessionId = null;
    this.runtimeSessionId = null;
    this.initialized = false;
    this.promptCount = 0;
  }
}

// ============================================================================
// Background Worker
// ============================================================================

/** How long the worker sleeps when no queued conversations are found */
const WORKER_SLEEP_MS = 30_000;

/**
 * Background worker that processes queued conversations one at a time.
 *
 * Loop: get next queued → mark processing → send to Libby → verify → git commit → mark archived → repeat.
 * Sleeps when idle. Can be woken via wake() when new items are queued.
 * Session is reused across all conversations — auto-compaction handles context limits.
 */
export class LibbyWorker {
  private running = false;
  private loopPromise: Promise<void> | null = null;
  private sleepAbort: AbortController | null = null;
  private session: LibbySession | null = null;

  constructor(
    private config: LibbyConfig,
    private ctx: ExtensionContext | null,
    private log: (level: string, msg: string) => void,
  ) {}

  /**
   * Start the background processing loop.
   */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.log("INFO", "Libby: Worker started");
    this.loopPromise = this.loop();
  }

  /**
   * Stop the worker and wait for the current loop iteration to finish.
   * This prevents overlapping workers when the extension hot-reloads.
   */
  async stop(): Promise<void> {
    this.running = false;
    this.sleepAbort?.abort();
    // Wait for the loop to finish its current iteration
    if (this.loopPromise) {
      await this.loopPromise;
      this.loopPromise = null;
    }
    this.session?.close();
    this.session = null;
    this.log("INFO", "Libby: Worker stopped");
  }

  /**
   * Wake the worker from sleep to check for new queued items.
   * Called when memory.process queues new conversations.
   */
  wake(): void {
    this.sleepAbort?.abort();
  }

  /**
   * Main processing loop — runs until stop() is called.
   */
  private async loop(): Promise<void> {
    while (this.running) {
      try {
        // Safety: if something is already processing (e.g. zombie from a crashed worker),
        // don't start another one — wait for it to clear or be reset on next restart.
        const alreadyProcessing = getProcessingConversations();
        if (alreadyProcessing.length > 0) {
          this.log(
            "INFO",
            `Libby: Waiting — ${alreadyProcessing.length} conversation(s) already processing`,
          );
          await this.sleep(WORKER_SLEEP_MS);
          continue;
        }

        const conv = getNextQueued();

        if (conv) {
          await this.processOne(conv);
        } else {
          await this.sleep(WORKER_SLEEP_MS);
        }
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        this.log("ERROR", `Libby: Worker loop error: ${msg}`);
        // Brief pause before retrying to avoid tight error loops
        await this.sleep(5000);
      }
    }
  }

  /**
   * Process a single conversation through Libby's tool-based pipeline.
   */
  private async processOne(conv: ConversationRow): Promise<void> {
    const queuedRemaining = getQueuedCount();

    // Skip if below minimum message count
    if (conv.entryCount < this.config.minConversationMessages) {
      updateConversationProcessed(conv.id, "skipped", "Below minimum message count");
      this.log(
        "INFO",
        `Libby: Skipped conversation ${conv.id} (${conv.entryCount} < ${this.config.minConversationMessages} min messages) [${queuedRemaining - 1} queued]`,
      );
      return;
    }

    // Get entries and format transcript
    const entries = getEntriesForConversation(conv.id);
    if (entries.length === 0) {
      updateConversationProcessed(conv.id, "skipped", "No entries found");
      this.log(
        "INFO",
        `Libby: Skipped conversation ${conv.id} (no entries) [${queuedRemaining - 1} queued]`,
      );
      return;
    }

    const transcript = formatTranscript(conv, entries, this.config.timezone);
    const transcriptKB = (transcript.text.length / 1024).toFixed(1);

    // Skip transcripts that would blow the context window (~140K usable tokens)
    const MAX_TRANSCRIPT_KB = 100;
    if (transcript.text.length / 1024 > MAX_TRANSCRIPT_KB) {
      updateConversationProcessed(
        conv.id,
        "skipped",
        `Transcript too large (${transcriptKB}KB > ${MAX_TRANSCRIPT_KB}KB)`,
      );
      this.log(
        "INFO",
        `Libby: Skipped conversation ${conv.id} (${transcriptKB}KB > ${MAX_TRANSCRIPT_KB}KB limit) [${queuedRemaining - 1} queued]`,
      );
      return;
    }

    this.log(
      "INFO",
      `Libby: [${conv.id}] ${transcript.date} ${transcript.timeRange} — ${entries.length} entries, ${transcriptKB}KB transcript [${queuedRemaining - 1} queued]`,
    );

    // Fresh session per conversation — no compaction overhead
    this.session = new LibbySession(this.config.gatewayUrl, this.config.model, this.log);
    this.log("INFO", "Libby: Opening session...");
    await this.session.open();
    this.log("INFO", "Libby: Session ready");

    // Mark as processing with metadata (include ccSessionId for recovery checks)
    updateConversationStatus(conv.id, "processing", {
      transcriptKB: Number(transcriptKB),
      entries: entries.length,
      date: transcript.date,
      timeRange: transcript.timeRange,
      cwd: transcript.primaryCwd,
      ccSessionId: this.session.ccSessionId,
    });

    // Look up previous conversations from same source for context
    const previousContext = getPreviousConversationContext(conv.sourceFile, conv.firstMessageAt);

    let contextBlock = "";
    if (previousContext.length > 0) {
      const ctxEntries = previousContext.map((pc) => {
        const files =
          pc.filesWritten.length > 0
            ? `\nFiles written: ${pc.filesWritten.map((f) => f.replace(homedir() + "/memory/", "")).join(", ")}`
            : "";
        return `- [${pc.date}] ${pc.summary || "(no summary)"}${files}`;
      });
      contextBlock = `\n## Context from Previous Conversations\n\nThese are summaries and files from the conversations immediately before this one in the same session. Use them to resolve ambiguous references like "this", "it", or "what we discussed".\n\n${ctxEntries.join("\n")}\n\n`;
    }

    // Build the prompt — transcript + context (system prompt already sent)
    const prompt = `${contextBlock}Process this conversation transcript. Use your tools to write memories to ~/memory/, then respond with SUMMARY or SKIP:\n\n${transcript.text}`;

    this.log(
      "INFO",
      `Libby: [${conv.id}] Sending ${(prompt.length / 1024).toFixed(1)}KB prompt (session prompt #${this.session.promptCount + 1})`,
    );

    try {
      // Send transcript — Libby uses tools to write files, then responds with SUMMARY/SKIP
      const startTime = Date.now();
      const rawResponse = await this.session.processTranscript(prompt);
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      this.log(
        "INFO",
        `Libby: [${conv.id}] Response received in ${elapsed}s (${rawResponse.length} chars)`,
      );

      // Parse Libby's response — either SKIP or SUMMARY
      const result = parseLibbyResponse(rawResponse);

      if (result.skipped) {
        updateConversationProcessed(conv.id, "skipped", result.summary);
        this.log("INFO", `Libby: [${conv.id}] Skipped in ${elapsed}s — ${result.summary}`);
      } else {
        // Git commit the memory changes
        const filesWritten = commitMemoryChanges(conv.id, result.summary, this.log);

        updateConversationProcessed(conv.id, "archived", result.summary, filesWritten);
        this.log(
          "INFO",
          `Libby: [${conv.id}] Archived in ${elapsed}s — ${filesWritten.length} files changed`,
        );
      }

      this.ctx?.emit("memory.conversation_processed", {
        conversationId: conv.id,
        status: result.skipped ? "skipped" : "archived",
        queued: queuedRemaining - 1,
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.log("ERROR", `Libby: Failed conversation ${conv.id}: ${msg}`);

      // Revert to queued for retry
      updateConversationStatus(conv.id, "queued");
    } finally {
      // Always close session — fresh one per conversation
      this.session?.close();
      this.session = null;
    }
  }

  /**
   * Sleep for the given duration, but wake early if abort is signaled.
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      this.sleepAbort = new AbortController();
      const timeout = setTimeout(() => {
        this.sleepAbort = null;
        resolve();
      }, ms);

      this.sleepAbort.signal.addEventListener("abort", () => {
        clearTimeout(timeout);
        this.sleepAbort = null;
        resolve();
      });
    });
  }
}

// ============================================================================
// Response Parsing
// ============================================================================

interface LibbyResult {
  skipped: boolean;
  summary: string;
}

/**
 * Parse Libby's response text into a result.
 * Libby responds with either "SKIP: reason" or "SUMMARY: one-liner"
 */
function parseLibbyResponse(rawText: string): LibbyResult {
  const text = rawText.trim();

  // Check for SKIP
  const skipMatch = text.match(/^SKIP:\s*(.+)$/im);
  if (skipMatch) {
    return { skipped: true, summary: skipMatch[1].trim() };
  }

  // Check for SUMMARY
  const summaryMatch = text.match(/^SUMMARY:\s*(.+)$/im);
  if (summaryMatch) {
    return { skipped: false, summary: summaryMatch[1].trim() };
  }

  // Fallback: use the last non-empty line as summary
  const lines = text.split("\n").filter((l) => l.trim().length > 0);
  const lastLine = lines[lines.length - 1]?.trim() || "Processed by Libby";
  return { skipped: false, summary: lastLine };
}

// ============================================================================
// Post-Processing
// ============================================================================

/**
 * Git add and commit all changes in ~/memory/.
 * Returns list of files that were changed (from git diff).
 */
function commitMemoryChanges(
  conversationId: number,
  summary: string,
  log: (level: string, msg: string) => void,
): string[] {
  try {
    // Stage all changes
    execSync("git add -A", { cwd: MEMORY_ROOT, stdio: "ignore" });

    // Check if there are staged changes
    try {
      execSync("git diff --cached --quiet", { cwd: MEMORY_ROOT, stdio: "ignore" });
      // No changes — nothing to commit
      return [];
    } catch {
      // Exit code 1 = there ARE changes — proceed with commit
    }

    // Get list of changed files before committing
    const diffOutput = execSync("git diff --cached --name-only", {
      cwd: MEMORY_ROOT,
      encoding: "utf-8",
    }).trim();
    const filesWritten = diffOutput ? diffOutput.split("\n").map((f) => join(MEMORY_ROOT, f)) : [];

    // Commit with summary — use spawnSync to avoid shell quoting issues
    const commitMsg = `libby(${conversationId}): ${summary.slice(0, 100)}`;
    const commitResult = Bun.spawnSync(["git", "commit", "-m", commitMsg], {
      cwd: MEMORY_ROOT,
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (commitResult.exitCode !== 0) {
      const stderr = commitResult.stderr?.toString().trim() || "unknown error";
      throw new Error(`git commit exited with code ${commitResult.exitCode}: ${stderr}`);
    }

    // Log the actual commit hash to verify it really committed
    const commitHash = execSync("git rev-parse --short HEAD", {
      cwd: MEMORY_ROOT,
      encoding: "utf-8",
    }).trim();
    log("INFO", `Libby: Git committed ${filesWritten.length} files (${commitHash})`);
    return filesWritten;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    log("ERROR", `Libby: Git commit failed: ${msg}`);
    return [];
  }
}
