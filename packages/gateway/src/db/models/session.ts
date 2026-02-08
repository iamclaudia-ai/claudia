/**
 * Session database model
 */

import type { Database } from "bun:sqlite";
import type { SessionRecord } from "@claudia/shared";
import { generateSessionId } from "@claudia/shared";

/** Raw row from SQLite (snake_case) */
interface SessionRow {
  id: string;
  workspace_id: string;
  cc_session_id: string;
  status: "active" | "archived";
  title: string | null;
  summary: string | null;
  previous_session_id: string | null;
  last_activity: string;
  created_at: string;
}

/** Convert DB row to API type */
function toSessionRecord(row: SessionRow): SessionRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    ccSessionId: row.cc_session_id,
    status: row.status,
    title: row.title,
    summary: row.summary,
    previousSessionId: row.previous_session_id,
    lastActivity: row.last_activity,
    createdAt: row.created_at,
  };
}

export function listSessions(db: Database, workspaceId: string): SessionRecord[] {
  const rows = db.query(
    "SELECT * FROM sessions WHERE workspace_id = ? ORDER BY id DESC",
  ).all(workspaceId) as SessionRow[];
  return rows.map(toSessionRecord);
}

export function getSession(db: Database, id: string): SessionRecord | null {
  const row = db.query("SELECT * FROM sessions WHERE id = ?").get(id) as SessionRow | null;
  return row ? toSessionRecord(row) : null;
}

export function getSessionByCcId(db: Database, ccSessionId: string): SessionRecord | null {
  const row = db.query(
    "SELECT * FROM sessions WHERE cc_session_id = ?",
  ).get(ccSessionId) as SessionRow | null;
  return row ? toSessionRecord(row) : null;
}

export function createSessionRecord(
  db: Database,
  params: {
    workspaceId: string;
    ccSessionId: string;
    title?: string;
    previousSessionId?: string;
  },
): SessionRecord {
  const id = generateSessionId();
  db.query(
    `INSERT INTO sessions (id, workspace_id, cc_session_id, title, previous_session_id)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(
    id,
    params.workspaceId,
    params.ccSessionId,
    params.title || null,
    params.previousSessionId || null,
  );

  return getSession(db, id)!;
}

export function archiveSession(db: Database, id: string): void {
  db.query(
    "UPDATE sessions SET status = 'archived' WHERE id = ?",
  ).run(id);
}

export function updateSessionActivity(db: Database, id: string): void {
  db.query(
    "UPDATE sessions SET last_activity = datetime('now') WHERE id = ?",
  ).run(id);
}

export function updateSessionTitle(db: Database, id: string, title: string): void {
  db.query(
    "UPDATE sessions SET title = ? WHERE id = ?",
  ).run(title, id);
}
