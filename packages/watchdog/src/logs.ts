/**
 * Log file API — list and tail log files from ~/.claudia/logs/.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
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

  const content = readFileSync(filePath, "utf-8");
  const newContent = byteOffset > 0 ? content.slice(byteOffset) : content;
  const allLines = newContent.split("\n").filter((l) => l.length > 0);
  const resultLines = byteOffset > 0 ? allLines : allLines.slice(-maxLines);

  return { lines: resultLines, offset: fileSize, fileSize };
}
