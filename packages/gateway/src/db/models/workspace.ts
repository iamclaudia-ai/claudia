/**
 * Workspace database model
 */

import type { Database } from "bun:sqlite";
import type { Workspace } from "@claudia/shared";
import { generateWorkspaceId } from "@claudia/shared";
import { basename } from "node:path";

/** Raw row from SQLite (snake_case) */
interface WorkspaceRow {
  id: string;
  name: string;
  cwd: string;
  active_session_id: string | null;
  created_at: string;
  updated_at: string;
}

/** Convert DB row to API type */
function toWorkspace(row: WorkspaceRow): Workspace {
  return {
    id: row.id,
    name: row.name,
    cwd: row.cwd,
    activeSessionId: row.active_session_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function listWorkspaces(db: Database): Workspace[] {
  const rows = db.query("SELECT * FROM workspaces ORDER BY updated_at DESC").all() as WorkspaceRow[];
  return rows.map(toWorkspace);
}

export function getWorkspace(db: Database, id: string): Workspace | null {
  const row = db.query("SELECT * FROM workspaces WHERE id = ?").get(id) as WorkspaceRow | null;
  return row ? toWorkspace(row) : null;
}

export function getWorkspaceByCwd(db: Database, cwd: string): Workspace | null {
  const row = db.query("SELECT * FROM workspaces WHERE cwd = ?").get(cwd) as WorkspaceRow | null;
  return row ? toWorkspace(row) : null;
}

export function createWorkspace(
  db: Database,
  params: { name: string; cwd: string },
): Workspace {
  const id = generateWorkspaceId();
  db.query(
    "INSERT INTO workspaces (id, name, cwd) VALUES (?, ?, ?)",
  ).run(id, params.name, params.cwd);

  return getWorkspace(db, id)!;
}

export function getOrCreateWorkspace(
  db: Database,
  cwd: string,
  name?: string,
): { workspace: Workspace; created: boolean } {
  const existing = getWorkspaceByCwd(db, cwd);
  if (existing) {
    return { workspace: existing, created: false };
  }

  // Derive name from last path segment if not provided
  const derivedName = name || basename(cwd);
  const workspace = createWorkspace(db, { name: derivedName, cwd });
  return { workspace, created: true };
}

export function setActiveSession(
  db: Database,
  workspaceId: string,
  sessionId: string | null,
): void {
  db.query(
    "UPDATE workspaces SET active_session_id = ?, updated_at = datetime('now') WHERE id = ?",
  ).run(sessionId, workspaceId);
}
