import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseSessionFile, parseSessionFilePaginated, parseSessionUsage } from "./parse-session";

function writeSessionFile(lines: string[]): { dir: string; file: string } {
  const dir = mkdtempSync(join(tmpdir(), "claudia-parse-session-"));
  const file = join(dir, "session.jsonl");
  writeFileSync(file, lines.join("\n") + "\n", "utf-8");
  return { dir, file };
}

describe("parse-session", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs) {
      rmSync(dir, { recursive: true, force: true });
    }
    dirs.length = 0;
  });

  it("parses user/assistant messages, compaction boundaries, and tool results", () => {
    const { dir, file } = writeSessionFile([
      JSON.stringify({
        type: "assistant",
        timestamp: "2026-02-22T00:00:00.000Z",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "Starting..." },
            { type: "tool_use", id: "tool-1", name: "ReadFile", input: { path: "README.md" } },
          ],
        },
      }),
      JSON.stringify({
        type: "user",
        timestamp: "2026-02-22T00:00:02.000Z",
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "tool-1", content: "file content" }],
        },
      }),
      JSON.stringify({
        type: "system",
        subtype: "compact_boundary",
        timestamp: "2026-02-22T00:00:03.000Z",
        compact_metadata: { trigger: "manual", pre_tokens: 1234 },
      }),
      JSON.stringify({
        type: "user",
        timestamp: "2026-02-22T00:00:04.000Z",
        message: {
          role: "user",
          content: [{ type: "text", text: "Continue please" }],
        },
      }),
      JSON.stringify({
        type: "assistant",
        timestamp: "2026-02-22T00:00:05.000Z",
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "planning..." },
            { type: "text", text: "Done." },
          ],
        },
      }),
    ]);
    dirs.push(dir);

    const messages = parseSessionFile(file);
    expect(messages).toHaveLength(4);

    expect(messages[0]?.role).toBe("assistant");
    const toolUse = messages[0]?.blocks.find((b) => b.type === "tool_use");
    expect(toolUse).toBeDefined();
    expect(toolUse).toMatchObject({
      type: "tool_use",
      id: "tool-1",
      name: "ReadFile",
      result: { content: "file content" },
    });

    expect(messages[1]).toEqual({
      role: "compaction_boundary",
      blocks: [],
      timestamp: "2026-02-22T00:00:03.000Z",
      compaction: { trigger: "manual", pre_tokens: 1234 },
    });

    expect(messages[2]?.role).toBe("user");
    expect(messages[3]?.role).toBe("assistant");
  });

  it("skips malformed/meta/synthetic-only entries and supports pagination", () => {
    const { dir, file } = writeSessionFile([
      "not-json",
      JSON.stringify({
        type: "assistant",
        isMeta: true,
        message: { role: "assistant", content: [{ type: "text", text: "meta" }] },
      }),
      JSON.stringify({
        type: "user",
        isSynthetic: true,
        message: { role: "user", content: [{ type: "text", text: "synthetic" }] },
      }),
      JSON.stringify({
        type: "user",
        message: { role: "user", content: "first" },
      }),
      JSON.stringify({
        type: "assistant",
        message: { role: "assistant", content: [{ type: "text", text: "second" }] },
      }),
      JSON.stringify({
        type: "user",
        message: { role: "user", content: "third" },
      }),
    ]);
    dirs.push(dir);

    const all = parseSessionFile(file);
    expect(all.map((m) => m.role)).toEqual(["user", "assistant", "user"]);

    const page = parseSessionFilePaginated(file, { limit: 2, offset: 0 });
    expect(page.total).toBe(3);
    expect(page.hasMore).toBe(true);
    expect(page.messages.map((m) => m.role)).toEqual(["assistant", "user"]);
  });

  it("extracts the last assistant usage block", () => {
    const { dir, file } = writeSessionFile([
      JSON.stringify({
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "A" }],
          usage: { input_tokens: 1, output_tokens: 2 },
        },
      }),
      JSON.stringify({
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "B" }],
          usage: {
            input_tokens: 10,
            cache_creation_input_tokens: 3,
            cache_read_input_tokens: 2,
            output_tokens: 20,
          },
        },
      }),
    ]);
    dirs.push(dir);

    expect(parseSessionUsage(file)).toEqual({
      input_tokens: 10,
      cache_creation_input_tokens: 3,
      cache_read_input_tokens: 2,
      output_tokens: 20,
    });
  });
});
