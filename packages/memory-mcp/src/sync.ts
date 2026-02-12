#!/usr/bin/env bun
/**
 * Sync existing ~/memory files into the section registry database
 *
 * Run manually: bun packages/memory-mcp/src/sync.ts
 * Or via MCP: memory_sync tool
 */

import { listMemoryFiles, parseMemoryFile, getMemoryRoot } from "./storage.js";
import { getSectionRegistry } from "./sections.js";

export interface SyncResult {
  filesScanned: number;
  sectionsFound: number;
  sectionsRegistered: number;
  files: Array<{
    filepath: string;
    sections: string[];
  }>;
}

export async function syncMemoryFiles(): Promise<SyncResult> {
  const registry = await getSectionRegistry();
  const files = await listMemoryFiles();

  let sectionsFound = 0;
  let sectionsRegistered = 0;
  const fileResults: SyncResult["files"] = [];

  for (const filepath of files) {
    const parsed = await parseMemoryFile(filepath);
    if (!parsed) continue;

    const sectionTitles = parsed.sections.map((s) => s.title);
    sectionsFound += sectionTitles.length;

    for (const title of sectionTitles) {
      registry.registerSection(filepath, title);
      sectionsRegistered++;
    }

    fileResults.push({
      filepath,
      sections: sectionTitles,
    });
  }

  return {
    filesScanned: files.length,
    sectionsFound,
    sectionsRegistered,
    files: fileResults,
  };
}

// CLI entry point
if (import.meta.main) {
  console.log(`Syncing memory files from ${getMemoryRoot()}...\n`);

  const result = await syncMemoryFiles();

  console.log(`✅ Sync complete!`);
  console.log(`   Files scanned: ${result.filesScanned}`);
  console.log(`   Sections found: ${result.sectionsFound}`);
  console.log(`   Sections registered: ${result.sectionsRegistered}`);

  // Show unique sections
  const registry = await getSectionRegistry();
  const allSections = registry.getAllSectionTitles();
  console.log(`\n📚 Unique section titles (${allSections.length}):`);
  for (const section of allSections.slice(0, 20)) {
    console.log(`   - ${section}`);
  }
  if (allSections.length > 20) {
    console.log(`   ... and ${allSections.length - 20} more`);
  }
}
