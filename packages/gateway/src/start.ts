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

import { extensions } from './index';
import { getEnabledExtensions } from '@claudia/shared';

// Import available extensions
import { createVoiceExtension } from '@claudia/voice';

// Extension factory registry
type ExtensionFactory = (config: Record<string, unknown>) => ReturnType<typeof createVoiceExtension>;

const EXTENSION_FACTORIES: Record<string, ExtensionFactory> = {
  voice: (config) =>
    createVoiceExtension({
      apiKey: config.apiKey as string,
      voiceId: config.voiceId as string,
      model: config.model as string,
      autoSpeak: config.autoSpeak as boolean,
      summarizeThreshold: config.summarizeThreshold as number,
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
    console.log('[Startup] No extensions enabled');
    return;
  }

  console.log(
    `[Startup] Loading extensions: ${enabledExtensions.map(([id]) => id).join(', ')}`
  );

  for (const [id, ext] of enabledExtensions) {
    const factory = EXTENSION_FACTORIES[id];
    if (!factory) {
      console.warn(`[Startup] Unknown extension: ${id}`);
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
      console.error(`[Startup] Failed to load extension ${id}:`, error);
    }
  }
}

// Load extensions on startup
loadExtensions().catch(console.error);
