/**
 * Memory Extension — Database Access Layer
 *
 * Opens its own bun:sqlite connection to ~/.claudia/claudia.db.
 * Safe for concurrent access: WAL mode + busy_timeout handles
 * contention with the gateway's connection.
 */

import { Database } from "bun:sqlite";
import { join } from "node:path";
import { homedir } from "node:os";

const DB_PATH = join(homedir(), ".claudia", "claudia.db");

let db: Database | null = null;

export function getDb(): Database {
  if (db) return db;

  db = new Database(DB_PATH);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 5000");

  return db;
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}

// ============================================================================
// File States
// ============================================================================

export interface FileState {
  filePath: string;
  source: string;
  status: "idle" | "ingesting";
  lastModified: number;
  fileSize: number;
  lastProcessedOffset: number;
  lastEntryTimestamp: string | null;
  createdAt: string;
  updatedAt: string;
}

export function getFileState(filePath: string): FileState | null {
  const row = getDb()
    .query(
      `SELECT
        file_path AS filePath,
        source,
        status,
        last_modified AS lastModified,
        file_size AS fileSize,
        last_processed_offset AS lastProcessedOffset,
        last_entry_timestamp AS lastEntryTimestamp,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM memory_file_states WHERE file_path = ?`,
    )
    .get(filePath) as FileState | null;
  return row;
}

/**
 * Mark a file as ingesting — sets the high water mark (file_size)
 * before we start reading. If the file is new, creates the row.
 */
export function markFileIngesting(state: {
  filePath: string;
  source: string;
  lastModified: number;
  fileSize: number;
}): void {
  getDb()
    .query(
      `INSERT INTO memory_file_states
        (file_path, source, status, last_modified, file_size, updated_at)
      VALUES (?, ?, 'ingesting', ?, ?, datetime('now'))
      ON CONFLICT(file_path) DO UPDATE SET
        source = excluded.source,
        status = 'ingesting',
        last_modified = excluded.last_modified,
        file_size = excluded.file_size,
        updated_at = datetime('now')`,
    )
    .run(state.filePath, state.source, state.lastModified, state.fileSize);
}

/**
 * Mark a file as idle after successful ingestion.
 * Updates offset and last entry timestamp atomically.
 */
export function markFileIdle(state: {
  filePath: string;
  lastProcessedOffset: number;
  lastEntryTimestamp: string | null;
}): void {
  getDb()
    .query(
      `UPDATE memory_file_states SET
        status = 'idle',
        last_processed_offset = ?,
        last_entry_timestamp = COALESCE(?, last_entry_timestamp),
        updated_at = datetime('now')
      WHERE file_path = ?`,
    )
    .run(state.lastProcessedOffset, state.lastEntryTimestamp, state.filePath);
}

// ============================================================================
// Crash Recovery
// ============================================================================

/**
 * Find all files stuck in 'ingesting' state (crashed mid-import).
 */
export function getStuckFiles(): FileState[] {
  return getDb()
    .query(
      `SELECT
        file_path AS filePath, source, status,
        last_modified AS lastModified, file_size AS fileSize,
        last_processed_offset AS lastProcessedOffset,
        last_entry_timestamp AS lastEntryTimestamp,
        created_at AS createdAt, updated_at AS updatedAt
      FROM memory_file_states
      WHERE status = 'ingesting'`,
    )
    .all() as FileState[];
}

/**
 * Roll back a stuck file: delete partially-imported entries
 * (entries for this file with timestamp > last committed timestamp),
 * then reset status to idle.
 */
export function rollbackStuckFile(filePath: string, lastEntryTimestamp: string | null): number {
  const d = getDb();
  let deleted = 0;

  if (lastEntryTimestamp) {
    // Delete entries that were part of the partial import
    const result = d
      .query(
        `DELETE FROM memory_transcript_entries
        WHERE source_file = ? AND timestamp > ?`,
      )
      .run(filePath, lastEntryTimestamp);
    deleted = result.changes;
  } else {
    // No previous timestamp = file was brand new, delete ALL entries for it
    const result = d
      .query("DELETE FROM memory_transcript_entries WHERE source_file = ?")
      .run(filePath);
    deleted = result.changes;
  }

  // Reset to idle (keep last_processed_offset at its pre-crash value)
  d.query(
    `UPDATE memory_file_states SET status = 'idle', updated_at = datetime('now')
    WHERE file_path = ?`,
  ).run(filePath);

  return deleted;
}

// ============================================================================
// Transcript Entries
// ============================================================================

export interface TranscriptEntryRow {
  id: number;
  sessionId: string;
  sourceFile: string;
  role: "user" | "assistant";
  content: string;
  toolNames: string | null;
  timestamp: string;
  cwd: string | null;
  ingestedAt: string;
}

export interface InsertEntry {
  sessionId: string;
  sourceFile: string;
  role: "user" | "assistant";
  content: string;
  toolNames: string | null;
  timestamp: string;
  cwd: string | null;
}

/**
 * Bulk insert transcript entries (no transaction wrapper — caller manages transaction).
 */
export function insertTranscriptEntriesRaw(entries: InsertEntry[]): void {
  if (entries.length === 0) return;

  const d = getDb();
  const stmt = d.prepare(
    `INSERT INTO memory_transcript_entries
      (session_id, source_file, role, content, tool_names, timestamp, cwd)
    VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );

  for (const e of entries) {
    stmt.run(e.sessionId, e.sourceFile, e.role, e.content, e.toolNames, e.timestamp, e.cwd);
  }
}

/**
 * Delete all entries for a given source file (for re-import).
 */
export function deleteEntriesForFile(sourceFile: string): number {
  const result = getDb()
    .query("DELETE FROM memory_transcript_entries WHERE source_file = ?")
    .run(sourceFile);
  return result.changes;
}

/**
 * Get all entries for a session, optionally up to a timestamp watermark.
 */
export function getEntriesForSession(
  sessionId: string,
  upToTimestamp?: string,
): TranscriptEntryRow[] {
  if (upToTimestamp) {
    return getDb()
      .query(
        `SELECT
          id, session_id AS sessionId, source_file AS sourceFile,
          role, content, tool_names AS toolNames, timestamp,
          cwd, ingested_at AS ingestedAt
        FROM memory_transcript_entries
        WHERE session_id = ? AND timestamp <= ?
        ORDER BY timestamp ASC, id ASC`,
      )
      .all(sessionId, upToTimestamp) as TranscriptEntryRow[];
  }

  return getDb()
    .query(
      `SELECT
        id, session_id AS sessionId, source_file AS sourceFile,
        role, content, tool_names AS toolNames, timestamp,
        cwd, ingested_at AS ingestedAt
      FROM memory_transcript_entries
      WHERE session_id = ?
      ORDER BY timestamp ASC, id ASC`,
    )
    .all(sessionId) as TranscriptEntryRow[];
}

/**
 * Get distinct session IDs that have entries from a given source file.
 */
export function getSessionIdsForFile(sourceFile: string): string[] {
  const rows = getDb()
    .query(
      "SELECT DISTINCT session_id AS sessionId FROM memory_transcript_entries WHERE source_file = ?",
    )
    .all(sourceFile) as Array<{ sessionId: string }>;
  return rows.map((r) => r.sessionId);
}

// ============================================================================
// Conversations
// ============================================================================

export interface ConversationRow {
  id: number;
  sessionId: string;
  sourceFile: string;
  firstMessageAt: string;
  lastMessageAt: string;
  entryCount: number;
  status: string;
  strategy: string | null;
  summary: string | null;
  processedAt: string | null;
  statusAt: string | null;
  metadata: string | null;
  createdAt: string;
}

export function getConversationsForSourceFile(sourceFile: string): ConversationRow[] {
  return getDb()
    .query(
      `SELECT
        id, session_id AS sessionId, source_file AS sourceFile,
        first_message_at AS firstMessageAt,
        last_message_at AS lastMessageAt, entry_count AS entryCount,
        status, strategy, summary, processed_at AS processedAt,
        status_at AS statusAt, metadata,
        created_at AS createdAt
      FROM memory_conversations
      WHERE source_file = ?
      ORDER BY first_message_at ASC`,
    )
    .all(sourceFile) as ConversationRow[];
}

export function upsertConversation(conv: {
  sessionId: string;
  sourceFile: string;
  firstMessageAt: string;
  lastMessageAt: string;
  entryCount: number;
}): void {
  // Match by source_file + first_message_at (unique within a file)
  const existing = getDb()
    .query(
      `SELECT id FROM memory_conversations
      WHERE source_file = ? AND first_message_at = ? AND status NOT IN ('archived', 'skipped')
      LIMIT 1`,
    )
    .get(conv.sourceFile, conv.firstMessageAt) as { id: number } | null;

  if (existing) {
    getDb()
      .query(
        `UPDATE memory_conversations
        SET last_message_at = ?, entry_count = ?
        WHERE id = ?`,
      )
      .run(conv.lastMessageAt, conv.entryCount, existing.id);
  } else {
    getDb()
      .query(
        `INSERT INTO memory_conversations
          (session_id, source_file, first_message_at, last_message_at, entry_count)
        VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        conv.sessionId,
        conv.sourceFile,
        conv.firstMessageAt,
        conv.lastMessageAt,
        conv.entryCount,
      );
  }
}

export function markConversationsReady(gapMinutes: number): number {
  const result = getDb()
    .query(
      `UPDATE memory_conversations
      SET status = 'ready'
      WHERE status = 'active'
        AND datetime(last_message_at, '+' || ? || ' minutes') < datetime('now')`,
    )
    .run(gapMinutes);
  return result.changes;
}

export function getReadyConversations(): ConversationRow[] {
  return getDb()
    .query(
      `SELECT
        id, session_id AS sessionId, source_file AS sourceFile,
        first_message_at AS firstMessageAt,
        last_message_at AS lastMessageAt, entry_count AS entryCount,
        status, strategy, summary, processed_at AS processedAt,
        status_at AS statusAt, metadata,
        created_at AS createdAt
      FROM memory_conversations
      WHERE status = 'ready'
      ORDER BY first_message_at ASC`,
    )
    .all() as ConversationRow[];
}

export function updateConversationStatus(
  id: number,
  status: string,
  metadata?: Record<string, unknown>,
): void {
  if (metadata) {
    getDb()
      .query(
        "UPDATE memory_conversations SET status = ?, status_at = datetime('now'), metadata = ? WHERE id = ?",
      )
      .run(status, JSON.stringify(metadata), id);
  } else {
    getDb()
      .query("UPDATE memory_conversations SET status = ?, status_at = datetime('now') WHERE id = ?")
      .run(status, id);
  }
}

/**
 * Delete conversations for a source file (for re-import rebuild).
 * Only deletes active/ready ones — leaves archived alone.
 */
export function deleteActiveConversationsForFile(sourceFile: string): number {
  const result = getDb()
    .query(
      "DELETE FROM memory_conversations WHERE source_file = ? AND status IN ('active', 'ready')",
    )
    .run(sourceFile);
  return result.changes;
}

// ============================================================================
// Libby Processing (Phase 2)
// ============================================================================

/**
 * Get all transcript entries belonging to a specific conversation.
 * Uses the conversation's source_file + timestamp range to scope entries.
 */
export function getEntriesForConversation(conversationId: number): TranscriptEntryRow[] {
  const d = getDb();
  const conv = d
    .query(
      `SELECT source_file, first_message_at, last_message_at
       FROM memory_conversations WHERE id = ?`,
    )
    .get(conversationId) as {
    source_file: string;
    first_message_at: string;
    last_message_at: string;
  } | null;

  if (!conv) return [];

  return d
    .query(
      `SELECT
        id, session_id AS sessionId, source_file AS sourceFile,
        role, content, tool_names AS toolNames, timestamp,
        cwd, ingested_at AS ingestedAt
      FROM memory_transcript_entries
      WHERE source_file = ?
        AND timestamp >= ?
        AND timestamp <= ?
      ORDER BY timestamp ASC, id ASC`,
    )
    .all(conv.source_file, conv.first_message_at, conv.last_message_at) as TranscriptEntryRow[];
}

/**
 * Mark a conversation as processed by Libby.
 * Sets status, summary, and processed_at timestamp.
 */
export function updateConversationProcessed(
  id: number,
  status: "archived" | "skipped",
  summary: string | null,
  filesWritten?: string[],
): void {
  getDb()
    .query(
      `UPDATE memory_conversations
       SET status = ?, summary = ?, files_written = ?, processed_at = datetime('now')
       WHERE id = ?`,
    )
    .run(status, summary, filesWritten ? JSON.stringify(filesWritten) : null, id);
}

/**
 * Get recent archived conversations from the same source file, for context.
 * Returns the most recent N conversations processed before this one.
 */
export function getPreviousConversationContext(
  sourceFile: string,
  beforeTimestamp: string,
  limit = 2,
): Array<{ id: number; summary: string | null; filesWritten: string[]; date: string }> {
  const rows = getDb()
    .query(
      `SELECT id, summary, files_written AS filesWritten, first_message_at AS date
       FROM memory_conversations
       WHERE source_file = ? AND status = 'archived' AND last_message_at < ?
       ORDER BY last_message_at DESC
       LIMIT ?`,
    )
    .all(sourceFile, beforeTimestamp, limit) as Array<{
    id: number;
    summary: string | null;
    filesWritten: string | null;
    date: string;
  }>;

  return rows.map((r) => ({
    id: r.id,
    summary: r.summary,
    filesWritten: r.filesWritten ? (JSON.parse(r.filesWritten) as string[]) : [],
    date: r.date.slice(0, 10),
  }));
}

/**
 * Get conversations currently in "processing" state with their metadata.
 * Used on startup to check if their runtime sessions are still alive.
 */
export function getProcessingConversations(): Array<{
  id: number;
  ccSessionId: string | null;
}> {
  const rows = getDb()
    .query("SELECT id, metadata FROM memory_conversations WHERE status = 'processing'")
    .all() as Array<{ id: number; metadata: string | null }>;

  return rows.map((r) => {
    let ccSessionId: string | null = null;
    if (r.metadata) {
      try {
        const meta = JSON.parse(r.metadata);
        ccSessionId = meta.ccSessionId ?? null;
      } catch {
        /* ignore parse errors */
      }
    }
    return { id: r.id, ccSessionId };
  });
}

/**
 * Reset a specific conversation from "processing" back to "queued".
 */
export function resetConversationToQueued(id: number): void {
  getDb()
    .query(
      "UPDATE memory_conversations SET status = 'queued' WHERE id = ? AND status = 'processing'",
    )
    .run(id);
}

/**
 * Queue up to `limit` ready conversations for Libby to process.
 * Returns the number of conversations queued.
 */
export function queueConversations(limit: number): number {
  const d = getDb();

  // Select IDs first, then update — bun:sqlite doesn't reliably bind
  // LIMIT params inside subqueries of UPDATE statements.
  const ids = d
    .query(
      `SELECT id FROM memory_conversations
       WHERE status = 'ready'
       ORDER BY first_message_at ASC
       LIMIT ?`,
    )
    .all(limit) as Array<{ id: number }>;

  if (ids.length === 0) return 0;

  const placeholders = ids.map(() => "?").join(",");
  const result = d
    .query(
      `UPDATE memory_conversations
       SET status = 'queued', status_at = datetime('now')
       WHERE id IN (${placeholders})`,
    )
    .run(...ids.map((r) => r.id));
  return result.changes;
}

/**
 * Get the next queued conversation (oldest first).
 */
export function getNextQueued(): ConversationRow | null {
  return getDb()
    .query(
      `SELECT
        id, session_id AS sessionId, source_file AS sourceFile,
        first_message_at AS firstMessageAt,
        last_message_at AS lastMessageAt, entry_count AS entryCount,
        status, strategy, summary, processed_at AS processedAt,
        status_at AS statusAt, metadata,
        created_at AS createdAt
      FROM memory_conversations
      WHERE status = 'queued'
      ORDER BY first_message_at ASC
      LIMIT 1`,
    )
    .get() as ConversationRow | null;
}

/**
 * Get queued and processing conversations (for health check display).
 */
export function getActiveWorkItems(): ConversationRow[] {
  return getDb()
    .query(
      `SELECT
        id, session_id AS sessionId, source_file AS sourceFile,
        first_message_at AS firstMessageAt,
        last_message_at AS lastMessageAt, entry_count AS entryCount,
        status, strategy, summary, processed_at AS processedAt,
        status_at AS statusAt, metadata,
        created_at AS createdAt
      FROM memory_conversations
      WHERE status IN ('queued', 'processing')
      ORDER BY
        CASE status WHEN 'processing' THEN 0 ELSE 1 END,
        first_message_at ASC`,
    )
    .all() as ConversationRow[];
}

/**
 * Get the count of queued conversations.
 */
export function getQueuedCount(): number {
  return (
    getDb()
      .query("SELECT count(*) AS n FROM memory_conversations WHERE status = 'queued'")
      .get() as { n: number }
  ).n;
}

// ============================================================================
// Stats
// ============================================================================

export interface MemoryStats {
  fileCount: number;
  entryCount: number;
  conversationsByStatus: Record<string, number>;
}

export function getStats(): MemoryStats {
  const d = getDb();

  const fileCount = (d.query("SELECT count(*) AS n FROM memory_file_states").get() as { n: number })
    .n;

  const entryCount = (
    d.query("SELECT count(*) AS n FROM memory_transcript_entries").get() as { n: number }
  ).n;

  const statusRows = d
    .query("SELECT status, count(*) AS n FROM memory_conversations GROUP BY status")
    .all() as Array<{ status: string; n: number }>;

  const conversationsByStatus: Record<string, number> = {};
  for (const row of statusRows) {
    conversationsByStatus[row.status] = row.n;
  }

  return { fileCount, entryCount, conversationsByStatus };
}
