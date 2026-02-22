import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  closeDb,
  createWorkspace,
  getOrCreateWorkspace,
  getWorkspace,
  getWorkspaceByCwd,
  listWorkspaces,
} from "./workspace";

describe("workspace db", () => {
  let dataDir: string;
  let prevDataDir: string | undefined;

  beforeEach(() => {
    prevDataDir = process.env.CLAUDIA_DATA_DIR;
    dataDir = mkdtempSync(join(tmpdir(), "claudia-workspace-db-"));
    process.env.CLAUDIA_DATA_DIR = dataDir;
    closeDb();
  });

  afterEach(() => {
    closeDb();
    if (prevDataDir === undefined) {
      delete process.env.CLAUDIA_DATA_DIR;
    } else {
      process.env.CLAUDIA_DATA_DIR = prevDataDir;
    }
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("creates, fetches, and lists workspaces", () => {
    const created = createWorkspace({ name: "project-a", cwd: "/repo/a" });
    expect(created.id).toMatch(/^ws_/);
    expect(created.name).toBe("project-a");
    expect(created.cwd).toBe("/repo/a");

    const byId = getWorkspace(created.id);
    expect(byId).toEqual(created);

    const byCwd = getWorkspaceByCwd("/repo/a");
    expect(byCwd).toEqual(created);

    const listed = listWorkspaces();
    expect(listed).toHaveLength(1);
    expect(listed[0]).toEqual(created);
  });

  it("getOrCreateWorkspace is idempotent per cwd", () => {
    const first = getOrCreateWorkspace("/repo/b", "project-b");
    expect(first.created).toBe(true);
    expect(first.workspace.name).toBe("project-b");

    const second = getOrCreateWorkspace("/repo/b", "ignored-name");
    expect(second.created).toBe(false);
    expect(second.workspace.id).toBe(first.workspace.id);
    expect(second.workspace.name).toBe("project-b");
  });

  it("derives workspace name from cwd basename when name is omitted", () => {
    const result = getOrCreateWorkspace("/repo/my-folder");
    expect(result.created).toBe(true);
    expect(result.workspace.name).toBe("my-folder");
  });

  it("reopens database after closeDb without data loss", () => {
    const created = createWorkspace({ name: "project-c", cwd: "/repo/c" });
    closeDb();

    const listed = listWorkspaces();
    expect(listed.some((w) => w.id === created.id)).toBe(true);
  });
});
