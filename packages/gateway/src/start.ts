#!/usr/bin/env bun
/**
 * Gateway Startup Script
 *
 * Loads the gateway and registers configured extensions.
 * This is the main entry point for running the gateway with extensions.
 *
 * Configuration sources (in order of precedence):
 *   1. CLAUDIA_CONFIG env var (explicit path)
 *   2. ./claudia.json in working directory
 *   3. Environment variables (backward compatibility)
 */

import { extensions } from "./index";
import { getEnabledExtensions, createLogger } from "@claudia/shared";
import { join } from "node:path";
import { homedir } from "node:os";

const log = createLogger("Startup", join(homedir(), ".claudia", "logs", "gateway.log"));

// Import available extensions
import { createVoiceExtension } from "@claudia/voice";
import { createIMessageExtension } from "@claudia/ext-imessage";
import { createChatExtension } from "@claudia/ext-chat/extension";
import { createMissionControlExtension } from "@claudia/ext-mission-control/extension";

// Extension factory registry
type ExtensionFactory = (
  config: Record<string, unknown>,
) => ReturnType<typeof createVoiceExtension>;

const EXTENSION_FACTORIES: Record<string, ExtensionFactory> = {
  voice: (config) =>
    createVoiceExtension({
      apiKey: config.apiKey as string,
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
  // Add more extensions here as they're created
  // memory: (config) => createMemoryExtension(config),
  // browser: (config) => createBrowserExtension(config),
};

/**
 * Load configured extensions from config file or env vars
 */
async function loadExtensions(): Promise<void> {
  const enabledExtensions = getEnabledExtensions();

  if (enabledExtensions.length === 0) {
    log.info("No extensions enabled");
    return;
  }

  log.info("Loading extensions", { extensions: enabledExtensions.map(([id]) => id) });

  for (const [id, ext] of enabledExtensions) {
    const factory = EXTENSION_FACTORIES[id];
    if (!factory) {
      log.warn("Unknown extension", { id });
      continue;
    }

    try {
      const extension = factory(ext.config);

      // Add source routes from config if specified
      if (ext.sourceRoutes?.length) {
        extension.sourceRoutes = ext.sourceRoutes;
      }

      await extensions.register(extension);
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
