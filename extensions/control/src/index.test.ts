import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createControlExtension } from "./index";

describe("control extension", () => {
  const logsDir = join(homedir(), ".claudia", "logs");
  const testFiles: string[] = [];

  afterEach(() => {
    for (const file of testFiles) {
      rmSync(join(logsDir, file), { force: true });
    }
    testFiles.length = 0;
  });

  async function startExtension() {
    const ext = createControlExtension();
    await ext.start({
      on: () => () => {},
      emit: () => {},
      async call() {
        throw new Error("Not implemented in test");
      },
      connectionId: null,
      tags: null,
      config: {},
      log: { info: () => {}, warn: () => {}, error: () => {} },
    });
    return ext;
  }

  it("exposes standardized health_check", async () => {
    const ext = await startExtension();
    expect(ext.methods.some((m) => m.name === "control.health_check")).toBe(true);

    const res = (await ext.handleMethod("control.health_check", {})) as {
      ok: boolean;
      status: string;
      label: string;
      metrics?: Array<{ label: string; value: string | number }>;
    };

    expect(res.ok).toBe(true);
    expect(res.status).toBe("healthy");
    expect(res.label).toBe("Control");
    expect(Array.isArray(res.metrics)).toBe(true);
    await ext.stop();
  });

  it("lists log files and tails latest lines with offsets", async () => {
    mkdirSync(logsDir, { recursive: true });
    const name = `control-test-${Date.now()}.log`;
    const file = join(logsDir, name);
    testFiles.push(name);
    writeFileSync(file, "one\ntwo\nthree\n");

    const ext = await startExtension();
    const listed = (await ext.handleMethod("control.log_list", {})) as {
      files: Array<{ name: string; size: number; modified: string }>;
    };
    const entry = listed.files.find((f) => f.name === name);
    expect(entry).toBeDefined();
    expect(entry?.size).toBe(statSync(file).size);

    const tailed = (await ext.handleMethod("control.log_tail", {
      file: name,
      lines: 2,
      offset: 0,
    })) as { lines: string[]; offset: number; fileSize: number };
    expect(tailed.lines).toEqual(["two", "three"]);
    expect(tailed.offset).toBe(tailed.fileSize);

    const noNew = (await ext.handleMethod("control.log_tail", {
      file: name,
      offset: tailed.offset,
    })) as { lines: string[]; offset: number; fileSize: number };
    expect(noNew.lines).toEqual([]);
    expect(noNew.offset).toBe(tailed.fileSize);

    await ext.stop();
  });

  it("rejects invalid/missing log files and unknown methods", async () => {
    const ext = await startExtension();
    await expect(ext.handleMethod("control.log_tail", { file: "../hack.txt" })).rejects.toThrow(
      "Invalid log file name",
    );
    await expect(
      ext.handleMethod("control.log_tail", { file: `missing-${Date.now()}.log` }),
    ).rejects.toThrow("Log file not found:");
    await expect(ext.handleMethod("control.nope", {})).rejects.toThrow(
      "Unknown method: control.nope",
    );
    await ext.stop();
  });
});
