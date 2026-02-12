/**
 * Section consistency tracking with Bun's native SQLite
 *
 * Maintains a registry of sections across memory files to ensure
 * consistent categorization (e.g., always "Development Preferences", not
 * sometimes "Dev Prefs" or "Coding Preferences")
 */

import { Database } from "bun:sqlite";
import { join } from "node:path";
import { homedir } from "node:os";
import { mkdir } from "node:fs/promises";
import type { SectionRecord } from "./types.js";

const DB_PATH = join(homedir(), ".claudia", "memory-sections.db");

export class SectionRegistry {
  private db: Database | null = null;

  async init(): Promise<void> {
    // Ensure directory exists
    await mkdir(join(homedir(), ".claudia"), { recursive: true });

    this.db = new Database(DB_PATH, { create: true });

    // Create tables
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sections (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        file_path TEXT NOT NULL,
        section_title TEXT NOT NULL,
        summary TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(file_path, section_title)
      );

      CREATE INDEX IF NOT EXISTS idx_sections_file ON sections(file_path);
      CREATE INDEX IF NOT EXISTS idx_sections_title ON sections(section_title);
    `);
  }

  /**
   * Get all known section titles (for consistency suggestions)
   */
  getAllSectionTitles(): string[] {
    const stmt = this.db!.prepare(`
      SELECT DISTINCT section_title FROM sections ORDER BY section_title
    `);
    return stmt.all().map((row) => (row as { section_title: string }).section_title);
  }

  /**
   * Get sections for a specific file
   */
  getSectionsForFile(filePath: string): SectionRecord[] {
    const stmt = this.db!.prepare(`
      SELECT * FROM sections WHERE file_path = ? ORDER BY section_title
    `);
    return stmt.all(filePath) as SectionRecord[];
  }

  /**
   * Find similar section titles (for consistency)
   * Uses simple fuzzy matching
   */
  findSimilarSections(query: string, threshold: number = 0.6): string[] {
    const allSections = this.getAllSectionTitles();
    const queryLower = query.toLowerCase();

    return allSections.filter((section) => {
      const sectionLower = section.toLowerCase();

      // Exact match
      if (sectionLower === queryLower) return true;

      // Contains match
      if (sectionLower.includes(queryLower) || queryLower.includes(sectionLower)) {
        return true;
      }

      // Word overlap
      const queryWords = new Set(queryLower.split(/\s+/));
      const sectionWords = sectionLower.split(/\s+/);
      const overlap = sectionWords.filter((w) => queryWords.has(w)).length;
      const similarity = overlap / Math.max(queryWords.size, sectionWords.length);

      return similarity >= threshold;
    });
  }

  /**
   * Register a section (upsert)
   */
  registerSection(filePath: string, sectionTitle: string, summary?: string): void {
    const now = new Date().toISOString();

    const stmt = this.db!.prepare(`
      INSERT INTO sections (file_path, section_title, summary, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(file_path, section_title) DO UPDATE SET
        summary = COALESCE(excluded.summary, summary),
        updated_at = excluded.updated_at
    `);

    stmt.run(filePath, sectionTitle, summary || null, now, now);
  }

  /**
   * Sync sections from a parsed memory file
   */
  syncFromFile(filePath: string, sections: Array<{ title: string }>): void {
    for (const section of sections) {
      this.registerSection(filePath, section.title);
    }
  }

  /**
   * Get the best matching section title for consistency
   * Returns the original if no good match found
   */
  getConsistentSectionTitle(query: string): string {
    const similar = this.findSimilarSections(query);

    if (similar.length === 0) {
      return query;
    }

    // Prefer exact case-insensitive match
    const exact = similar.find((s) => s.toLowerCase() === query.toLowerCase());
    if (exact) return exact;

    // Otherwise return the first (most common) match
    return similar[0];
  }

  close(): void {
    this.db?.close();
  }
}

// Singleton instance
let registryInstance: SectionRegistry | null = null;

export async function getSectionRegistry(): Promise<SectionRegistry> {
  if (!registryInstance) {
    registryInstance = new SectionRegistry();
    await registryInstance.init();
  }
  return registryInstance;
}
