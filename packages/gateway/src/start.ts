#!/usr/bin/env bun
/**
 * Gateway Startup Script
 *
 * Loads the gateway and registers configured extensions.
 * This is the main entry point for running the gateway with extensions.
 *
 * Extensions are loaded based on environment variables:
 *   CLAUDIA_EXTENSIONS=voice,memory  (comma-separated list)
 *
 * Or load all available extensions:
 *   CLAUDIA_EXTENSIONS=all
 */

import { extensions } from './index';

// Import available extensions
import { createVoiceExtension } from '@claudia/voice';

// Extension registry
const AVAILABLE_EXTENSIONS = {
  voice: () =>
    createVoiceExtension({
      apiKey: process.env.ELEVENLABS_API_KEY,
      voiceId: process.env.ELEVENLABS_VOICE_ID,
      autoSpeak: process.env.CLAUDIA_VOICE_AUTO_SPEAK === 'true',
    }),
  // Add more extensions here as they're created
  // memory: () => createMemoryExtension({ ... }),
};

/**
 * Load configured extensions
 */
async function loadExtensions(): Promise<void> {
  const extensionList = process.env.CLAUDIA_EXTENSIONS || '';

  if (!extensionList) {
    console.log('[Startup] No extensions configured (set CLAUDIA_EXTENSIONS to enable)');
    return;
  }

  const toLoad =
    extensionList === 'all'
      ? Object.keys(AVAILABLE_EXTENSIONS)
      : extensionList.split(',').map((s) => s.trim());

  console.log(`[Startup] Loading extensions: ${toLoad.join(', ')}`);

  for (const name of toLoad) {
    const factory = AVAILABLE_EXTENSIONS[name as keyof typeof AVAILABLE_EXTENSIONS];
    if (!factory) {
      console.warn(`[Startup] Unknown extension: ${name}`);
      continue;
    }

    try {
      const extension = factory();
      await extensions.register(extension);
    } catch (error) {
      console.error(`[Startup] Failed to load extension ${name}:`, error);
    }
  }
}

// Load extensions on startup
loadExtensions().catch(console.error);
