/**
 * Memory Extension — Conversation Grouping & Gap Detection
 *
 * Groups transcript entries into conversations by detecting time gaps.
 * Conversations are scoped to source files — entries from different files
 * never merge, even if timestamps overlap (parallel sessions).
 */

import {
  getDb,
  upsertConversation,
  deleteActiveConversationsForFile,
  markConversationsReady,
} from "./db";

interface ConversationSegment {
  sessionId: string;
  sourceFile: string;
  firstMessageAt: string;
  lastMessageAt: string;
  entryCount: number;
}

/** Max entries per conversation segment */
const MAX_ENTRIES_PER_SEGMENT = 200;
/** Max transcript size per segment (bytes) — ~80KB leaves room for system prompt + tools */
const MAX_SEGMENT_BYTES = 80 * 1024;

/**
 * Split entries into conversation segments based on time gaps,
 * entry count, and cumulative message size.
 */
function segmentByGaps(
  sessionId: string,
  sourceFile: string,
  entries: Array<{ timestamp: string; messageSize: number }>,
  gapMinutes: number,
): ConversationSegment[] {
  if (entries.length === 0) return [];

  const gapMs = gapMinutes * 60 * 1000;
  const segments: ConversationSegment[] = [];

  let segStart = entries[0].timestamp;
  let segEnd = entries[0].timestamp;
  let segCount = 1;
  let segBytes = entries[0].messageSize;

  function closeSegment() {
    segments.push({
      sessionId,
      sourceFile,
      firstMessageAt: segStart,
      lastMessageAt: segEnd,
      entryCount: segCount,
    });
  }

  for (let i = 1; i < entries.length; i++) {
    const prev = new Date(entries[i - 1].timestamp).getTime();
    const curr = new Date(entries[i].timestamp).getTime();
    const gap = curr - prev;
    const nextBytes = segBytes + entries[i].messageSize;

    if (gap > gapMs || segCount >= MAX_ENTRIES_PER_SEGMENT || nextBytes > MAX_SEGMENT_BYTES) {
      // Split — close current segment, start new one
      closeSegment();
      segStart = entries[i].timestamp;
      segEnd = entries[i].timestamp;
      segCount = 1;
      segBytes = entries[i].messageSize;
    } else {
      segEnd = entries[i].timestamp;
      segCount++;
      segBytes = nextBytes;
    }
  }

  // Close final segment
  closeSegment();

  return segments;
}

/**
 * Rebuild conversation groupings for a source file.
 * Called after ingestion to update conversation boundaries.
 *
 * Scoped to file: only touches conversations for this file.
 * Archived conversations are left untouched.
 */
export function rebuildConversationsForFile(
  sourceFile: string,
  sessionId: string,
  gapMinutes: number,
): number {
  // Get all entries for this file, ordered by timestamp (with size for chunking)
  const entries = getDb()
    .query(
      `SELECT timestamp, length(content) as messageSize FROM memory_transcript_entries
      WHERE source_file = ?
      ORDER BY timestamp ASC, id ASC`,
    )
    .all(sourceFile) as Array<{ timestamp: string; messageSize: number }>;

  if (entries.length === 0) return 0;

  // Delete existing active/ready conversations for this file (re-import safe)
  deleteActiveConversationsForFile(sourceFile);

  // Segment by time gaps
  const segments = segmentByGaps(sessionId, sourceFile, entries, gapMinutes);

  // Upsert each segment as a conversation
  for (const seg of segments) {
    upsertConversation(seg);
  }

  // Mark conversations as ready if their gap has elapsed
  markConversationsReady(gapMinutes);

  return segments.length;
}
