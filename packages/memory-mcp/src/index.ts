#!/usr/bin/env bun
/**
 * Claudia Memory MCP Server
 *
 * Provides memory tools for Claude Code:
 * - memory_remember: Store new memories with consistency tracking
 * - memory_recall: Search memories (semantic search when available)
 * - memory_read: Read specific memory files
 * - memory_list: List memories and sections
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';

import { getSectionRegistry } from './sections.js';
import {
  resolvePath,
  getRelativePath,
  fileExists,
  parseMemoryFile,
  getFileSections,
  listMemoryFiles,
  appendToSection,
  createMemoryFile,
  readMemory,
  getRecentMemories,
  getMemoryRoot,
} from './storage.js';
import type { RememberParams, RecallParams, ReadParams, ListParams, MemoryCategory } from './types.js';
import { syncMemoryFiles } from './sync.js';

// ============================================================================
// Tool Definitions
// ============================================================================

const TOOLS: Tool[] = [
  {
    name: 'memory_remember',
    description: `Store a memory in Claudia's memory system (~/memory).

Use this when you want to remember something important:
- Facts about Michael or other people
- Project notes and technical details
- Milestones and achievements
- Insights and realizations

The tool will suggest consistent section names based on existing sections.`,
    inputSchema: {
      type: 'object',
      properties: {
        content: {
          type: 'string',
          description: 'The content to remember',
        },
        filename: {
          type: 'string',
          description: 'Target file path (e.g., "relationships/michael.md"). If not provided, will be inferred.',
        },
        section: {
          type: 'string',
          description: 'Section title to store under. Will be matched against existing sections for consistency.',
        },
        category: {
          type: 'string',
          enum: ['core', 'relationships', 'milestones', 'projects', 'insights', 'events', 'personas'],
          description: 'Memory category (used when creating new files)',
        },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional tags for the memory',
        },
      },
      required: ['content'],
    },
  },
  {
    name: 'memory_recall',
    description: `Search through Claudia's memories.

Currently uses keyword/section matching. Vector search coming soon.
Use this to find relevant memories before responding to questions about past conversations, preferences, or projects.`,
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search query',
        },
        limit: {
          type: 'number',
          description: 'Maximum results to return (default: 5)',
        },
        category: {
          type: 'string',
          enum: ['core', 'relationships', 'milestones', 'projects', 'insights', 'events', 'personas'],
          description: 'Filter by category',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'memory_read',
    description: `Read a specific memory file or section.

Use this to get the full content of a memory file.`,
    inputSchema: {
      type: 'object',
      properties: {
        filepath: {
          type: 'string',
          description: 'Path to memory file (e.g., "relationships/michael.md")',
        },
        section: {
          type: 'string',
          description: 'Optional: specific section to read',
        },
      },
      required: ['filepath'],
    },
  },
  {
    name: 'memory_list',
    description: `List memory files and their sections.

Use this to explore what memories exist.`,
    inputSchema: {
      type: 'object',
      properties: {
        category: {
          type: 'string',
          enum: ['core', 'relationships', 'milestones', 'projects', 'insights', 'events', 'personas'],
          description: 'Filter by category',
        },
        recent: {
          type: 'number',
          description: 'List N most recently updated memories',
        },
      },
    },
  },
  {
    name: 'memory_sections',
    description: `Get all known section titles for consistency.

Use this before creating a new section to check if a similar one already exists.`,
    inputSchema: {
      type: 'object',
      properties: {
        filepath: {
          type: 'string',
          description: 'Optional: filter sections for a specific file',
        },
      },
    },
  },
  {
    name: 'memory_sync',
    description: `Sync existing ~/memory files into the section registry database.

Run this once to populate the section registry with all existing sections from memory files.
This enables better consistency suggestions when storing new memories.`,
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
];

// ============================================================================
// Tool Handlers
// ============================================================================

async function handleRemember(params: RememberParams): Promise<string> {
  const registry = await getSectionRegistry();
  const { content, filename, section, category, tags } = params;

  // Determine target file
  let targetFile = filename;
  let targetCategory: MemoryCategory = (category as MemoryCategory) || 'insights';

  if (!targetFile) {
    // Default to insights with dated filename
    const today = new Date().toISOString().split('T')[0];
    const slug = content.slice(0, 30).toLowerCase().replace(/[^a-z0-9]+/g, '-');
    targetFile = `insights/${today}-${slug}.md`;
  }

  // Get consistent section title
  let targetSection = section || 'Notes';
  const consistentSection = registry.getConsistentSectionTitle(targetSection);
  if (consistentSection !== targetSection) {
    targetSection = consistentSection;
  }

  // Check if file exists
  const exists = await fileExists(targetFile);

  if (exists) {
    // Append to existing file
    const { isNewSection } = await appendToSection(targetFile, targetSection, content);

    // Update section registry
    registry.registerSection(targetFile, targetSection);

    // Get existing sections for response
    const sections = await getFileSections(targetFile);

    return JSON.stringify({
      success: true,
      filepath: targetFile,
      section: targetSection,
      isNewFile: false,
      isNewSection,
      existingSections: sections,
      message: isNewSection
        ? `Created new section "${targetSection}" in ${targetFile}`
        : `Appended to "${targetSection}" in ${targetFile}`,
    });
  } else {
    // Create new file
    // Extract category from path
    const pathCategory = targetFile.split('/')[0] as MemoryCategory;
    if (['core', 'relationships', 'milestones', 'projects', 'insights', 'events', 'personas'].includes(pathCategory)) {
      targetCategory = pathCategory;
    }

    const title = targetSection; // Use section as title for new files

    await createMemoryFile(targetFile, title, targetSection, content, {
      category: targetCategory,
      tags,
    });

    // Update section registry
    registry.registerSection(targetFile, targetSection);

    return JSON.stringify({
      success: true,
      filepath: targetFile,
      section: targetSection,
      isNewFile: true,
      isNewSection: true,
      message: `Created new memory file: ${targetFile}`,
    });
  }
}

async function handleRecall(params: RecallParams): Promise<string> {
  const { query, limit = 5, category } = params;
  const queryLower = query.toLowerCase();

  // Get files to search
  const files = await listMemoryFiles(category as MemoryCategory | undefined);
  const results: Array<{
    filepath: string;
    section: string;
    content: string;
    score: number;
  }> = [];

  for (const file of files) {
    const parsed = await parseMemoryFile(file);
    if (!parsed) continue;

    // Search in sections
    for (const section of parsed.sections) {
      const contentLower = section.content.toLowerCase();
      const titleLower = section.title.toLowerCase();

      // Simple keyword matching (TODO: vector search)
      let score = 0;
      const queryWords = queryLower.split(/\s+/);

      for (const word of queryWords) {
        if (titleLower.includes(word)) score += 2;
        if (contentLower.includes(word)) score += 1;
      }

      if (score > 0) {
        results.push({
          filepath: file,
          section: section.title,
          content: section.content.slice(0, 500) + (section.content.length > 500 ? '...' : ''),
          score,
        });
      }
    }
  }

  // Sort by score and limit
  results.sort((a, b) => b.score - a.score);
  const topResults = results.slice(0, limit);

  return JSON.stringify({
    query,
    count: topResults.length,
    memories: topResults,
    note: 'Currently using keyword matching. Vector search coming soon.',
  });
}

async function handleRead(params: ReadParams): Promise<string> {
  const { filepath, section } = params;

  const content = await readMemory(filepath, section);

  if (content === null) {
    return JSON.stringify({
      success: false,
      error: section
        ? `Section "${section}" not found in ${filepath}`
        : `File not found: ${filepath}`,
    });
  }

  return JSON.stringify({
    success: true,
    filepath,
    section: section || null,
    content,
  });
}

async function handleList(params: ListParams): Promise<string> {
  const { category, recent } = params;

  if (recent) {
    const memories = await getRecentMemories(recent);
    return JSON.stringify({
      count: memories.length,
      memories: memories.map(m => ({
        filepath: m.filename,
        title: m.frontmatter.title,
        updated_at: m.frontmatter.updated_at,
        sections: m.sections.map(s => s.title),
      })),
    });
  }

  const files = await listMemoryFiles(category as MemoryCategory | undefined);
  const results = [];

  for (const file of files) {
    const parsed = await parseMemoryFile(file);
    if (parsed) {
      results.push({
        filepath: file,
        title: parsed.frontmatter.title,
        updated_at: parsed.frontmatter.updated_at,
        sections: parsed.sections.map(s => s.title),
      });
    }
  }

  return JSON.stringify({
    category: category || 'all',
    count: results.length,
    files: results,
  });
}

async function handleSections(params: { filepath?: string }): Promise<string> {
  const registry = await getSectionRegistry();

  if (params.filepath) {
    const sections = registry.getSectionsForFile(params.filepath);
    return JSON.stringify({
      filepath: params.filepath,
      sections: sections.map(s => s.section_title),
    });
  }

  const allSections = registry.getAllSectionTitles();
  return JSON.stringify({
    count: allSections.length,
    sections: allSections,
    note: 'Use these section names for consistency when storing new memories.',
  });
}

// ============================================================================
// MCP Server
// ============================================================================

async function main() {
  const server = new Server(
    {
      name: 'claudia-memory',
      version: '0.1.0',
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  // List tools
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS,
  }));

  // Handle tool calls
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    try {
      let result: string;

      switch (name) {
        case 'memory_remember':
          result = await handleRemember(args as RememberParams);
          break;
        case 'memory_recall':
          result = await handleRecall(args as RecallParams);
          break;
        case 'memory_read':
          result = await handleRead(args as ReadParams);
          break;
        case 'memory_list':
          result = await handleList(args as ListParams);
          break;
        case 'memory_sections':
          result = await handleSections(args as { filepath?: string });
          break;
        case 'memory_sync':
          result = JSON.stringify(await syncMemoryFiles());
          break;
        default:
          throw new Error(`Unknown tool: ${name}`);
      }

      return {
        content: [{ type: 'text', text: result }],
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: 'text', text: JSON.stringify({ error: message }) }],
        isError: true,
      };
    }
  });

  // Start server
  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.error('Claudia Memory MCP server running');
}

main().catch(console.error);
