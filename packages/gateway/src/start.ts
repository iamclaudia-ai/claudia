#!/usr/bin/env bun
/**
 * Gateway Startup Script
 *
 * Loads the gateway and registers configured extensions.
 * Extensions with `outOfProcess: true` in config are spawned as child processes
 * via the extension host shim. Others load in-process as before.
 *
 * Configuration sources (in order of precedence):
 *   1. CLAUDIA_CONFIG env var (explicit path)
 *   2. ./claudia.json in working directory
 *   3. Environment variables (backward compatibility)
 */

import { extensions, broadcastEvent } from "./index";
import { getEnabledExtensions, createLogger } from "@claudia/shared";
import { join } from "node:path";
import { homedir } from "node:os";
import { ExtensionHostProcess } from "./extension-host";

const log = createLogger("Startup", join(homedir(), ".claudia", "logs", "gateway.log"));

// Import available extensions (for in-process loading)
import { createVoiceExtension } from "@claudia/voice";
import { createIMessageExtension } from "@claudia/ext-imessage";
import { createChatExtension } from "@claudia/ext-chat/extension";
import { createMissionControlExtension } from "@claudia/ext-mission-control/extension";

// Extension factory registry (only used for in-process extensions)
type ExtensionFactory = (
  config: Record<string, unknown>,
) => ReturnType<typeof createVoiceExtension>;

const EXTENSION_FACTORIES: Record<string, ExtensionFactory> = {
  voice: (config) =>
    createVoiceExtension({
      apiKey: config.apiKey as string,
      dictionaryId: config.dictionaryId as string,
      voiceId: config.voiceId as string,
      model: config.model as string,
      autoSpeak: config.autoSpeak as boolean,
      summarizeThreshold: config.summarizeThreshold as number,
      streaming: config.streaming as boolean,
    }),
  imessage: (config) =>
    createIMessageExtension({
      cliPath: config.cliPath as string,
      dbPath: config.dbPath as string,
      allowedSenders: config.allowedSenders as string[],
      includeAttachments: config.includeAttachments as boolean,
      historyLimit: config.historyLimit as number,
    }),
};

// Maps extension IDs to their module specifiers (for out-of-process loading)
const MODULE_SPECIFIERS: Record<string, string> = {
  voice: "@claudia/voice",
  imessage: "@claudia/ext-imessage",
};

/**
 * Load configured extensions from config file or env vars.
 * Extensions with `outOfProcess: true` are spawned as child processes.
 */
async function loadExtensions(): Promise<void> {
  const enabledExtensions = getEnabledExtensions();

  if (enabledExtensions.length === 0) {
    log.info("No extensions enabled");
    return;
  }

  log.info("Loading extensions", { extensions: enabledExtensions.map(([id]) => id) });

  for (const [id, ext] of enabledExtensions) {
    try {
      if (ext.outOfProcess) {
        // Out-of-process: spawn via extension host
        const moduleSpec = MODULE_SPECIFIERS[id];
        if (!moduleSpec) {
          log.warn("No module specifier for out-of-process extension", { id });
          continue;
        }

        log.info("Spawning out-of-process extension", { id, module: moduleSpec });

        const host = new ExtensionHostProcess(
          id,
          moduleSpec,
          ext.config,
          (type, payload) => broadcastEvent(type, payload, `extension:${id}`),
          (registration) => extensions.registerRemote(registration, host),
        );

        const registration = await host.spawn();
        log.info("Out-of-process extension ready", {
          id: registration.id,
          methods: registration.methods.map((m) => m.name),
        });
      } else {
        // In-process: existing behavior
        const factory = EXTENSION_FACTORIES[id];
        if (!factory) {
          log.warn("Unknown extension", { id });
          continue;
        }

        const extension = factory(ext.config);

        // Add source routes from config if specified
        if (ext.sourceRoutes?.length) {
          extension.sourceRoutes = ext.sourceRoutes;
        }

        await extensions.register(extension);
      }
    } catch (error) {
      log.error("Failed to load extension", { id, error: String(error) });
    }
  }
}

// Always-on extensions (no config needed)
async function loadBuiltinExtensions(): Promise<void> {
  try {
    await extensions.register(createChatExtension());
    await extensions.register(createMissionControlExtension());
  } catch (error) {
    log.error("Failed to load builtin extensions", { error: String(error) });
  }
}

// Load extensions on startup
loadBuiltinExtensions()
  .then(() => loadExtensions())
  .catch((err) => log.error("Extension startup failed", { error: String(err) }));
