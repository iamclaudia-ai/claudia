import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import gitStatusHook from "./git-status";

interface HookCtx {
  workspace: { cwd: string } | null;
  emit: (event: string, payload: unknown) => void;
  log: { error: (msg: string, err?: unknown) => void };
}

function run(cmd: string[], cwd: string): void {
  const proc = Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
  if (proc.exitCode !== 0) {
    throw new Error(
      `Command failed: ${cmd.join(" ")}\n${proc.stderr.toString("utf-8") || proc.stdout.toString("utf-8")}`,
    );
  }
}

describe("git-status hook", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
    dirs.length = 0;
  });

  it("emits aggregated git status payload for tracked/untracked changes", async () => {
    const repo = mkdtempSync(join(tmpdir(), "claudia-git-hook-"));
    dirs.push(repo);

    run(["git", "init"], repo);
    run(["git", "config", "user.email", "test@example.com"], repo);
    run(["git", "config", "user.name", "Test User"], repo);

    writeFileSync(join(repo, "keep.txt"), "base\n", "utf-8");
    writeFileSync(join(repo, "delete.txt"), "remove me\n", "utf-8");
    writeFileSync(join(repo, "rename-old.txt"), "rename me\n", "utf-8");
    run(["git", "add", "."], repo);
    run(["git", "commit", "-m", "base"], repo);

    writeFileSync(join(repo, "keep.txt"), "changed\n", "utf-8"); // modified
    run(["git", "rm", "delete.txt"], repo); // deleted
    run(["git", "mv", "rename-old.txt", "rename-new.txt"], repo); // renamed
    writeFileSync(join(repo, "added.txt"), "added\n", "utf-8");
    run(["git", "add", "added.txt"], repo); // added
    writeFileSync(join(repo, "untracked.txt"), "untracked\n", "utf-8"); // untracked

    const emitted: Array<{ event: string; payload: unknown }> = [];
    const ctx: HookCtx = {
      workspace: { cwd: repo },
      emit: (event, payload) => emitted.push({ event, payload }),
      log: { error: () => {} },
    };

    await gitStatusHook.handler(ctx as unknown as Parameters<typeof gitStatusHook.handler>[0]);

    expect(emitted).toHaveLength(1);
    expect(emitted[0]?.event).toBe("files");

    const payload = emitted[0]?.payload as {
      branch: string;
      modified: number;
      added: number;
      deleted: number;
      untracked: number;
      total: number;
      files: Array<{ status: string; path: string }>;
    };

    expect(payload.branch.length > 0).toBe(true);
    expect(payload.modified).toBe(2); // keep.txt + rename
    expect(payload.added).toBe(1);
    expect(payload.deleted).toBe(1);
    expect(payload.untracked).toBe(1);
    expect(payload.total).toBe(5);
    expect(payload.files.some((f) => f.path.includes("keep.txt"))).toBe(true);
    expect(payload.files.some((f) => f.path.includes("rename-old.txt -> rename-new.txt"))).toBe(
      true,
    );
  });

  it("does not emit when workspace is missing or not a git repo", async () => {
    const nonRepo = mkdtempSync(join(tmpdir(), "claudia-git-hook-nonrepo-"));
    dirs.push(nonRepo);

    const emitted: Array<{ event: string; payload: unknown }> = [];
    const logErrors: string[] = [];
    const baseCtx: HookCtx = {
      workspace: { cwd: nonRepo },
      emit: (event, payload) => emitted.push({ event, payload }),
      log: { error: (msg) => logErrors.push(msg) },
    };

    await gitStatusHook.handler({ ...baseCtx, workspace: null } as unknown as Parameters<
      typeof gitStatusHook.handler
    >[0]);
    await gitStatusHook.handler(baseCtx as unknown as Parameters<typeof gitStatusHook.handler>[0]);

    expect(emitted).toHaveLength(0);
    expect(logErrors).toHaveLength(0);
  });

  it("logs errors when git commands cannot be spawned", async () => {
    const missingDir = join(tmpdir(), `claudia-missing-${Date.now()}`);
    const logErrors: Array<{ msg: string; err?: unknown }> = [];
    const ctx: HookCtx = {
      workspace: { cwd: missingDir },
      emit: () => {},
      log: { error: (msg, err) => logErrors.push({ msg, err }) },
    };

    await gitStatusHook.handler(ctx as unknown as Parameters<typeof gitStatusHook.handler>[0]);

    expect(logErrors).toHaveLength(1);
    expect(logErrors[0]?.msg).toBe("git status failed");
  });
});
