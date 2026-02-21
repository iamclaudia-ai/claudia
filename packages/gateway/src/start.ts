#!/usr/bin/env bun
/**
 * Gateway Startup Script
 *
 * Extension loading is config-driven and out-of-process by default.
 * Each enabled extension runs in its own host process via stdio NDJSON.
 */

import { extensions, handleExtensionEvent } from "./index";
import { getEnabledExtensions, createLogger } from "@claudia/shared";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { homedir } from "node:os";
import {
  ExtensionHostProcess,
  type ExtensionRegistration,
  type OnCallCallback,
} from "./extension-host";

const log = createLogger("Startup", join(homedir(), ".claudia", "logs", "gateway.log"));
const ROOT_DIR = join(import.meta.dir, "..", "..", "..");

/**
 * Kill orphaned extension host processes from previous gateway instances.
 * When bun --watch restarts the gateway, child processes can be orphaned
 * because SIGKILL doesn't allow cleanup handlers to run.
 */
async function killOrphanExtensionHosts(): Promise<void> {
  try {
    const proc = Bun.spawn(["pgrep", "-f", "extensions/.*/src/index.ts"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const output = await new Response(proc.stdout).text();
    await proc.exited;

    const pids = output
      .trim()
      .split("\n")
      .filter(Boolean)
      .map(Number)
      .filter((pid) => pid !== process.pid);

    if (pids.length > 0) {
      log.info("Killing orphaned extension hosts", { pids });
      for (const pid of pids) {
        try {
          process.kill(pid, "SIGTERM");
        } catch {
          // Process already dead
        }
      }
      // Brief wait for graceful shutdown
      await new Promise((r) => setTimeout(r, 500));
    }
  } catch {
    // pgrep returns exit code 1 when no matches — that's fine
  }
}

const startedExtensions = new Set<string>();

function resolveExtensionEntrypoint(extensionId: string): string | null {
  const entryPath = join(ROOT_DIR, "extensions", extensionId, "src", "index.ts");
  if (!existsSync(entryPath)) {
    return null;
  }
  return entryPath;
}

async function spawnOutOfProcessExtension(
  id: string,
  config: Record<string, unknown>,
  sourceRoutes?: string[],
): Promise<void> {
  if (startedExtensions.has(id)) {
    return;
  }

  const moduleSpec = resolveExtensionEntrypoint(id);
  if (!moduleSpec) {
    log.warn("Extension entrypoint not found", {
      id,
      expected: `extensions/${id}/src/index.ts`,
    });
    return;
  }

  log.info("Spawning out-of-process extension", { id, module: moduleSpec });

  // ctx.call handler: route calls from this extension through the gateway hub
  const onCall: OnCallCallback = async (callerExtensionId, method, params, meta) => {
    try {
      const result = await extensions.handleMethod(method, params, meta.connectionId, {
        traceId: meta.traceId,
        depth: meta.depth,
        deadlineMs: meta.deadlineMs,
      });
      return { ok: true as const, payload: result };
    } catch (error) {
      return { ok: false as const, error: String(error) };
    }
  };

  const host = new ExtensionHostProcess(
    id,
    moduleSpec,
    config,
    (type, payload, source, connectionId) =>
      handleExtensionEvent(type, payload, source || `extension:${id}`, connectionId),
    (registration: ExtensionRegistration) => {
      // Allow config-level sourceRoutes to augment extension-declared routes.
      if (sourceRoutes?.length) {
        registration.sourceRoutes = Array.from(
          new Set([...(registration.sourceRoutes || []), ...sourceRoutes]),
        );
      }
      extensions.registerRemote(registration, host);
    },
    onCall,
  );

  const registration = await host.spawn();
  log.info("Out-of-process extension ready", {
    id: registration.id,
    methods: registration.methods.map((m) => m.name),
  });

  startedExtensions.add(id);
}

/**
 * Load configured extensions from config.
 * Extensions run out-of-process by default.
 */
async function loadExtensions(): Promise<void> {
  const enabledExtensions = getEnabledExtensions();

  if (enabledExtensions.length === 0) {
    log.info("No configured extensions enabled");
    return;
  }

  log.info("Loading configured extensions", {
    extensions: enabledExtensions.map(([id]) => id),
  });

  for (const [id, ext] of enabledExtensions) {
    try {
      await spawnOutOfProcessExtension(id, ext.config, ext.sourceRoutes);
    } catch (error) {
      log.error("Failed to load extension", { id, error: String(error) });
    }
  }
}

killOrphanExtensionHosts()
  .then(() => loadExtensions())
  .catch((err) => log.error("Extension startup failed", { error: String(err) }));
