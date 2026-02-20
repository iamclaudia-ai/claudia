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
        created_at AS createdAt
      FROM memory_conversations
      WHERE status = 'ready'
      ORDER BY first_message_at ASC`,
    )
    .all() as ConversationRow[];
}

export function updateConversationStatus(id: number, status: string): void {
  getDb().query("UPDATE memory_conversations SET status = ? WHERE id = ?").run(status, id);
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
