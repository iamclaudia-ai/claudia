-- Up

-- Track JSONL files and byte offsets for incremental ingestion
CREATE TABLE memory_file_states (
  file_path             TEXT PRIMARY KEY,
  source                TEXT NOT NULL,
  status                TEXT NOT NULL DEFAULT 'idle' CHECK(status IN ('idle','ingesting')),
  last_modified         INTEGER NOT NULL,
  file_size             INTEGER NOT NULL,
  last_processed_offset INTEGER NOT NULL DEFAULT 0,
  last_entry_timestamp  TEXT,
  created_at            TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at            TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Raw transcript entries extracted from JSONL session logs
CREATE TABLE memory_transcript_entries (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id          TEXT NOT NULL,
  source_file         TEXT NOT NULL,
  role                TEXT NOT NULL CHECK(role IN ('user','assistant')),
  content             TEXT NOT NULL,
  tool_names          TEXT,
  timestamp           TEXT NOT NULL,
  cwd                 TEXT,
  ingested_at         TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_transcript_session ON memory_transcript_entries(session_id);
CREATE INDEX idx_transcript_timestamp ON memory_transcript_entries(timestamp);
CREATE INDEX idx_transcript_source ON memory_transcript_entries(source_file);

-- Conversations: groups of entries separated by time gaps, scoped to source file
CREATE TABLE memory_conversations (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id          TEXT NOT NULL,
  source_file         TEXT NOT NULL,
  first_message_at    TEXT NOT NULL,
  last_message_at     TEXT NOT NULL,
  entry_count         INTEGER NOT NULL DEFAULT 0,
  status              TEXT NOT NULL DEFAULT 'active'
                      CHECK(status IN ('active','ready','processing','archived','skipped')),
  strategy            TEXT,
  summary             TEXT,
  processed_at        TEXT,
  created_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_conversations_status ON memory_conversations(status);
CREATE INDEX idx_conversations_session ON memory_conversations(session_id);
CREATE INDEX idx_conversations_source ON memory_conversations(source_file);

-- Down
DROP TABLE IF EXISTS memory_conversations;
DROP TABLE IF EXISTS memory_transcript_entries;
DROP TABLE IF EXISTS memory_file_states;
