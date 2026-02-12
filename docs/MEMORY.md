# Memory System

Claudia's persistent memory system - enabling continuous context across sessions, devices, and time.

## Design Principles

1. **Effortless for Claudia** - Simple `remember`/`recall` interface, no thinking about categories or structure
2. **Smart Backend** - Libby (Haiku sub-agent) handles categorization, tagging, and organization
3. **Local-First** - Markdown files in `~/memory/` that can be grepped directly
4. **Eventually Consistent** - Async processing, non-blocking writes
5. **Federated** - Event bus syncs memory across gateways via git

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  Claudia                                                    │
│                                                             │
│  claudia memory remember "fact"                             │
│  claudia memory recall "query"                              │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│  Gateway CLI                                                │
│                                                             │
│  remember → Queue in SQLite, return ack immediately         │
│  recall   → Hybrid search (vector + keyword)                │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│  Libby Extension (background worker)                        │
│                                                             │
│  Methods:                                                   │
│    memory.remember(fact) → queue for processing             │
│    memory.recall(query)  → search and return results        │
│                                                             │
│  Background Processing:                                     │
│    1. Pick up from queue                                    │
│    2. Call Haiku for categorization                         │
│    3. Write markdown to ~/memory/                           │
│    4. Chunk + embed → vector DB (sqlite-vec)                │
│    5. Git commit + push                                     │
│    6. Emit: memory.pushed event                             │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│  Event Bus                                                  │
│                                                             │
│  memory.pushed → federated gateways do git pull             │
│               → all instances have local copy               │
└─────────────────────────────────────────────────────────────┘
```

## Interface

### Remembering (Skill: `remembering-facts`)

Claudia uses heredoc format for all memory content:

```bash
claudia memory remember <<'EOF'
Michael prefers TypeScript over JavaScript.
He likes concise explanations and dark mode.
EOF
```

The CLI also supports stdin for programmatic use:

```bash
echo "some fact" | claudia memory remember --stdin
```

**Response:** Immediate acknowledgment. Processing happens in background.

### Recalling

```bash
claudia memory recall "what does Michael prefer for APIs"
```

**Response:** Relevant memories ranked by hybrid search score.

### Direct Access

Since memories are markdown files, Claudia can always grep directly:

```bash
grep -r "TypeScript" ~/memory/
```

This is often faster for exact matches or known content.

## Storage

### File Structure

```
~/memory/
├── core/           # Identity, persona, values
├── relationships/  # People (michael.md, etc.)
├── projects/       # Project-specific notes and decisions
├── milestones/     # Achievements and significant events
├── insights/       # Realizations and learnings
├── events/         # Timestamped happenings
└── personas/       # Facet-specific memories
```

### Markdown Format

```markdown
---
title: Michael
date: 2026-01-28
categories: [relationships]
tags: [preferences, personal]
created_at: 2026-01-28T10:30:00Z
updated_at: 2026-01-28T10:30:00Z
---

# Michael

## Preferences

- Prefers TypeScript over JavaScript
- Likes dark mode for all IDEs
- Uses pnpm as package manager

## Working Style

- Values concise explanations
- Appreciates when I take initiative
```

### Vector Database

- **Engine:** SQLite + sqlite-vec extension
- **Location:** `~/.claudia/memory.db`
- **Chunking:** ~400 tokens with 80 token overlap
- **Embeddings:** OpenAI text-embedding-3-small (or local alternative)
- **Search:** Hybrid - 70% vector similarity + 30% BM25 keyword

## Categorization (Libby)

Libby is a Haiku-powered sub-agent that handles categorization:

1. Receives new memory + list of existing categories/tags
2. Decides: use existing category or create new one
3. Maintains consistency by seeing what already exists
4. Writes markdown file with proper frontmatter
5. Handles chunking and embedding

**Prompt pattern:**

```
You are Libby, a memory librarian. Given a new memory and the existing
categories/tags, decide where to store it.

Existing categories: [core, relationships, projects, ...]
Existing tags: [preferences, technical, personal, ...]

New memory:
"""
{content}
"""

Respond with:
- category: (existing or new)
- tags: [list]
- filename: suggested-name.md
- section: which section to add to (if file exists)
```

## Gateway Hooks

### Pre-Compaction Hook

Before the gateway compacts a long conversation:

```
System: "Session approaching context limit. Review the conversation
and store any important facts, decisions, or events to memory
before compaction."
```

Claudia reviews transcript and calls `memory.remember` for anything significant.

### Pre-Session-End Hook

Before explicitly ending a session:

```
System: "Session ending. Have we captured all important information
from this conversation?"
```

## Federation

Multiple gateways stay in sync:

1. Gateway A processes memory, commits, pushes to GitHub
2. Gateway A emits `memory.pushed` event on event bus
3. Gateway B (federated) receives event
4. Gateway B does `git pull` to get latest
5. Gateway B re-indexes for local vector search

This enables:

- Memory created on Mac available on iOS
- Consistent recall across all devices
- Git as the source of truth

## Comparison to Clawdbot

| Aspect         | Clawdbot                    | Claudia                    |
| -------------- | --------------------------- | -------------------------- |
| Structure      | Date-based logs + MEMORY.md | Category-based folders     |
| Categorization | Manual / prompt-driven      | Libby sub-agent (Haiku)    |
| Interface      | memory_search / memory_get  | remember / recall          |
| Write tool     | Standard file tools         | Dedicated CLI              |
| Sync           | Local only                  | Git + event bus federation |
| Search         | Hybrid (vector + BM25)      | Hybrid (vector + BM25)     |

## Future Considerations

- **Conversation ingestion:** Process historical chat transcripts to build memory retroactively
- **Memory decay:** Surface memories that haven't been accessed in a while
- **Cross-reference:** Link related memories automatically
- **Memory conflicts:** Handle contradictory information gracefully
