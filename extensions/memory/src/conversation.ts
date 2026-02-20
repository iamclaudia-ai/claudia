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

/**
 * Split entries into conversation segments based on time gaps.
 */
function segmentByGaps(
  sessionId: string,
  sourceFile: string,
  entries: Array<{ timestamp: string }>,
  gapMinutes: number,
): ConversationSegment[] {
  if (entries.length === 0) return [];

  const gapMs = gapMinutes * 60 * 1000;
  const segments: ConversationSegment[] = [];

  let segStart = entries[0].timestamp;
  let segEnd = entries[0].timestamp;
  let segCount = 1;

  for (let i = 1; i < entries.length; i++) {
    const prev = new Date(entries[i - 1].timestamp).getTime();
    const curr = new Date(entries[i].timestamp).getTime();
    const gap = curr - prev;

    if (gap > gapMs) {
      // Gap detected — close current segment, start new one
      segments.push({
        sessionId,
        sourceFile,
        firstMessageAt: segStart,
        lastMessageAt: segEnd,
        entryCount: segCount,
      });
      segStart = entries[i].timestamp;
      segEnd = entries[i].timestamp;
      segCount = 1;
    } else {
      segEnd = entries[i].timestamp;
      segCount++;
    }
  }

  // Close final segment
  segments.push({
    sessionId,
    sourceFile,
    firstMessageAt: segStart,
    lastMessageAt: segEnd,
    entryCount: segCount,
  });

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
  // Get all entries for this file, ordered by timestamp
  const entries = getDb()
    .query(
      `SELECT timestamp FROM memory_transcript_entries
      WHERE source_file = ?
      ORDER BY timestamp ASC, id ASC`,
    )
    .all(sourceFile) as Array<{ timestamp: string }>;

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
