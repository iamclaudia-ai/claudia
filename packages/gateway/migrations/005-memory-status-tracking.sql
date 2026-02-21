-- Up

-- Rename processed_at → status_at (tracks when status last changed)
-- Add metadata column for transcript size, etc.
ALTER TABLE memory_conversations ADD COLUMN status_at TEXT;
ALTER TABLE memory_conversations ADD COLUMN metadata TEXT;

-- Backfill: set status_at from processed_at for archived/skipped conversations
UPDATE memory_conversations SET status_at = processed_at WHERE processed_at IS NOT NULL;

-- Down
ALTER TABLE memory_conversations DROP COLUMN status_at;
ALTER TABLE memory_conversations DROP COLUMN metadata;
