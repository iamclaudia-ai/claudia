-- Up

-- Add 'queued' status to memory_conversations CHECK constraint.
-- SQLite doesn't support ALTER CONSTRAINT, so we recreate the table.

CREATE TABLE memory_conversations_new (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id          TEXT NOT NULL,
  source_file         TEXT NOT NULL,
  first_message_at    TEXT NOT NULL,
  last_message_at     TEXT NOT NULL,
  entry_count         INTEGER NOT NULL DEFAULT 0,
  status              TEXT NOT NULL DEFAULT 'active'
                      CHECK(status IN ('active','ready','queued','processing','archived','skipped')),
  strategy            TEXT,
  summary             TEXT,
  processed_at        TEXT,
  files_written       TEXT,
  created_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO memory_conversations_new
  SELECT id, session_id, source_file, first_message_at, last_message_at,
         entry_count, status, strategy, summary, processed_at, files_written, created_at
  FROM memory_conversations;

DROP TABLE memory_conversations;

ALTER TABLE memory_conversations_new RENAME TO memory_conversations;

CREATE INDEX IF NOT EXISTS idx_conversations_status ON memory_conversations(status);
CREATE INDEX IF NOT EXISTS idx_conversations_session ON memory_conversations(session_id);
CREATE INDEX IF NOT EXISTS idx_conversations_source ON memory_conversations(source_file);

-- Down

-- Revert: remove 'queued' status (reset any queued back to ready first)
UPDATE memory_conversations SET status = 'ready' WHERE status = 'queued';

CREATE TABLE memory_conversations_old (
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
  files_written       TEXT,
  created_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO memory_conversations_old
  SELECT id, session_id, source_file, first_message_at, last_message_at,
         entry_count, status, strategy, summary, processed_at, files_written, created_at
  FROM memory_conversations;

DROP TABLE memory_conversations;

ALTER TABLE memory_conversations_old RENAME TO memory_conversations;

CREATE INDEX IF NOT EXISTS idx_conversations_status ON memory_conversations(status);
CREATE INDEX IF NOT EXISTS idx_conversations_session ON memory_conversations(session_id);
CREATE INDEX IF NOT EXISTS idx_conversations_source ON memory_conversations(source_file);
