/**
 * Git Status Hook
 *
 * After each turn completes, runs `git status --porcelain` in the workspace
 * and emits a summary of changed files for the UI status bar.
 */

import type { HookDefinition } from "@claudia/shared";

export default {
  event: "session.message_stop",
  description: "Show git file changes after each turn",

  async handler(_payload, ctx) {
    const cwd = ctx.workspace?.cwd;
    if (!cwd) return;

    try {
      const proc = Bun.spawn(["git", "status", "--porcelain"], {
        cwd,
        stdout: "pipe",
        stderr: "pipe",
      });
      const output = await new Response(proc.stdout).text();
      const exitCode = await proc.exited;

      if (exitCode !== 0) return; // Not a git repo or error

      const lines = output.trim().split("\n").filter(Boolean);
      if (lines.length === 0) return; // No changes

      const files: { status: string; path: string }[] = [];
      let modified = 0;
      let added = 0;
      let deleted = 0;
      let untracked = 0;

      for (const line of lines) {
        const status = line.slice(0, 2).trim();
        const path = line.slice(3);

        files.push({ status, path });

        if (status === "M" || status === "MM" || status === "AM") modified++;
        else if (status === "A") added++;
        else if (status === "D") deleted++;
        else if (status === "??") untracked++;
        else if (status === "R") modified++; // renamed counts as modified
      }

      ctx.emit("files", {
        modified,
        added,
        deleted,
        untracked,
        total: files.length,
        files,
      });
    } catch (error) {
      ctx.log.error("git status failed", error);
    }
  },
} satisfies HookDefinition;
