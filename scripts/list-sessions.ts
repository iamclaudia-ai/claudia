#!/usr/bin/env bun

/**
 * List JSONL Session Files with Timestamps
 *
 * Recursively scans a directory of JSONL session logs, parses each file
 * to find the first and last meaningful timestamps (user/assistant messages only),
 * and outputs a CSV sorted by first timestamp.
 *
 * Usage:
 *   bun scripts/list-sessions.ts                                    # Default: ~/.claude/projects-backup
 *   bun scripts/list-sessions.ts --input ~/.claude/projects          # Custom input dir
 *   bun scripts/list-sessions.ts --output tmp/sessions.csv           # Custom output file
 *   bun scripts/list-sessions.ts --sort last                         # Sort by last timestamp instead
 */

import { readdirSync, readFileSync, writeFileSync, existsSync } from "fs";
import { join, relative } from "path";
import { homedir } from "os";

// --- Types (minimal subset of CC format) ---

interface ContentBlock {
  type: string;
  text?: string;
}

interface CCEntry {
  type: string;
  message?: {
    role: string;
    content: string | ContentBlock[];
  };
  timestamp?: string;
  isMeta?: boolean;
  isSidechain?: boolean;
}

// --- Parsing (same rules as memory/parser.ts) ---

function hasToolResult(content: string | ContentBlock[]): boolean {
  if (typeof content === "string") return false;
  return content.some((block) => block.type === "tool_result");
}

function hasText(content: string | ContentBlock[]): boolean {
  if (typeof content === "string") return content.trim().length > 0;
  return content.some((block) => block.type === "text" && block.text?.trim());
}

function hasToolUse(content: string | ContentBlock[]): boolean {
  if (typeof content === "string") return false;
  return content.some((block) => block.type === "tool_use");
}

/**
 * Check if a parsed entry is one we care about (user or assistant with real content).
 */
function isRelevantEntry(entry: CCEntry): boolean {
  if (entry.type !== "user" && entry.type !== "assistant") return false;
  if (!entry.message) return false;
  if (entry.isMeta || entry.isSidechain) return false;

  if (entry.type === "user" && entry.message.role === "user") {
    if (hasToolResult(entry.message.content)) return false;
    return hasText(entry.message.content);
  }

  if (entry.type === "assistant" && entry.message.role === "assistant") {
    return hasText(entry.message.content) || hasToolUse(entry.message.content);
  }

  return false;
}

// --- Scan logic ---

interface SessionInfo {
  filePath: string;
  relativePath: string;
  firstTimestamp: string;
  lastTimestamp: string;
  messageCount: number;
  userCount: number;
  assistantCount: number;
}

function scanFile(filePath: string, baseDir: string): SessionInfo | null {
  const raw = readFileSync(filePath, "utf-8");
  const lines = raw.split("\n").filter((l) => l.trim());

  const timestamps: string[] = [];
  let userCount = 0;
  let assistantCount = 0;

  for (const line of lines) {
    let parsed: CCEntry;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }

    if (!isRelevantEntry(parsed)) continue;

    if (parsed.timestamp) {
      timestamps.push(parsed.timestamp);
    }

    if (parsed.type === "user") userCount++;
    else if (parsed.type === "assistant") assistantCount++;
  }

  if (timestamps.length === 0) return null;

  // Sort timestamps chronologically
  timestamps.sort();

  return {
    filePath,
    relativePath: relative(baseDir, filePath),
    firstTimestamp: timestamps[0],
    lastTimestamp: timestamps[timestamps.length - 1],
    messageCount: userCount + assistantCount,
    userCount,
    assistantCount,
  };
}

function findJsonlFiles(dirPath: string): string[] {
  const files: string[] = [];
  if (!existsSync(dirPath)) return files;

  const entries = readdirSync(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = join(dirPath, entry.name);
    if (entry.isDirectory()) {
      files.push(...findJsonlFiles(fullPath));
    } else if (entry.name.endsWith(".jsonl")) {
      files.push(fullPath);
    }
  }

  return files;
}

// --- CSV output ---

function escapeCsv(value: string): string {
  if (value.includes(",") || value.includes('"') || value.includes("\n")) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

// --- CLI ---

function main() {
  const args = process.argv.slice(2);

  const inputIdx = args.indexOf("--input");
  const outputIdx = args.indexOf("--output");
  const sortIdx = args.indexOf("--sort");

  const inputDir =
    inputIdx >= 0 ? args[inputIdx + 1] : join(homedir(), ".claude", "projects-backup");
  const outputFile =
    outputIdx >= 0 ? args[outputIdx + 1] : join(process.cwd(), "tmp", "sessions.csv");
  const sortBy = sortIdx >= 0 ? args[sortIdx + 1] : "first";

  console.log(`\n  Session File Scanner`);
  console.log(`  ${"=".repeat(40)}`);
  console.log(`  Input:  ${inputDir}`);
  console.log(`  Output: ${outputFile}`);
  console.log(`  Sort:   ${sortBy} timestamp\n`);

  const jsonlFiles = findJsonlFiles(inputDir);
  console.log(`  Found ${jsonlFiles.length} JSONL files, scanning...\n`);

  const sessions: SessionInfo[] = [];
  let skipped = 0;

  for (let i = 0; i < jsonlFiles.length; i++) {
    const file = jsonlFiles[i];
    // Progress indicator every 50 files
    if ((i + 1) % 50 === 0 || i === jsonlFiles.length - 1) {
      process.stdout.write(`\r  Processing ${i + 1}/${jsonlFiles.length}...`);
    }

    const info = scanFile(file, inputDir);
    if (info) {
      sessions.push(info);
    } else {
      skipped++;
    }
  }

  console.log("\n");

  // Sort
  sessions.sort((a, b) => {
    const aTs = sortBy === "last" ? a.lastTimestamp : a.firstTimestamp;
    const bTs = sortBy === "last" ? b.lastTimestamp : b.firstTimestamp;
    return aTs.localeCompare(bTs);
  });

  // Build CSV
  const header = "first_timestamp,last_timestamp,messages,user,assistant,file_path";
  const rows = sessions.map(
    (s) =>
      `${s.firstTimestamp},${s.lastTimestamp},${s.messageCount},${s.userCount},${s.assistantCount},${escapeCsv(s.relativePath)}`,
  );

  const csv = [header, ...rows].join("\n") + "\n";
  writeFileSync(outputFile, csv);

  // Summary
  console.log(`  ${"=".repeat(40)}`);
  console.log(`  Sessions with messages: ${sessions.length}`);
  console.log(`  Files skipped (no messages): ${skipped}`);
  console.log(`  CSV written to: ${outputFile}`);

  if (sessions.length > 0) {
    console.log(`\n  Earliest: ${sessions[0].firstTimestamp}`);
    console.log(`           ${sessions[0].relativePath}`);
    console.log(`  Latest:  ${sessions[sessions.length - 1].lastTimestamp}`);
    console.log(`           ${sessions[sessions.length - 1].relativePath}`);
  }

  console.log();
}

main();
