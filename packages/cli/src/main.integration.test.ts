import { describe, expect, it } from "bun:test";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "..", "..", "..");
const cliEntry = join(repoRoot, "packages", "cli", "src", "index.ts");

function runCli(args: string[]) {
  return Bun.spawnSync(["bun", cliEntry, ...args], {
    cwd: repoRoot,
    env: {
      ...process.env,
      CLAUDIA_GATEWAY_URL: "ws://127.0.0.1:1/ws",
      CLAUDIA_WATCHDOG_URL: "http://127.0.0.1:1",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
}

describe("cli main integration", () => {
  it("prints watchdog help and exits successfully", () => {
    const result = runCli(["watchdog", "--help"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString("utf-8")).toContain("watchdog commands:");
  });

  it("fails fast for unknown watchdog command", () => {
    const result = runCli(["watchdog", "bogus"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString("utf-8")).toContain("Unknown watchdog command: bogus");
  });

  it("requires text for speak compat command", () => {
    const result = runCli(["speak"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString("utf-8")).toContain('Usage: claudia speak "text to speak"');
  });

  it("requires service argument for watchdog restart", () => {
    const result = runCli(["watchdog", "restart"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString("utf-8")).toContain(
      "Usage: claudia watchdog restart <gateway|runtime>",
    );
  });
});
