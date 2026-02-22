import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHooksExtension } from "./index";
import type { ExtensionContext, GatewayEvent } from "@claudia/shared";

type EventHandler = (event: GatewayEvent) => void | Promise<void>;

function matchesPattern(eventType: string, pattern: string): boolean {
  if (pattern === "*") return true;
  if (pattern === eventType) return true;
  if (pattern.endsWith(".*")) {
    const prefix = pattern.slice(0, -2);
    return eventType.startsWith(`${prefix}.`);
  }
  return false;
}

function createMockContext() {
  const handlersByPattern = new Map<string, Set<EventHandler>>();
  const emitted: Array<{ type: string; payload: unknown }> = [];

  const ctx: ExtensionContext = {
    on(pattern, handler) {
      if (!handlersByPattern.has(pattern)) {
        handlersByPattern.set(pattern, new Set());
      }
      handlersByPattern.get(pattern)!.add(handler);
      return () => {
        handlersByPattern.get(pattern)?.delete(handler);
      };
    },
    emit(type, payload) {
      emitted.push({ type, payload });
    },
    async call() {
      throw new Error("Not implemented in test");
    },
    connectionId: null,
    tags: null,
    config: {},
    log: {
      info() {},
      warn() {},
      error() {},
    },
  };

  async function dispatch(event: GatewayEvent): Promise<void> {
    const handlers: EventHandler[] = [];
    for (const [pattern, set] of handlersByPattern) {
      if (matchesPattern(event.type, pattern)) {
        handlers.push(...set);
      }
    }
    await Promise.all(handlers.map((handler) => handler(event)));
  }

  return {
    ctx,
    emitted,
    dispatch,
  };
}

async function flushAsync(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function writeHookFile(dir: string, filename: string, source: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, filename), source, "utf8");
}

describe("hooks extension", () => {
  const originalCwd = process.cwd();
  let testRoot = "";

  beforeEach(async () => {
    testRoot = await mkdtemp(join(tmpdir(), "claudia-hooks-test-"));
    process.chdir(testRoot);
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    await rm(testRoot, { recursive: true, force: true });
  });

  it("runs a hook once when both exact and wildcard patterns match", async () => {
    const hooksDir = join(testRoot, "extra-a");
    await writeHookFile(
      hooksDir,
      "overlap.js",
      `let calls = 0;
export default {
  event: ["custom.*", "custom.ping"],
  async handler(ctx) {
    calls += 1;
    ctx.emit("count", { calls });
  },
};
`,
    );

    const extension = createHooksExtension({ extraDirs: [hooksDir] });
    const mock = createMockContext();
    await extension.start(mock.ctx);

    await mock.dispatch({
      type: "custom.ping",
      payload: {},
      timestamp: Date.now(),
      origin: "test",
    });
    await flushAsync();

    const overlapEvents = mock.emitted.filter((e) => e.type === "hook.overlap.count");
    expect(overlapEvents).toHaveLength(1);
    expect(overlapEvents[0]?.payload).toEqual({ calls: 1 });

    await extension.stop();
  });

  it("normalizes events as exact first, wildcard last", async () => {
    const hooksDir = join(testRoot, "extra-order");
    await writeHookFile(
      hooksDir,
      "order.js",
      `export default {
  event: ["*", "session.*", "session.message_stop", "session.*"],
  handler() {},
};
`,
    );

    const extension = createHooksExtension({ extraDirs: [hooksDir] });
    const mock = createMockContext();
    await extension.start(mock.ctx);

    const listed = (await extension.handleMethod("hooks.list", {})) as {
      hooks: Array<{ id: string; events: string[] }>;
    };
    const orderHook = listed.hooks.find((h) => h.id === "order");
    expect(orderHook?.events).toEqual(["session.message_stop", "session.*", "*"]);

    await extension.stop();
  });

  it("loads workspace hooks from <workspace>/.claudia/hooks only", async () => {
    const workspaceA = join(testRoot, "workspace-a");
    await mkdir(join(workspaceA, ".claudia", "hooks"), { recursive: true });
    await writeHookFile(
      join(workspaceA, ".claudia", "hooks"),
      "local.js",
      `export default {
  event: "custom.local",
  handler(ctx) {
    ctx.emit("loaded", { scope: "workspace" });
  },
};
`,
    );

    // Should be ignored entirely now that we only load workspace/.claudia/hooks.
    await writeHookFile(
      join(testRoot, "hooks"),
      "legacy.js",
      `export default {
  event: "custom.local",
  handler(ctx) {
    ctx.emit("loaded", { scope: "legacy-root-hooks" });
  },
};
`,
    );

    const extension = createHooksExtension();
    const mock = createMockContext();
    await extension.start(mock.ctx);

    await mock.dispatch({
      type: "custom.local",
      payload: { cwd: workspaceA },
      timestamp: Date.now(),
      origin: "test",
    });
    await flushAsync();

    const localEvents = mock.emitted.filter((e) => e.type === "hook.local.loaded");
    expect(localEvents).toHaveLength(1);
    expect(localEvents[0]?.payload).toEqual({ scope: "workspace" });

    const legacyEvents = mock.emitted.filter((e) => e.type === "hook.legacy.loaded");
    expect(legacyEvents).toHaveLength(0);

    await extension.stop();
  });

  it("supports symlinked workspace hook directories", async () => {
    const workspace = join(testRoot, "workspace-symlink");
    const realHooksDir = join(testRoot, "shared-hooks");

    await mkdir(workspace, { recursive: true });
    await writeHookFile(
      realHooksDir,
      "linked.js",
      `export default {
  event: "custom.linked",
  handler(ctx) {
    ctx.emit("ok", { via: "symlink" });
  },
};
`,
    );

    await mkdir(join(workspace, ".claudia"), { recursive: true });
    await symlink(realHooksDir, join(workspace, ".claudia", "hooks"));

    const extension = createHooksExtension();
    const mock = createMockContext();
    await extension.start(mock.ctx);

    await mock.dispatch({
      type: "custom.linked",
      payload: { cwd: workspace },
      timestamp: Date.now(),
      origin: "test",
    });
    await flushAsync();

    const events = mock.emitted.filter((e) => e.type === "hook.linked.ok");
    expect(events).toHaveLength(1);
    expect(events[0]?.payload).toEqual({ via: "symlink" });

    await extension.stop();
  });

  it("uses latest matching workspace cwd and sessionId in HookContext", async () => {
    const workspaceB = join(testRoot, "workspace-b");
    await writeHookFile(
      join(workspaceB, ".claudia", "hooks"),
      "context.js",
      `export default {
  event: "custom.workspace",
  handler(ctx) {
    ctx.emit("snapshot", {
      cwd: ctx.workspace ? ctx.workspace.cwd : null,
      sessionId: ctx.sessionId,
    });
  },
};
`,
    );

    const extension = createHooksExtension();
    const mock = createMockContext();
    await extension.start(mock.ctx);

    await mock.dispatch({
      type: "custom.workspace",
      payload: { workspace: { cwd: workspaceB } },
      timestamp: Date.now(),
      origin: "test",
      sessionId: "ses_123",
    });
    await flushAsync();

    const events = mock.emitted.filter((e) => e.type === "hook.context.snapshot");
    expect(events).toHaveLength(1);
    expect(events[0]?.payload).toEqual({ cwd: workspaceB, sessionId: "ses_123" });

    await extension.stop();
  });

  it("skips invalid hooks that miss handler or event", async () => {
    const hooksDir = join(testRoot, "extra-invalid");
    await writeHookFile(
      hooksDir,
      "invalid.js",
      `export default {
  event: "custom.invalid"
};
`,
    );

    const extension = createHooksExtension({ extraDirs: [hooksDir] });
    const mock = createMockContext();
    await extension.start(mock.ctx);

    const listed = (await extension.handleMethod("hooks.list", {})) as {
      hooks: Array<{ id: string }>;
    };
    expect(listed.hooks.some((h) => h.id === "invalid")).toBe(false);

    await mock.dispatch({
      type: "custom.invalid",
      payload: {},
      timestamp: Date.now(),
      origin: "test",
    });
    await flushAsync();

    expect(mock.emitted).toHaveLength(0);

    await extension.stop();
  });

  it("allows workspace hooks to override global hooks with the same id", async () => {
    const globalDir = join(testRoot, "extra-global");
    const workspace = join(testRoot, "workspace-override");

    await writeHookFile(
      globalDir,
      "shadow.js",
      `export default {
  event: "custom.override",
  description: "global",
  handler(ctx) {
    ctx.emit("which", { source: "global" });
  },
};
`,
    );

    await writeHookFile(
      join(workspace, ".claudia", "hooks"),
      "shadow.js",
      `export default {
  event: "custom.override",
  description: "workspace",
  handler(ctx) {
    ctx.emit("which", { source: "workspace" });
  },
};
`,
    );

    const extension = createHooksExtension({ extraDirs: [globalDir] });
    const mock = createMockContext();
    await extension.start(mock.ctx);

    await mock.dispatch({
      type: "custom.override",
      payload: { cwd: workspace },
      timestamp: Date.now(),
      origin: "test",
    });
    await flushAsync();

    const listed = (await extension.handleMethod("hooks.list", {})) as {
      hooks: Array<{ id: string; description?: string }>;
    };
    const shadowHooks = listed.hooks.filter((h) => h.id === "shadow");
    expect(shadowHooks).toHaveLength(1);
    expect(shadowHooks[0]?.description).toBe("workspace");

    const events = mock.emitted.filter((e) => e.type === "hook.shadow.which");
    expect(events).toHaveLength(1);
    expect(events[0]?.payload).toEqual({ source: "workspace" });

    await extension.stop();
  });
});
