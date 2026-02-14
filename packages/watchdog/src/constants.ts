/**
 * Shared constants for the watchdog.
 * All magic numbers, paths, and config values live here.
 */

import { join } from "node:path";
import { homedir } from "node:os";

export const WATCHDOG_PORT = 30085;
export const PROJECT_DIR = join(import.meta.dir, "..", "..", "..");
export const LOGS_DIR = join(homedir(), ".claudia", "logs");
export const LOG_FILE = join(LOGS_DIR, "watchdog.log");
export const MAX_LOG_SIZE = 10 * 1024 * 1024; // 10MB
export const MAX_LOG_FILES = 2;
export const HEALTH_CHECK_INTERVAL = 5000; // 5s
export const HEALTH_HISTORY_SIZE = 60; // 5-minute window at 5s intervals
export const UNHEALTHY_RESTART_THRESHOLD = 6; // 6 consecutive failures = 30s
export const STARTED_AT = Date.now();

// Diagnose & Fix
export const CLAUDE_PATH = join(homedir(), ".local", "bin", "claude");
export const DIAGNOSE_TIMEOUT = 180_000; // 3 minute max
export const DIAGNOSE_COOLDOWN = 10_000; // 10s between runs
export const DIAGNOSE_LOG_DIR = join(LOGS_DIR, "diagnose");

export const JSON_HEADERS = { "Content-Type": "application/json" };
