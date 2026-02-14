/**
 * Inline logger — no monorepo imports.
 * Writes to console + ~/.claudia/logs/watchdog.log with rotation.
 */

import { existsSync, mkdirSync, appendFileSync, statSync, renameSync } from "node:fs";
import { LOGS_DIR, LOG_FILE, MAX_LOG_SIZE, MAX_LOG_FILES } from "./constants";

function rotateIfNeeded(filePath: string): void {
  try {
    if (!existsSync(filePath)) return;
    const { size } = statSync(filePath);
    if (size < MAX_LOG_SIZE) return;

    for (let i = MAX_LOG_FILES; i >= 1; i--) {
      const from = i === 1 ? filePath : `${filePath}.${i - 1}`;
      const to = `${filePath}.${i}`;
      if (existsSync(from)) {
        if (i === MAX_LOG_FILES) {
          Bun.write(to, ""); // truncate oldest
        }
        renameSync(from, to);
      }
    }
  } catch {
    // Rotation failure shouldn't break the watchdog
  }
}

export function log(level: "INFO" | "WARN" | "ERROR", msg: string): void {
  const tag = "[Watchdog]";
  if (level === "ERROR") console.error(`${tag} ${msg}`);
  else if (level === "WARN") console.warn(`${tag} ${msg}`);
  else console.log(`${tag} ${msg}`);

  try {
    if (!existsSync(LOGS_DIR)) mkdirSync(LOGS_DIR, { recursive: true });
    rotateIfNeeded(LOG_FILE);
    const ts = new Date().toISOString();
    appendFileSync(LOG_FILE, `[${ts}] [${level}] [Watchdog] ${msg}\n`);
  } catch {
    // Never let file logging break the watchdog
  }
}
