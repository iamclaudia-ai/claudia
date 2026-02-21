/**
 * Transcript Formatter
 *
 * Converts raw DB entries into a human-readable transcript for Libby.
 * All timestamps are converted from UTC to local time (configurable timezone).
 *
 * Format:
 *   # Conversation Transcript
 *   Date: Thursday, February 20, 2026
 *   Time: 8:00 PM – 11:30 PM (Eastern)
 *   Session: abc-123-def
 *   Project: /Users/michael/Projects/iamclaudia-ai/claudia
 *   ---
 *   [8:00 PM] Michael:
 *   can you write a script that...
 *
 *   [8:02 PM] Claudia:
 *   Sure! Let me create that...
 */

import type { TranscriptEntryRow, ConversationRow } from "./db";

export interface FormattedTranscript {
  /** The full formatted transcript text */
  text: string;
  /** Local date string: "2026-02-20" */
  date: string;
  /** Human-readable time range: "8:00 PM – 11:30 PM (Eastern)" */
  timeRange: string;
  /** Most frequently used working directory, or null */
  primaryCwd: string | null;
  /** Session UUID */
  sessionId: string;
  /** Number of entries in the transcript */
  entryCount: number;
}

/** Max characters per individual message before truncation */
const MAX_MESSAGE_CHARS = 2000;
/** Max total transcript characters (~20K tokens) */
const MAX_TRANSCRIPT_CHARS = 80_000;

/**
 * Format a conversation's entries into a readable transcript.
 */
export function formatTranscript(
  conversation: ConversationRow,
  entries: TranscriptEntryRow[],
  timezone: string = "America/New_York",
): FormattedTranscript {
  if (entries.length === 0) {
    return {
      text: "(empty conversation)",
      date: conversation.firstMessageAt.slice(0, 10),
      timeRange: "",
      primaryCwd: null,
      sessionId: conversation.sessionId,
      entryCount: 0,
    };
  }

  // Detect primary cwd (most frequent non-null value)
  const primaryCwd = detectPrimaryCwd(entries);

  // Convert first/last timestamps to local time
  const firstTs = new Date(entries[0].timestamp);
  const lastTs = new Date(entries[entries.length - 1].timestamp);

  const localDate = formatLocalDate(firstTs, timezone);
  const localDateStr = formatDateString(firstTs, timezone);
  const timeRange = `${formatTime(firstTs, timezone)} – ${formatTime(lastTs, timezone)} (${getTimezoneAbbr(firstTs, timezone)})`;

  // Build header
  const lines: string[] = [
    "# Conversation Transcript",
    `Date: ${localDate}`,
    `Time: ${timeRange}`,
    `Session: ${conversation.sessionId}`,
  ];

  if (primaryCwd) {
    lines.push(`Project: ${primaryCwd}`);
  }

  lines.push("", "---", "");

  // Format each entry, filtering out low-value tool-call noise
  let totalChars = lines.join("\n").length;
  let skippedToolMessages = 0;

  for (const entry of entries) {
    // Skip assistant messages that are purely tool-call results —
    // short content (< 200 chars) with tool names = just tool output, not real dialogue.
    // This keeps the transcript focused on human conversation while noting tool use.
    if (entry.role === "assistant" && entry.toolNames && entry.content.length < 200) {
      skippedToolMessages++;
      continue;
    }

    const ts = new Date(entry.timestamp);
    const time = formatTime(ts, timezone);
    const speaker = entry.role === "user" ? "Michael" : "Claudia";

    let content = entry.content;

    // Truncate long messages
    if (content.length > MAX_MESSAGE_CHARS) {
      content = content.slice(0, MAX_MESSAGE_CHARS) + "\n[... truncated ...]";
    }

    // Add tool names for assistant messages
    let toolLine = "";
    if (entry.toolNames) {
      toolLine = `\n(Tools used: ${entry.toolNames})`;
    }

    const block = `[${time}] ${speaker}:\n${content}${toolLine}\n`;

    // Check total size limit
    if (totalChars + block.length > MAX_TRANSCRIPT_CHARS) {
      lines.push(`\n[... more messages truncated for length ...]`);
      break;
    }

    lines.push(block);
    totalChars += block.length;
  }

  if (skippedToolMessages > 0) {
    // Add a note about skipped tool messages after the header
    const noteIndex = lines.indexOf("---") + 2;
    lines.splice(
      noteIndex,
      0,
      `(${skippedToolMessages} brief tool-call messages omitted for brevity)\n`,
    );
  }

  return {
    text: lines.join("\n"),
    date: localDateStr,
    timeRange,
    primaryCwd,
    sessionId: conversation.sessionId,
    entryCount: entries.length,
  };
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Detect the most frequently used cwd across entries.
 */
function detectPrimaryCwd(entries: TranscriptEntryRow[]): string | null {
  const cwdCounts = new Map<string, number>();

  for (const entry of entries) {
    if (entry.cwd) {
      cwdCounts.set(entry.cwd, (cwdCounts.get(entry.cwd) || 0) + 1);
    }
  }

  if (cwdCounts.size === 0) return null;

  let maxCwd = "";
  let maxCount = 0;
  for (const [cwd, count] of cwdCounts) {
    if (count > maxCount) {
      maxCwd = cwd;
      maxCount = count;
    }
  }

  return maxCwd;
}

/**
 * Format a date as "Thursday, February 20, 2026" in local timezone.
 */
function formatLocalDate(date: Date, timezone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: timezone,
  }).format(date);
}

/**
 * Format a date as "YYYY-MM-DD" in local timezone.
 */
function formatDateString(date: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    timeZone: timezone,
  }).formatToParts(date);

  const year = parts.find((p) => p.type === "year")?.value;
  const month = parts.find((p) => p.type === "month")?.value;
  const day = parts.find((p) => p.type === "day")?.value;

  return `${year}-${month}-${day}`;
}

/**
 * Format time as "8:00 PM" in local timezone.
 */
function formatTime(date: Date, timezone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZone: timezone,
  }).format(date);
}

/**
 * Get timezone abbreviation (e.g., "EST" or "EDT").
 */
function getTimezoneAbbr(date: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    timeZoneName: "short",
  }).formatToParts(date);

  return parts.find((p) => p.type === "timeZoneName")?.value || "ET";
}
