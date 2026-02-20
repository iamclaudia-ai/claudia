#!/usr/bin/env bun

/**
 * Quick test script for memory ingestion pipeline.
 * Imports files directly without needing the gateway running.
 *
 * Usage:
 *   bun scripts/test-ingest.ts <file1> [file2] ...
 *   bun scripts/test-ingest.ts --dir <directory>
 *   bun scripts/test-ingest.ts --dir ~/.claude/projects-backup
 *
 * Base path is auto-detected: if importing from projects-backup,
 * keys are relative to that dir — same keys as ~/.claude/projects.
 */

import { ingestFile, ingestDirectory } from "../extensions/memory/src/ingest";
import { getStats, getDb, closeDb } from "../extensions/memory/src/db";
import { homedir } from "os";

const args = process.argv.slice(2);

if (args.length === 0) {
  console.log("Usage: bun scripts/test-ingest.ts <file1> [file2] ...");
  console.log("       bun scripts/test-ingest.ts --dir <directory>");
  process.exit(1);
}

// Ensure DB works
try {
  getDb();
  console.log("  Database connected ✓\n");
} catch (e) {
  console.error("  Database error:", e);
  process.exit(1);
}

const gapMinutes = 60;

const dirIdx = args.indexOf("--dir");
if (dirIdx >= 0) {
  const dir = args[dirIdx + 1].replace(/^~/, homedir());
  console.log(`  Ingesting directory: ${dir}\n`);
  const result = ingestDirectory(dir, gapMinutes);
  console.log(`  Files processed:        ${result.filesProcessed}`);
  console.log(`  Entries inserted:        ${result.entriesInserted}`);
  console.log(`  Entries deleted:         ${result.entriesDeleted}`);
  console.log(`  Conversations updated:   ${result.conversationsUpdated}`);
  if (result.errors.length > 0) {
    console.log(`  Errors: ${result.errors.length}`);
    for (const err of result.errors.slice(0, 10)) {
      console.log(`    ${err}`);
    }
    if (result.errors.length > 10) console.log(`    ... and ${result.errors.length - 10} more`);
  }
} else {
  for (const filePath of args) {
    const expanded = filePath.replace(/^~/, homedir());
    // Auto-detect base path from common patterns
    const basePath = expanded.includes("projects-backup")
      ? expanded.substring(0, expanded.indexOf("projects-backup") + "projects-backup".length)
      : expanded.includes("projects")
        ? expanded.substring(0, expanded.indexOf("projects") + "projects".length)
        : expanded.substring(0, expanded.lastIndexOf("/"));

    console.log(`  Ingesting: ${expanded}`);
    console.log(`  Base path: ${basePath}`);
    const result = ingestFile(expanded, basePath, gapMinutes);
    console.log(`    Files processed:        ${result.filesProcessed}`);
    console.log(`    Entries inserted:        ${result.entriesInserted}`);
    console.log(`    Entries deleted:         ${result.entriesDeleted}`);
    console.log(`    Conversations updated:   ${result.conversationsUpdated}`);
    if (result.errors.length > 0) {
      for (const err of result.errors) console.log(`    ERROR: ${err}`);
    }
    console.log();
  }
}

// Show overall stats
const stats = getStats();
console.log(`\n  === Database Stats ===`);
console.log(`  Files tracked:    ${stats.fileCount}`);
console.log(`  Total entries:    ${stats.entryCount}`);
console.log(`  Conversations:`);
for (const [status, count] of Object.entries(stats.conversationsByStatus)) {
  console.log(`    ${status}: ${count}`);
}

closeDb();
console.log("\n  Done! ✓\n");
