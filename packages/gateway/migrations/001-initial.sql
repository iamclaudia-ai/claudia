-- Up
CREATE TABLE workspaces (
  id                TEXT PRIMARY KEY,
  name              TEXT NOT NULL,
  cwd               TEXT NOT NULL UNIQUE,
  active_session_id TEXT,
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE sessions (
  id                  TEXT PRIMARY KEY,
  workspace_id        TEXT NOT NULL REFERENCES workspaces(id),
  cc_session_id       TEXT NOT NULL,
  status              TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','archived')),
  title               TEXT,
  summary             TEXT,
  previous_session_id TEXT REFERENCES sessions(id),
  last_activity       TEXT NOT NULL DEFAULT (datetime('now')),
  created_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_sessions_workspace ON sessions(workspace_id);
CREATE INDEX idx_sessions_cc ON sessions(cc_session_id);

-- Down
DROP TABLE IF EXISTS sessions;
DROP TABLE IF EXISTS workspaces;
