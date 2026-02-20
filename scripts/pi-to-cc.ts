#!/usr/bin/env bun

/**
 * Pi-to-Claude-Code JSONL Converter
 *
 * One-shot script to convert Pi (Claudia Code) session logs into Claude Code
 * compatible JSONL format. Only extracts what Libby needs:
 * - User messages (text content)
 * - Assistant messages (text content + tool names, NOT tool results/args)
 * - Session metadata (cwd, timestamps)
 *
 * Skips: streaming events, tool results, thinking entries, compaction,
 * branch summaries, custom entries, labels, session_info
 *
 * Usage:
 *   bun scripts/pi-to-cc.ts                          # Convert all Pi sessions
 *   bun scripts/pi-to-cc.ts --input ~/.pi/agent/sessions/--some-project--
 *   bun scripts/pi-to-cc.ts --output ./tmp/converted  # Custom output dir
 *   bun scripts/pi-to-cc.ts --dry-run                 # Preview without writing
 */

import { readdirSync, readFileSync, mkdirSync, existsSync, writeFileSync, statSync } from "fs";
import { join, basename, dirname, relative } from "path";
import { homedir } from "os";

// --- Pi format types (subset we care about) ---

interface PiSessionHeader {
  type: "session";
  id: string;
  timestamp: string;
  cwd: string;
  systemPrompt?: string;
  model?: string;
}

interface PiTextContent {
  type: "text";
  text: string;
}

interface PiToolCallContent {
  type: "toolCall";
  id: string;
  name: string;
  arguments?: Record<string, unknown>;
}

type PiContentBlock = PiTextContent | PiToolCallContent | { type: string };

interface PiMessageEntry {
  type: "message";
  timestamp: string;
  message: {
    role: "user" | "assistant" | "toolResult";
    content: PiContentBlock[];
    timestamp?: number;
  };
}

interface PiEventEntry {
  type: "event";
  timestamp: string;
  event: unknown;
}

type PiEntry = PiSessionHeader | PiMessageEntry | PiEventEntry | { type: string };

// --- Claude Code format types ---

interface CCUserEntry {
  type: "user";
  message: {
    role: "user";
    content: Array<{ type: "text"; text: string }>;
  };
  timestamp: string;
  cwd: string;
  sessionId: string;
}

interface CCAssistantEntry {
  type: "assistant";
  message: {
    role: "assistant";
    content: Array<{ type: "text"; text: string }>;
  };
  timestamp: string;
  cwd: string;
  sessionId: string;
}

type CCEntry = CCUserEntry | CCAssistantEntry;

// --- Conversion logic ---

function extractTextFromContent(content: PiContentBlock[]): string {
  const parts: string[] = [];
  for (const block of content) {
    if (block.type === "text" && "text" in block) {
      parts.push((block as PiTextContent).text);
    }
  }
  return parts.join("\n\n");
}

function extractToolNames(content: PiContentBlock[]): string[] {
  const names: string[] = [];
  for (const block of content) {
    if (block.type === "toolCall" && "name" in block) {
      names.push((block as PiToolCallContent).name);
    }
  }
  return names;
}

function convertSession(inputPath: string): {
  entries: CCEntry[];
  header: PiSessionHeader | null;
  stats: ConvertStats;
} {
  const raw = readFileSync(inputPath, "utf-8");
  const lines = raw.split("\n").filter((l) => l.trim());

  const entries: CCEntry[] = [];
  let header: PiSessionHeader | null = null;
  const stats: ConvertStats = {
    total: 0,
    user: 0,
    assistant: 0,
    skipped: 0,
    toolNames: new Set(),
  };

  for (const line of lines) {
    stats.total++;
    let parsed: PiEntry;
    try {
      parsed = JSON.parse(line);
    } catch {
      stats.skipped++;
      continue;
    }

    // Session header — extract metadata
    if (parsed.type === "session") {
      header = parsed as PiSessionHeader;
      continue;
    }

    // Skip streaming events entirely
    if (parsed.type === "event") {
      stats.skipped++;
      continue;
    }

    // Skip non-message entry types (compaction, branch_summary, custom, etc.)
    if (parsed.type !== "message") {
      stats.skipped++;
      continue;
    }

    const entry = parsed as PiMessageEntry;
    const role = entry.message?.role;

    // Skip tool results
    if (role === "toolResult") {
      stats.skipped++;
      continue;
    }

    const cwd = header?.cwd || "";
    const sessionId = header?.id || basename(inputPath, ".jsonl");
    const timestamp = entry.timestamp || new Date().toISOString();

    if (role === "user") {
      const text = extractTextFromContent(entry.message.content);
      if (!text.trim()) {
        stats.skipped++;
        continue;
      }

      entries.push({
        type: "user",
        message: {
          role: "user",
          content: [{ type: "text", text }],
        },
        timestamp,
        cwd,
        sessionId,
      });
      stats.user++;
    } else if (role === "assistant") {
      const text = extractTextFromContent(entry.message.content);
      const toolNames = extractToolNames(entry.message.content);

      // Track tool usage for stats
      for (const name of toolNames) stats.toolNames.add(name);

      // Build content: text + tool summary if present
      const contentParts: string[] = [];
      if (text.trim()) contentParts.push(text);
      if (toolNames.length > 0) {
        contentParts.push(`[Used tools: ${toolNames.join(", ")}]`);
      }

      if (contentParts.length === 0) {
        stats.skipped++;
        continue;
      }

      entries.push({
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "text", text: contentParts.join("\n\n") }],
        },
        timestamp,
        cwd,
        sessionId,
      });
      stats.assistant++;
    } else {
      stats.skipped++;
    }
  }

  return { entries, header, stats };
}

interface ConvertStats {
  total: number;
  user: number;
  assistant: number;
  skipped: number;
  toolNames: Set<string>;
}

function findPiSessions(inputDir: string): string[] {
  const files: string[] = [];

  if (!existsSync(inputDir)) {
    console.error(`Input directory not found: ${inputDir}`);
    return files;
  }

  // Pi stores sessions in project subdirectories
  const entries = readdirSync(inputDir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = join(inputDir, entry.name);
    if (entry.isDirectory()) {
      // Recurse into project directories
      const subFiles = readdirSync(fullPath).filter((f) => f.endsWith(".jsonl"));
      for (const f of subFiles) {
        files.push(join(fullPath, f));
      }
    } else if (entry.name.endsWith(".jsonl")) {
      files.push(fullPath);
    }
  }

  return files;
}

function formatProjectName(dirName: string): string {
  // Convert --Users-michael-Projects-beehiiv-swarm-- to beehiiv-swarm
  return dirName
    .replace(/^--/, "")
    .replace(/--$/, "")
    .split("-")
    .slice(-2) // Take last 2 segments as project name
    .join("-");
}

// --- CLI ---

function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const inputIdx = args.indexOf("--input");
  const outputIdx = args.indexOf("--output");

  const defaultPiDir = join(homedir(), ".pi", "agent", "sessions");
  const inputDir = inputIdx >= 0 ? args[inputIdx + 1] : defaultPiDir;
  const outputDir =
    outputIdx >= 0 ? args[outputIdx + 1] : join(process.cwd(), "tmp", "pi-converted");

  console.log(`\n  Pi-to-Claude-Code Converter`);
  console.log(`  ${"=".repeat(40)}`);
  console.log(`  Input:  ${inputDir}`);
  console.log(`  Output: ${outputDir}`);
  console.log(`  Mode:   ${dryRun ? "DRY RUN" : "WRITE"}\n`);

  const sessionFiles = findPiSessions(inputDir);

  if (sessionFiles.length === 0) {
    console.log("  No Pi session files found.\n");
    return;
  }

  console.log(`  Found ${sessionFiles.length} Pi session files\n`);

  let totalUser = 0;
  let totalAssistant = 0;
  let totalSkipped = 0;
  let filesWritten = 0;
  const allToolNames = new Set<string>();

  for (const file of sessionFiles) {
    const relativePath = relative(inputDir, file);
    let projectDir = dirname(relativePath).replace(/^--/, "-").replace(/--$/, "");
    if (!projectDir.startsWith("-")) projectDir = "-" + projectDir;

    const projectName = formatProjectName(projectDir);
    const sessionFile = basename(file);

    const { entries, header, stats } = convertSession(file);

    totalUser += stats.user;
    totalAssistant += stats.assistant;
    totalSkipped += stats.skipped;
    for (const t of stats.toolNames) allToolNames.add(t);

    if (entries.length === 0) {
      console.log(`  [skip] ${projectName}/${sessionFile} — no convertible messages`);
      continue;
    }

    const fileSize = statSync(file).size;
    const fileSizeKB = (fileSize / 1024).toFixed(0);
    console.log(
      `  [convert] ${projectName}/${sessionFile} (${fileSizeKB}KB) — ${stats.user}u/${stats.assistant}a messages`,
    );

    console.log(projectDir);
    if (!dryRun) {
      // Mirror project directory structure
      const outProjectDir = join(outputDir, projectDir);
      mkdirSync(outProjectDir, { recursive: true });

      const outPath = join(outProjectDir, sessionFile);
      const jsonl = entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
      writeFileSync(outPath, jsonl);
      filesWritten++;
    }
  }

  console.log(`\n  ${"=".repeat(40)}`);
  console.log(`  Summary:`);
  console.log(`    Sessions processed: ${sessionFiles.length}`);
  console.log(`    Files written:      ${dryRun ? "(dry run)" : filesWritten}`);
  console.log(`    User messages:      ${totalUser}`);
  console.log(`    Assistant messages:  ${totalAssistant}`);
  console.log(`    Entries skipped:    ${totalSkipped}`);
  if (allToolNames.size > 0) {
    console.log(`    Tools seen:         ${[...allToolNames].sort().join(", ")}`);
  }
  console.log();
}

main();
