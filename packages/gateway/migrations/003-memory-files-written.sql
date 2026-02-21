-- Up

-- Track which files Libby wrote for each conversation (JSON array of paths)
-- Used to provide context to subsequent conversation processing
ALTER TABLE memory_conversations ADD COLUMN files_written TEXT;

-- Down
-- SQLite doesn't support DROP COLUMN before 3.35.0, but Bun's SQLite does
ALTER TABLE memory_conversations DROP COLUMN files_written;
