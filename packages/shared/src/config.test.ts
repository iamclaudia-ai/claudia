import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  clearConfigCache,
  getEnabledExtensions,
  getExtensionConfig,
  isExtensionEnabled,
  loadConfig,
} from "./config";

describe("config loader", () => {
  let tempDir = "";
  let envBackup: NodeJS.ProcessEnv;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "claudia-config-test-"));
    envBackup = { ...process.env };
    clearConfigCache();
  });

  afterEach(() => {
    process.env = envBackup;
    clearConfigCache();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("loads JSON5 config file and interpolates env vars", () => {
    const configPath = join(tempDir, "claudia.json");
    process.env.TEST_ENDPOINT = "gateway.example.com";
    process.env.TEST_MODEL = "claude-opus";

    writeFileSync(
      configPath,
      `{
        gateway: {
          port: 40001,
          endpoint: "\${TEST_ENDPOINT}",
        },
        session: {
          model: "\${TEST_MODEL}",
          thinking: true,
          effort: "high",
        },
        extensions: {
          hooks: { enabled: true, config: { dir: "/hooks" } },
        },
      }`,
      "utf-8",
    );

    const config = loadConfig(configPath);
    expect(config.gateway.port).toBe(40001);
    expect(config.gateway.endpoint).toBe("gateway.example.com");
    expect(config.gateway.host).toBe("localhost");
    expect(config.session.model).toBe("claude-opus");
    expect(config.session.thinking).toBe(true);
    expect(config.session.effort).toBe("high");
    expect(config.extensions.hooks?.enabled).toBe(true);
  });

  it("falls back to env vars when no config file exists (isolated process)", () => {
    const missingPath = join(tempDir, "missing.json");
    const script = `
      import { loadConfig, clearConfigCache } from ${JSON.stringify(join(import.meta.dir, "config.ts"))};
      clearConfigCache();
      const cfg = loadConfig(${JSON.stringify(missingPath)});
      console.log(JSON.stringify(cfg));
    `;

    const result = Bun.spawnSync(["bun", "-e", script], {
      cwd: tempDir,
      env: {
        ...process.env,
        HOME: tempDir,
        CLAUDIA_CONFIG: "",
        CLAUDIA_PORT: "40123",
        CLAUDIA_HOST: "0.0.0.0",
        CLAUDIA_MODEL: "claude-sonnet",
        CLAUDIA_THINKING: "true",
        CLAUDIA_THINKING_EFFORT: "max",
        CLAUDIA_SYSTEM_PROMPT: "be brief",
        CLAUDIA_EXTENSIONS: "voice,session",
        ELEVENLABS_API_KEY: "secret-key",
        ELEVENLABS_VOICE_ID: "voice-1",
      },
    });
    expect(result.exitCode).toBe(0);
    const output = result.stdout.toString("utf-8").trim().split("\n").at(-1) || "{}";
    const config = JSON.parse(output) as {
      gateway: { port: number; host: string };
      session: {
        model: string;
        thinking: boolean;
        effort: string;
        systemPrompt: string | null;
      };
      extensions: Record<string, { enabled: boolean; config: Record<string, unknown> }>;
    };

    expect(config.gateway).toMatchObject({ port: 40123, host: "0.0.0.0" });
    expect(config.session).toMatchObject({
      model: "claude-sonnet",
      thinking: true,
      effort: "max",
      systemPrompt: "be brief",
    });
    expect(config.extensions.voice).toEqual({
      enabled: true,
      config: { apiKey: "secret-key", voiceId: "voice-1" },
    });
    expect(config.extensions.session).toEqual({ enabled: true, config: {} });
  });

  it("handles missing interpolated env vars and parse errors gracefully", () => {
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    const logSpy = spyOn(console, "log").mockImplementation(() => {});

    const badPath = join(tempDir, "bad.json");
    writeFileSync(badPath, "{ invalid json", "utf-8");

    // Parse error path should fall back to env/default config
    const parsedFallback = loadConfig(badPath);
    expect(parsedFallback.gateway.port).toBe(30086);
    expect(errorSpy).toHaveBeenCalled();

    // Missing env interpolation warning path
    clearConfigCache();
    const goodPath = join(tempDir, "good.json");
    writeFileSync(
      goodPath,
      `{
        gateway: { endpoint: "\${UNSET_ENV}" },
      }`,
      "utf-8",
    );
    const interpolated = loadConfig(goodPath);
    expect(interpolated.gateway.endpoint).toBe("");
    expect(warnSpy).toHaveBeenCalled();

    warnSpy.mockRestore();
    errorSpy.mockRestore();
    logSpy.mockRestore();
  });

  it("caches loadConfig and supports extension helper APIs", () => {
    const configPath = join(tempDir, "claudia.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        extensions: {
          a: { enabled: true, config: { x: 1 } },
          b: { enabled: false, config: { y: 2 } },
        },
      }),
      "utf-8",
    );

    const first = loadConfig(configPath);
    const second = loadConfig();
    expect(second).toBe(first); // cached when no explicit path provided

    expect(getExtensionConfig("a")).toEqual({ enabled: true, config: { x: 1 } });
    expect(getExtensionConfig("missing")).toBeUndefined();
    expect(isExtensionEnabled("a")).toBe(true);
    expect(isExtensionEnabled("b")).toBe(false);
    expect(getEnabledExtensions()).toEqual([["a", { enabled: true, config: { x: 1 } }]]);
  });
});
