/**
 * Git Status Hook
 *
 * After each turn completes, runs `git status --porcelain` in the workspace
 * and emits a summary of changed files for the UI status bar.
 */

import type { HookDefinition } from "@claudia/shared";

type GitPorcelainCode = "M" | "A" | "D" | "R" | "C" | "U" | "?" | "!" | " ";

type GitFileStatus = "modified" | "added" | "deleted" | "untracked" | "renamed" | "other";

interface GitStatusFile {
  status: string;
  path: string;
}

interface GitStatusPayload {
  branch: string;
  modified: number;
  added: number;
  deleted: number;
  untracked: number;
  total: number;
  files: GitStatusFile[];
}

function classifyPorcelainStatus(x: GitPorcelainCode, y: GitPorcelainCode): GitFileStatus {
  if (x === "?" && y === "?") return "untracked";
  if (x === "R" || y === "R" || x === "C" || y === "C") return "renamed";
  if (x === "A" || y === "A") return "added";
  if (x === "D" || y === "D") return "deleted";
  if (x === "M" || y === "M" || x === "U" || y === "U") return "modified";
  return "other";
}

export default {
  event: ["session.message_stop", "session.history_loaded"],
  description: "Show git file changes after each turn",

  async handler(ctx) {
    const cwd = ctx.workspace?.cwd;
    if (!cwd) return;

    try {
      // Get branch name and porcelain status in parallel
      const [statusProc, branchProc] = [
        Bun.spawn(["git", "status", "--porcelain"], { cwd, stdout: "pipe", stderr: "pipe" }),
        Bun.spawn(["git", "rev-parse", "--abbrev-ref", "HEAD"], {
          cwd,
          stdout: "pipe",
          stderr: "pipe",
        }),
      ];
      const [output, branchOutput] = await Promise.all([
        new Response(statusProc.stdout).text(),
        new Response(branchProc.stdout).text(),
      ]);
      const [statusExitCode, branchExitCode] = await Promise.all([
        statusProc.exited,
        branchProc.exited,
      ]);

      if (statusExitCode !== 0 || branchExitCode !== 0) return; // Not a git repo or error

      const branch = branchOutput.trim();
      const lines = output.trim().split("\n").filter(Boolean);

      const files: GitStatusFile[] = [];
      let modified = 0;
      let added = 0;
      let deleted = 0;
      let untracked = 0;

      for (const line of lines) {
        const rawStatus = line.slice(0, 2);
        const x = (rawStatus[0] ?? " ") as GitPorcelainCode;
        const y = (rawStatus[1] ?? " ") as GitPorcelainCode;
        const status = rawStatus.trim() || rawStatus;
        const path = line.slice(3);

        files.push({ status, path });

        switch (classifyPorcelainStatus(x, y)) {
          case "modified":
          case "renamed":
            modified++;
            break;
          case "added":
            added++;
            break;
          case "deleted":
            deleted++;
            break;
          case "untracked":
            untracked++;
            break;
        }
      }

      const payload: GitStatusPayload = {
        branch,
        modified,
        added,
        deleted,
        untracked,
        total: files.length,
        files,
      };

      ctx.emit("files", payload);
    } catch (error) {
      ctx.log.error("git status failed", error);
    }
  },
} satisfies HookDefinition;
