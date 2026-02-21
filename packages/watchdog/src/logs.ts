/**
 * Log file API — list and tail log files from ~/.claudia/logs/.
 *
 * Uses byte-level file reads (Buffer) so that byte offsets from stat.size
 * align correctly with the read position. This prevents the "missing lines"
 * bug that occurs when string.slice(byteOffset) is used on UTF-8 content
 * where byte count ≠ character count.
 */

import {
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
  openSync,
  readSync,
  closeSync,
} from "node:fs";
import { join, basename } from "node:path";
import { LOGS_DIR } from "./constants";

export function listLogFiles(): { name: string; size: number; modified: string }[] {
  try {
    if (!existsSync(LOGS_DIR)) return [];
    return readdirSync(LOGS_DIR)
      .filter((f) => f.endsWith(".log"))
      .map((f) => {
        const stat = statSync(join(LOGS_DIR, f));
        return { name: f, size: stat.size, modified: stat.mtime.toISOString() };
      })
      .sort((a, b) => b.modified.localeCompare(a.modified));
  } catch {
    return [];
  }
}

export function tailLogFile(
  fileName: string,
  maxLines: number,
  byteOffset: number,
): { lines: string[]; offset: number; fileSize: number } {
  const sanitized = basename(fileName);
  if (!sanitized.endsWith(".log")) {
    throw new Error("Invalid log file name");
  }

  const filePath = join(LOGS_DIR, sanitized);
  const stat = statSync(filePath);
  const fileSize = stat.size;

  if (byteOffset >= fileSize) {
    return { lines: [], offset: fileSize, fileSize };
  }

  // Read only the new bytes from the file (byte-accurate slicing)
  const bytesToRead = fileSize - byteOffset;
  const buffer = Buffer.alloc(bytesToRead);
  const fd = openSync(filePath, "r");
  try {
    readSync(fd, buffer, 0, bytesToRead, byteOffset);
  } finally {
    closeSync(fd);
  }

  const newContent = buffer.toString("utf-8");
  const allLines = newContent.split("\n").filter((l) => l.length > 0);

  // On first load (offset=0), only return the last maxLines
  // On subsequent polls, return all new lines
  const resultLines = byteOffset > 0 ? allLines : allLines.slice(-maxLines);

  return { lines: resultLines, offset: fileSize, fileSize };
}
