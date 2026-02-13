/**
 * Claudia Unified Logger
 *
 * Structured logger that writes to both console AND file.
 * Modeled after the voice extension's gold-standard file logging pattern.
 *
 * Features:
 * - Timestamped, leveled log entries
 * - Console output with component prefix
 * - File output with JSON metadata
 * - Simple size-based rotation (configurable, default 10MB, keep 2 old)
 */

import { existsSync, mkdirSync, appendFileSync, statSync, renameSync } from "node:fs";
import { dirname } from "node:path";

export type LogLevel = "INFO" | "WARN" | "ERROR";

export interface LoggerOptions {
  /** Component name shown in log prefix */
  component: string;
  /** Optional file path for persistent logging */
  filePath?: string;
  /** Max file size in bytes before rotation (default: 10MB) */
  maxFileSize?: number;
  /** Number of rotated files to keep (default: 2) */
  maxFiles?: number;
}

const DEFAULT_MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
const DEFAULT_MAX_FILES = 2;

/**
 * Rotate a log file if it exceeds the size limit.
 * Simple scheme: gateway.log → gateway.log.1 → gateway.log.2 (deleted)
 */
function rotateIfNeeded(filePath: string, maxSize: number, maxFiles: number): void {
  try {
    if (!existsSync(filePath)) return;
    const { size } = statSync(filePath);
    if (size < maxSize) return;

    // Shift old files: .2 → delete, .1 → .2, current → .1
    for (let i = maxFiles; i >= 1; i--) {
      const from = i === 1 ? filePath : `${filePath}.${i - 1}`;
      const to = `${filePath}.${i}`;
      if (existsSync(from)) {
        if (i === maxFiles) {
          // Delete the oldest
          Bun.write(to, ""); // truncate
        }
        renameSync(from, to);
      }
    }
  } catch {
    // Rotation failure shouldn't break logging
  }
}

export class Logger {
  private component: string;
  private filePath: string | null;
  private maxFileSize: number;
  private maxFiles: number;

  constructor(options: LoggerOptions) {
    this.component = options.component;
    this.filePath = options.filePath || null;
    this.maxFileSize = options.maxFileSize || DEFAULT_MAX_FILE_SIZE;
    this.maxFiles = options.maxFiles || DEFAULT_MAX_FILES;

    // Ensure log directory exists
    if (this.filePath) {
      const dir = dirname(this.filePath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
    }
  }

  info(msg: string, meta?: unknown): void {
    this.write("INFO", msg, meta);
  }

  warn(msg: string, meta?: unknown): void {
    this.write("WARN", msg, meta);
  }

  error(msg: string, meta?: unknown): void {
    this.write("ERROR", msg, meta);
  }

  private write(level: LogLevel, msg: string, meta?: unknown): void {
    const tag = `[${this.component}]`;

    // Console output (concise, human-friendly)
    switch (level) {
      case "INFO":
        console.log(`${tag} ${msg}`);
        break;
      case "WARN":
        console.warn(`${tag} ${msg}`);
        break;
      case "ERROR":
        console.error(`${tag} ${msg}`);
        break;
    }

    // File output (structured, machine-parseable)
    if (this.filePath) {
      try {
        rotateIfNeeded(this.filePath, this.maxFileSize, this.maxFiles);
        const ts = new Date().toISOString();
        const metaStr = meta
          ? ` ${typeof meta === "object" ? JSON.stringify(meta) : String(meta)}`
          : "";
        appendFileSync(this.filePath, `[${ts}] [${level}] [${this.component}] ${msg}${metaStr}\n`);
      } catch {
        // Never let file logging break the application
      }
    }
  }
}

/**
 * Create a logger instance.
 *
 * @example
 * const log = createLogger("gateway", "~/.claudia/logs/gateway.log");
 * log.info("Server started", { port: 30086 });
 */
export function createLogger(component: string, filePath?: string): Logger {
  return new Logger({ component, filePath });
}
