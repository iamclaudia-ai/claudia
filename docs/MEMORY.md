# Memory System

Claudia's memory system ingests session transcripts from JSONL log files into SQLite, groups them into conversations by detecting time gaps, and provides the foundation for Libby (the Librarian) to process completed conversations into durable memories.

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                    MEMORY EXTENSION LIFECYCLE                     │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  1. STARTUP                                                      │
│     ├─ Crash recovery: rollback any in-progress ingestions       │
│     └─ Startup scan: ingestDirectory(watchPath)                  │
│        For each *.jsonl file, check file_states:                 │
│          • Not found → full import                               │
│          • Same size → skip                                      │
│          • Grew      → incremental from last offset              │
│                                                                  │
│  2. WATCHER                                                      │
│     chokidar on watchPath (ignoreInitial: true)                  │
│     on add/change → queue file for ingestion                     │
│                                                                  │
│  3. POLL TIMER                                                   │
│     Every 30s: mark conversations as "ready" if gap > 60min      │
│                                                                  │
│  4. LIBBY (Phase 2, TBD)                                        │
│     Process "ready" conversations into durable memories          │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

## Configuration

In `~/.claudia/claudia.json`:

```json
{
  "memory": {
    "enabled": true,
    "config": {
      "watchPath": "~/.claude/projects",
      "conversationGapMinutes": 60,
      "pollIntervalMs": 30000,
      "minConversationMessages": 5
    }
  }
}
```

- **watchPath**: Single base directory to monitor. All file keys in the DB are relative to this path.
- **conversationGapMinutes**: Minutes of silence before a conversation is considered "done" (default: 60).
- **pollIntervalMs**: How often to check for conversations that became ready (default: 30000).
- **minConversationMessages**: Minimum messages in a conversation for Libby to process it (default: 5). Conversations with fewer messages are skipped as too short to extract meaningful memories.

## File Keys

All DB references use **relative file keys** — the path relative to whichever root directory the file was imported from. This is critical for deduplication:

```
Import from backup:
  absolute: ~/.claude/projects-backup/-Users-michael-Projects-foo/abc.jsonl
  base:     ~/.claude/projects-backup
  key:      -Users-michael-Projects-foo/abc.jsonl

Watcher picks up live:
  absolute: ~/.claude/projects/-Users-michael-Projects-foo/abc.jsonl
  base:     ~/.claude/projects
  key:      -Users-michael-Projects-foo/abc.jsonl
                                     ↑ SAME KEY — no double import
```

## Ingestion Flow

### File State Machine

Each file tracked in `memory_file_states` has a status:

| Status      | Meaning                                                                    |
| ----------- | -------------------------------------------------------------------------- |
| `idle`      | Normal state. File has been fully processed up to `last_processed_offset`. |
| `ingesting` | Actively being imported. Crash recovery marker.                            |

### Happy Path

```
          file change detected
                 │
                 ▼
    ┌────────────────────────┐
    │  1. Read file_states   │
    │     for this file key  │
    └───────────┬────────────┘
                │
        ┌───────┴────────┐
     NOT FOUND         FOUND
        │                │
        ▼           ┌────┴─────────┐
   offset = 0       │              │
                size == offset   size > offset
                 SKIP (done)    offset = last_processed_offset
                                     │
        │                            │
        └────────────┬───────────────┘
                     ▼
    ┌─────────────────────────────────┐
    │  2. Set status = 'ingesting'    │
    │     Capture file_size as high   │
    │     water mark                  │
    └───────────────┬─────────────────┘
                    ▼
    ┌─────────────────────────────────┐
    │  3. Read bytes from             │
    │     last_processed_offset       │
    │     to captured file_size       │
    │                                 │
    │  Parse JSONL → entries          │
    │  Insert into transcript_entries │
    │  Rebuild conversations for file │
    └───────────────┬─────────────────┘
                    ▼
    ┌─────────────────────────────────┐
    │  4. Update file_states:         │
    │     status = 'idle'             │
    │     last_processed_offset =     │
    │       captured file_size        │
    │     last_entry_timestamp =      │
    │       max timestamp from batch  │
    │                                 │
    │  All in single transaction      │
    └─────────────────────────────────┘
```

### Concurrent Append (file grows during ingestion)

```
  t=0  File is 10KB, we start ingesting
  t=1  We capture file_size = 10KB (high water mark)
  t=2  Claude Code appends, file is now 12KB
  t=3  Watcher fires "change" → file added to queue
  t=4  We finish processing bytes 0→10KB
  t=5  Update: last_processed_offset = 10KB, status = idle
  t=6  Queue picks up next entry for this file
  t=7  file_size (12KB) > last_processed_offset (10KB) → incremental
  t=8  Process bytes 10KB→12KB
       No entries lost, no entries doubled ✓
```

The queue deduplicates — if the same file is changed multiple times while we're processing, it only appears once in the queue. After processing completes, the next queue entry picks up any new bytes.

### Crash Recovery (sad path)

If the extension crashes mid-ingestion, some entries may have been inserted but `file_states` still shows `status = 'ingesting'` with the old `last_processed_offset`.

On startup, before the normal scan:

```
  1. Query: SELECT * FROM memory_file_states WHERE status = 'ingesting'

  2. For each stuck file:
     a. DELETE FROM memory_transcript_entries
        WHERE source_file = ?
          AND timestamp > last_entry_timestamp
        (removes partially-imported entries for THIS FILE only)

     b. Rebuild conversations for this file
        (fixes any conversation groupings that were partially updated)

     c. UPDATE memory_file_states SET status = 'idle' WHERE file_path = ?
        (last_processed_offset stays at its pre-crash value)

  3. Now proceed with normal startup scan
     → file_size > last_processed_offset → incremental import picks up
       exactly where we left off ✓
```

**Why `timestamp > last_entry_timestamp` works:** Claude Code appends to JSONL files chronologically. New bytes = newer timestamps. So any entries with timestamps after the last successfully-committed timestamp must be from the partial import.

**If rollback itself fails:** Log the error and skip the file. Memory can lag — the JSONL transcripts are always the source of truth. Michael can investigate and manually re-import.

## Queue-Based Processing

All file changes (startup scan, watcher events) feed into a single processing queue:

```
  ┌──────────┐     ┌──────────┐     ┌──────────┐
  │ Startup  │     │ Watcher  │     │ Manual   │
  │ Scan     │     │ Events   │     │ Import   │
  └────┬─────┘     └────┬─────┘     └────┬─────┘
       │                │                 │
       └────────────────┼─────────────────┘
                        ▼
               ┌─────────────────┐
               │  File Queue     │  (deduplicated by file key)
               │                 │
               │  - foo/abc.jsonl│
               │  - bar/def.jsonl│
               └────────┬────────┘
                        │
                        ▼
               ┌─────────────────┐
               │  Worker Loop    │  (sequential, one at a time)
               │                 │
               │  1. Dequeue     │
               │  2. Ingest      │
               │  3. Next...     │
               └─────────────────┘
```

- Files are deduplicated in the queue (same key → only one entry)
- Worker processes one file at a time (serialized writes to SQLite)
- After processing, check queue for more work

## Database Schema

### `memory_file_states`

Tracks JSONL files and their ingestion state.

| Column                  | Type    | Description                                     |
| ----------------------- | ------- | ----------------------------------------------- |
| `file_path`             | TEXT PK | Relative file key (e.g. `-Users-foo/abc.jsonl`) |
| `source`                | TEXT    | `claude-code` or `pi-converted`                 |
| `status`                | TEXT    | `idle` or `ingesting`                           |
| `last_modified`         | INTEGER | File mtime in ms                                |
| `file_size`             | INTEGER | File size at start of current/last ingestion    |
| `last_processed_offset` | INTEGER | Byte offset successfully processed up to        |
| `last_entry_timestamp`  | TEXT    | ISO8601 timestamp of last committed entry       |

### `memory_transcript_entries`

Raw parsed messages from session logs.

| Column        | Type       | Description                                 |
| ------------- | ---------- | ------------------------------------------- |
| `id`          | INTEGER PK | Auto-increment                              |
| `session_id`  | TEXT       | Session UUID (from filename)                |
| `source_file` | TEXT       | Relative file key                           |
| `role`        | TEXT       | `user` or `assistant`                       |
| `content`     | TEXT       | Message text (+ tool summary for assistant) |
| `tool_names`  | TEXT       | Comma-separated tool names (assistant only) |
| `timestamp`   | TEXT       | ISO8601 from the JSONL entry                |
| `cwd`         | TEXT       | Working directory                           |

### `memory_conversations`

Conversations grouped by time gaps, scoped to source file.

| Column             | Type       | Description                                                |
| ------------------ | ---------- | ---------------------------------------------------------- |
| `id`               | INTEGER PK | Auto-increment                                             |
| `session_id`       | TEXT       | Session UUID                                               |
| `source_file`      | TEXT       | Relative file key                                          |
| `first_message_at` | TEXT       | Timestamp of first message                                 |
| `last_message_at`  | TEXT       | Timestamp of last message (= processing watermark)         |
| `entry_count`      | INTEGER    | Number of messages in conversation                         |
| `status`           | TEXT       | `active` → `ready` → `processing` → `archived` / `skipped` |

**Conversations are scoped to source file:**

- Same session UUID, different files = different conversations (parallel sessions)
- Re-import file = delete conversations for that file, rebuild
- Delete file = delete its conversations. Clean.

**Status lifecycle:**

```
  active ──────► ready ──────► processing ──────► archived
  (still          (gap           (Libby            (done)
   being          detected,      working)
   written)       waiting)                    ──► skipped
                                                  (too short /
                                                   irrelevant)
```

## Parsing Rules

From `parser.ts` — what we extract from Claude Code JSONL:

| Entry type                               | Role      | Action                             |
| ---------------------------------------- | --------- | ---------------------------------- |
| `type: "user"`, `role: "user"`           | user      | Extract text content               |
| `type: "assistant"`, `role: "assistant"` | assistant | Extract text + tool names          |
| `isMeta: true`                           | —         | **Skip** (command caveats)         |
| `isSidechain: true`                      | —         | **Skip** (sub-agent conversations) |
| `tool_result` content blocks             | —         | **Skip** (tool output)             |
| Everything else                          | —         | **Skip** (system, snapshots, etc.) |

## CLI Commands

```bash
# Manual import — single file
claudia memory.ingest --file ~/.claude/projects-backup/-Users-foo/abc.jsonl

# Manual import — entire directory (recursive)
claudia memory.ingest --dir ~/.claude/projects-backup

# Force re-import (delete existing entries, re-ingest from scratch)
claudia memory.ingest --dir ~/.claude/projects-backup --reimport

# Check system stats
claudia memory.health-check

# List conversations
claudia memory.conversations
claudia memory.conversations --status ready

# Trigger Libby processing (Phase 2)
claudia memory.process
```

## Historical Import Workflow

One-time import of backed-up sessions:

```bash
# 1. Convert Pi sessions to CC format (if needed)
bun scripts/pi-to-cc.ts

# 2. Import everything from backup
bun scripts/test-ingest.ts --dir ~/.claude/projects-backup

# 3. Verify
claudia memory.health-check

# 4. Enable extension in claudia.json
#    On next startup, scan of ~/.claude/projects picks up any
#    files not already imported (same keys → skip if unchanged)
```

## Extension Files

```
extensions/memory/
├── src/
│   ├── index.ts           # Extension entry (startup, methods, lifecycle)
│   ├── watcher.ts         # Chokidar file watcher (real-time monitoring)
│   ├── ingest.ts          # Core ingestion logic (file key computation, incremental)
│   ├── parser.ts          # Claude Code JSONL parser
│   ├── db.ts              # SQLite access layer (own connection, WAL mode)
│   └── conversation.ts    # Gap detection + conversation grouping
├── package.json
packages/gateway/
└── migrations/
    └── 002-memory.sql     # Schema (file_states, entries, conversations)
```

## Phase 2: Libby — Conversation Processing

Libby (the Librarian) processes `queued` conversations through a background worker. Each conversation is formatted into a human-readable transcript, sent to Claude for structured extraction, and the results are written to `~/memory/` as categorized markdown files.

### Processing Pipeline

```
memory_conversations (status = 'queued')
        │
        ▼
┌─────────────────────┐
│ transcript-formatter │  UTC → local time (EST)
│ Format entries into  │  Readable chat transcript
│ human-readable text  │  with [HH:MM PM] timestamps
└──────────┬──────────┘
           ▼
┌─────────────────────┐
│ libby.ts (worker)   │  Gateway WebSocket → Claude
│ Send transcript +   │  Returns structured JSON:
│ system prompt       │  episodic, projects, people,
│                     │  milestones, explicit, questions
└──────────┬──────────┘
           ▼
┌─────────────────────┐
│ memory-writer.ts    │  Write/update ~/memory/ files
│ Categorized output  │  with YAML frontmatter
└──────────┬──────────┘
           ▼
memory_conversations.status = 'archived'
```

### Memory Categories

| Category      | Path                                | Description                                                           |
| ------------- | ----------------------------------- | --------------------------------------------------------------------- |
| Episodes      | `episodes/YYYY-MM/YYYY-MM-DD.md`    | Daily journal — one section per conversation, chronologically ordered |
| Projects      | `projects/<name>/overview.md`       | Project tracking with activity log                                    |
| Relationships | `relationships/<name>/overview.md`  | People mentioned — facts, context, relationship                       |
| Milestones    | `milestones/YYYY-MM/<date-slug>.md` | Rare significant moments                                              |
| Insights      | `insights/<date-slug>.md`           | Genuine learnings                                                     |
| Core          | `core/facts.md`                     | Durable facts and preferences                                         |
| Questions     | `libby-questions.md`                | Uncertainties Libby can't resolve                                     |

### Queue-Based Worker

- `memory.process` marks conversations as `queued` (survives crashes)
- Background `LibbyWorker` processes one at a time: `queued → processing → archived`
- Worker sleeps when idle, wakes via `AbortController` when new items are queued
- Session reuse across sequential processing, auto-cycles every ~15 prompts
- On crash: `processing` conversations reset to `queued` on startup

### Memory Types and Mutability

See [Research Background](#research-background) for the theoretical foundation. Our memory types map to the academic taxonomy:

| Our Category  | Memory Type     | Mutability                    | Strategy                                                      |
| ------------- | --------------- | ----------------------------- | ------------------------------------------------------------- |
| Episodes      | Episodic        | Append-only                   | One section per conversation, chronologically inserted        |
| Projects      | Fact + Episodic | Append activity, update facts | Activity log appended; tech details/overview updated in-place |
| Relationships | Fact            | **Mutable — read + rewrite**  | Libby reads existing file, updates facts, consolidates notes  |
| Milestones    | Episodic        | Immutable                     | One file per milestone, never overwritten                     |
| Core/Insights | Fact            | Mutable                       | Updated as understanding evolves                              |

## Research Background

Research and industry practice on memory systems for AI agents. These inform our design decisions for how Libby processes, stores, and evolves memories.

### Three-Tier Memory Model

Both academic literature and production systems converge on a three-tier model:

| Tier           | Scope                        | Content                                           | Retention               |
| -------------- | ---------------------------- | ------------------------------------------------- | ----------------------- |
| **Scratchpad** | Temporary, task-bounded      | Working notes, intermediate reasoning             | Discarded or promoted   |
| **Episodic**   | Medium-term, session-bounded | Session summaries, "what happened"                | Append-only, may decay  |
| **Fact**       | Long-term, fine-grained      | Atomic factual statements, preferences, decisions | Persistent, **mutable** |

Key insight: **Fact memory should be updated, not just appended to.** A person's role changing from "coworker" to "manager" should replace the old fact, not sit alongside it. This is the fundamental difference from episodic memory.

> "MEMORY.md conflates atomic facts like 'user prefers dark mode' with episodic context like what happened in last week's project. Separating them gives each tier its own retention policy and promotion path."
> — [@koylanai](https://x.com/koylanai/status/2023405681080938932) on OpenClaw memory

### Fact Memory: Mutable and Consolidated

From the academic paper "Everything is Context: Agentic File System Abstraction for Context Engineering" (Xu et al., Dec 2025, arXiv:2512.05470):

- Fact memory stores **"atomic factual statements"** as **"key-value pairs or triples"**
- Long-term memory entries **"may be appended, revised, or summarized"** — explicitly supports revision
- Memory deduplication and consolidation strategies maintain **"minimal redundancy"**
- Each update should be **versioned with timestamps and lineage metadata** for reversibility
- The Context Evaluator writes verified information back as structured memory, updating or extending the persistent store

**Taxonomy of Memory Types** (from Table I in the paper):

| Memory Type | Temporal Scope               | Structural Unit                   | Representation             |
| ----------- | ---------------------------- | --------------------------------- | -------------------------- |
| Scratchpad  | Temporary, task-bounded      | Dialogue turns, temporary states  | Plain text or embeddings   |
| Episodic    | Medium-term, session-bounded | Session summaries, case histories | Summaries in plain text    |
| Fact        | Long-term, fine-grained      | Atomic factual statements         | Key-value pairs or triples |
| User        | Long-term, personalized      | User attributes, preferences      | User profiles              |
| Procedural  | Long-term, system-wide       | Functions, tools, definitions     | API or code references     |
| Historical  | Immutable, full-trace        | Raw logs of all interactions      | Plain text with metadata   |

### Promotion and Lifecycle

Memory has a promotion path: scratchpad → episodic → fact.

- **Scratchpad notes** (in-conversation observations) graduate to **episodic summaries** (what happened in this session)
- **Episodic summaries** over time harden into **durable facts** (this person is Michael's coworker, this project uses Bun)
- Each transition should be a logged, versioned event
- Not everything promotes — most episodic entries stay episodic

### Context Rot and Temporal Decay

From Chroma Research ("Context Rot: How Long-Term AI Memory Goes Stale"):

- Memory that was true can become false over time (role changes, preferences shift, tech stack evolves)
- Temporal decay in search: recent memories should rank higher (OpenClaw uses exponential decay with 30-day half-life)
- **Evergreen files** (durable facts, reference docs) should never be decayed — only dated entries
- MMR (Maximal Marginal Relevance) re-ranking reduces near-duplicate results in search

### Implications for Claudia's Memory

1. **Relationship files are fact memory** — they should be living documents that Libby reads and updates directly, not append-only logs. When Libby learns someone's role changed, the file should reflect the current state with a revision history, not a growing list of dated observations.

2. **Episode files are episodic memory** — append-only (with chronological ordering), one section per conversation. These are the "what happened" log and don't need consolidation.

3. **Project files are hybrid** — the activity log is episodic (append-only), but the overview/tech details section is fact memory that should be updated in-place.

4. **Transcripts are the immutable historical record** — the raw JSONL session logs are never modified. Everything Libby writes to `~/memory/` is derived and can be regenerated.

5. **Future: vector search + temporal decay** — the memory-mcp already plans semantic search. Temporal decay and MMR would improve retrieval quality as the memory corpus grows.

### Sources

- [@koylanai on X](https://x.com/koylanai/status/2023405681080938932) — "The problem is how memory gets into the context window" (Feb 2026)
- [Xu et al., "Everything is Context: Agentic File System Abstraction for Context Engineering"](https://arxiv.org/abs/2512.05470) (Dec 2025)
- [OpenClaw memory docs](https://github.com/openclaw/openclaw) — Production memory system with hybrid search, temporal decay, MMR
- [Chroma Research, "Context Rot"](https://research.trychroma.com/context-rot) — How long-term AI memory goes stale

## Design Decisions

- **SQLite (not filesystem):** Queryable, transactional, handles concurrent access via WAL mode
- **Same DB as gateway:** `~/.claudia/claudia.db` — WAL + `busy_timeout = 5000ms` handles out-of-process contention
- **Relative file keys:** Deduplicates across `projects/` and `projects-backup/`
- **Conversations scoped to files:** No cross-file merging, clean cleanup on re-import
- **Timestamp watermarks:** Stable across re-imports (unlike autoincrement IDs)
- **Gap-based triggers:** Configurable silence threshold — Libby sees complete narrative arcs
- **Transcripts are source of truth:** Memory can lag, JSONL files are always the canonical data
