#!/usr/bin/env bun
/**
 * Gateway Startup Script
 *
 * Extension loading is config-driven and out-of-process by default.
 * Each enabled extension runs in its own host process via stdio NDJSON.
 */

import { extensions, broadcastEvent } from "./index";
import { getEnabledExtensions, createLogger } from "@claudia/shared";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { homedir } from "node:os";
import { ExtensionHostProcess, type ExtensionRegistration } from "./extension-host";

const log = createLogger("Startup", join(homedir(), ".claudia", "logs", "gateway.log"));
const ROOT_DIR = join(import.meta.dir, "..", "..", "..");

const startedExtensions = new Set<string>();

function resolveExtensionEntrypoint(extensionId: string): string | null {
  const entryPath = join(ROOT_DIR, "extensions", extensionId, "src", "index.ts");
  if (!existsSync(entryPath)) {
    return null;
  }
  return pathToFileURL(entryPath).href;
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

  const host = new ExtensionHostProcess(
    id,
    moduleSpec,
    config,
    (type, payload) => broadcastEvent(type, payload, `extension:${id}`),
    (registration: ExtensionRegistration) => {
      // Allow config-level sourceRoutes to augment extension-declared routes.
      if (sourceRoutes?.length) {
        registration.sourceRoutes = Array.from(
          new Set([...(registration.sourceRoutes || []), ...sourceRoutes]),
        );
      }
      extensions.registerRemote(registration, host);
    },
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
      if (ext.outOfProcess === false) {
        log.warn("Ignoring in-process request: extensions run out-of-process", { id });
      }

      await spawnOutOfProcessExtension(id, ext.config, ext.sourceRoutes);
    } catch (error) {
      log.error("Failed to load extension", { id, error: String(error) });
    }
  }
}

loadExtensions().catch((err) => log.error("Extension startup failed", { error: String(err) }));
