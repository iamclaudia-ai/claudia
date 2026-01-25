/**
 * Filesystem operations for ~/memory
 */

import { readdir, readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { join, dirname, basename, relative } from 'node:path';
import { homedir } from 'node:os';
import matter from 'gray-matter';
import type { ParsedMemory, MemoryFrontmatter, MemorySection, MemoryCategory } from './types.js';

const MEMORY_ROOT = join(homedir(), 'memory');

/**
 * Get the memory root path
 */
export function getMemoryRoot(): string {
  return MEMORY_ROOT;
}

/**
 * Resolve a memory path (handles relative paths)
 */
export function resolvePath(filepath: string): string {
  if (filepath.startsWith('~/memory/')) {
    return filepath.replace('~/memory/', MEMORY_ROOT + '/');
  }
  if (filepath.startsWith('/')) {
    return filepath;
  }
  return join(MEMORY_ROOT, filepath);
}

/**
 * Get relative path from memory root
 */
export function getRelativePath(filepath: string): string {
  const resolved = resolvePath(filepath);
  return relative(MEMORY_ROOT, resolved);
}

/**
 * Check if a file exists
 */
export async function fileExists(filepath: string): Promise<boolean> {
  try {
    await stat(resolvePath(filepath));
    return true;
  } catch {
    return false;
  }
}

/**
 * Parse a markdown memory file
 */
export async function parseMemoryFile(filepath: string): Promise<ParsedMemory | null> {
  const resolved = resolvePath(filepath);

  try {
    const raw = await readFile(resolved, 'utf-8');
    const { data, content } = matter(raw);

    const frontmatter = data as MemoryFrontmatter;
    const sections = parseSections(content);

    return {
      filename: getRelativePath(filepath),
      frontmatter,
      content,
      sections,
    };
  } catch (err) {
    console.error(`Failed to parse memory file ${filepath}:`, err);
    return null;
  }
}

/**
 * Parse markdown content into sections
 */
function parseSections(content: string): MemorySection[] {
  const sections: MemorySection[] = [];
  const lines = content.split('\n');

  let currentSection: MemorySection | null = null;
  let buffer: string[] = [];

  for (const line of lines) {
    const h2Match = line.match(/^## (.+)$/);
    const h3Match = line.match(/^### (.+)$/);

    if (h2Match || h3Match) {
      // Save previous section
      if (currentSection) {
        currentSection.content = buffer.join('\n').trim();
        sections.push(currentSection);
      }

      // Start new section
      currentSection = {
        title: h2Match ? h2Match[1] : h3Match![1],
        content: '',
        level: h2Match ? 2 : 3,
      };
      buffer = [];
    } else if (currentSection) {
      buffer.push(line);
    }
  }

  // Save last section
  if (currentSection) {
    currentSection.content = buffer.join('\n').trim();
    sections.push(currentSection);
  }

  return sections;
}

/**
 * Get all section titles from a file
 */
export async function getFileSections(filepath: string): Promise<string[]> {
  const parsed = await parseMemoryFile(filepath);
  if (!parsed) return [];
  return parsed.sections.map(s => s.title);
}

/**
 * List all memory files in a category
 */
export async function listMemoryFiles(category?: MemoryCategory): Promise<string[]> {
  const files: string[] = [];

  async function scan(dir: string): Promise<void> {
    try {
      const entries = await readdir(dir, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = join(dir, entry.name);

        if (entry.isDirectory() && !entry.name.startsWith('.')) {
          await scan(fullPath);
        } else if (entry.isFile() && entry.name.endsWith('.md')) {
          files.push(getRelativePath(fullPath));
        }
      }
    } catch (err) {
      // Directory might not exist
    }
  }

  if (category) {
    await scan(join(MEMORY_ROOT, category));
  } else {
    await scan(MEMORY_ROOT);
  }

  return files;
}

/**
 * Append content to a section in a memory file
 * If section doesn't exist, creates it
 */
export async function appendToSection(
  filepath: string,
  section: string,
  content: string
): Promise<{ isNewSection: boolean }> {
  const resolved = resolvePath(filepath);
  const parsed = await parseMemoryFile(filepath);

  if (!parsed) {
    throw new Error(`File not found: ${filepath}`);
  }

  const raw = await readFile(resolved, 'utf-8');
  const { data: frontmatter, content: body } = matter(raw);

  // Update the updated_at timestamp
  frontmatter.updated_at = new Date().toISOString();

  // Check if section exists
  const sectionIndex = parsed.sections.findIndex(
    s => s.title.toLowerCase() === section.toLowerCase()
  );

  let newBody: string;
  let isNewSection = false;

  if (sectionIndex !== -1) {
    // Append to existing section
    const existingSection = parsed.sections[sectionIndex];
    const sectionHeader = `## ${existingSection.title}`;
    const sectionStart = body.indexOf(sectionHeader);

    if (sectionStart !== -1) {
      // Find the end of this section (next ## or end of file)
      const afterHeader = body.slice(sectionStart + sectionHeader.length);
      const nextSectionMatch = afterHeader.match(/\n## /);
      const sectionEnd = nextSectionMatch
        ? sectionStart + sectionHeader.length + nextSectionMatch.index!
        : body.length;

      // Insert content before the next section
      newBody =
        body.slice(0, sectionEnd).trimEnd() +
        '\n\n' +
        content.trim() +
        '\n' +
        body.slice(sectionEnd);
    } else {
      // Fallback: append to end
      newBody = body.trimEnd() + '\n\n' + content.trim() + '\n';
    }
  } else {
    // Create new section at the end
    isNewSection = true;
    newBody = body.trimEnd() + '\n\n## ' + section + '\n\n' + content.trim() + '\n';
  }

  // Rebuild the file
  const newFile = matter.stringify(newBody, frontmatter);
  await writeFile(resolved, newFile);

  return { isNewSection };
}

/**
 * Create a new memory file
 */
export async function createMemoryFile(
  filepath: string,
  title: string,
  section: string,
  content: string,
  options: {
    category: string;
    tags?: string[];
    summary?: string;
    author?: string;
  }
): Promise<void> {
  const resolved = resolvePath(filepath);
  const now = new Date().toISOString();
  const dateStr = now.split('T')[0];

  // Ensure directory exists
  await mkdir(dirname(resolved), { recursive: true });

  // Build frontmatter, excluding undefined values (gray-matter can't serialize undefined)
  const frontmatter: Record<string, unknown> = {
    title,
    date: dateStr,
    categories: [options.category],
    author: options.author || 'Claudia',
    created_at: now,
    updated_at: now,
  };

  // Only add optional fields if they have values
  if (options.tags && options.tags.length > 0) {
    frontmatter.tags = options.tags;
  }
  if (options.summary) {
    frontmatter.summary = options.summary;
  }

  const body = `## ${section}\n\n${content.trim()}\n`;
  const file = matter.stringify(body, frontmatter);

  await writeFile(resolved, file);
}

/**
 * Read a memory file's content
 */
export async function readMemory(filepath: string, section?: string): Promise<string | null> {
  const parsed = await parseMemoryFile(filepath);
  if (!parsed) return null;

  if (section) {
    const found = parsed.sections.find(
      s => s.title.toLowerCase() === section.toLowerCase()
    );
    return found?.content || null;
  }

  return parsed.content;
}

/**
 * Get recently updated memory files
 */
export async function getRecentMemories(limit: number = 10): Promise<ParsedMemory[]> {
  const files = await listMemoryFiles();
  const memories: ParsedMemory[] = [];

  for (const file of files) {
    const parsed = await parseMemoryFile(file);
    if (parsed) {
      memories.push(parsed);
    }
  }

  // Sort by updated_at descending
  memories.sort((a, b) => {
    const dateA = new Date(a.frontmatter.updated_at || a.frontmatter.date);
    const dateB = new Date(b.frontmatter.updated_at || b.frontmatter.date);
    return dateB.getTime() - dateA.getTime();
  });

  return memories.slice(0, limit);
}
