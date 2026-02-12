/**
 * Claudia Configuration Loader
 *
 * Features:
 * - JSON5 format (supports comments, trailing commas)
 * - Environment variable interpolation: "${ENV_VAR}"
 * - Type-safe config with defaults
 * - Falls back to env vars if no config file
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import JSON5 from 'json5';

// ============================================================================
// Types
// ============================================================================

export interface GatewayConfig {
  port: number;
  host: string;
  /** Public endpoint hostname for remote clients (e.g., "claudia-gateway.kiliman.dev") */
  endpoint?: string;
}

export type ThinkingEffort = 'low' | 'medium' | 'high' | 'max';

export interface SessionConfig {
  model: string;
  thinking: boolean;
  effort: ThinkingEffort;
  systemPrompt: string | null;
}

export interface ExtensionConfig {
  enabled: boolean;
  /** Source prefixes this extension handles for routing (e.g., ["imessage"]) */
  sourceRoutes?: string[];
  config: Record<string, unknown>;
}

export type ExtensionsConfig = Record<string, ExtensionConfig>;

export interface FederationPeer {
  id: string;
  url: string;
  role: 'primary' | 'replica';
}

export interface RuntimeConfig {
  port: number;
  host: string;
}

export interface FederationConfig {
  enabled: boolean;
  nodeId: string;
  peers: FederationPeer[];
}

export interface ClaudiaConfig {
  gateway: GatewayConfig;
  runtime: RuntimeConfig;
  session: SessionConfig;
  extensions: ExtensionsConfig;
  federation: FederationConfig;
}

// ============================================================================
// Defaults
// ============================================================================

const DEFAULT_CONFIG: ClaudiaConfig = {
  gateway: {
    port: 30086,
    host: 'localhost',
  },
  runtime: {
    port: 30087,
    host: 'localhost',
  },
  session: {
    model: 'sonnet',
    thinking: false,
    effort: 'medium',
    systemPrompt: null,
  },
  extensions: {},
  federation: {
    enabled: false,
    nodeId: 'default',
    peers: [],
  },
};

// ============================================================================
// Environment Variable Interpolation
// ============================================================================

/**
 * Replace ${ENV_VAR} patterns with process.env values
 * Supports nested objects and arrays
 */
function interpolateEnvVars(obj: unknown): unknown {
  if (typeof obj === 'string') {
    // Match ${VAR_NAME} pattern
    return obj.replace(/\$\{([^}]+)\}/g, (_, envVar) => {
      const value = process.env[envVar];
      if (value === undefined) {
        console.warn(`[Config] Warning: Environment variable ${envVar} is not set`);
        return '';
      }
      return value;
    });
  }

  if (Array.isArray(obj)) {
    return obj.map(interpolateEnvVars);
  }

  if (obj !== null && typeof obj === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      result[key] = interpolateEnvVars(value);
    }
    return result;
  }

  return obj;
}

// ============================================================================
// Config Loader
// ============================================================================

let cachedConfig: ClaudiaConfig | null = null;

/**
 * Load configuration from claudia.json
 *
 * Search order:
 * 1. CLAUDIA_CONFIG env var (explicit path)
 * 2. ./claudia.json (current directory)
 * 3. Fall back to defaults + env vars
 */
export function loadConfig(configPath?: string): ClaudiaConfig {
  if (cachedConfig && !configPath) {
    return cachedConfig;
  }

  // Determine config file path
  // Search order: explicit path → env var → ~/.claudia/claudia.json
  const paths = [
    configPath,
    process.env.CLAUDIA_CONFIG,
    join(homedir(), '.claudia', 'claudia.json'),
  ].filter(Boolean) as string[];

  let rawConfig: Partial<ClaudiaConfig> = {};
  let loadedFrom: string | null = null;

  for (const path of paths) {
    if (existsSync(path)) {
      try {
        const content = readFileSync(path, 'utf-8');
        rawConfig = JSON5.parse(content);
        loadedFrom = path;
        break;
      } catch (error) {
        console.error(`[Config] Error parsing ${path}:`, error);
      }
    }
  }

  if (loadedFrom) {
    console.log(`[Config] Loaded from: ${loadedFrom}`);
  } else {
    console.log('[Config] No config file found, using defaults + env vars');
    // Build config from env vars for backward compatibility
    rawConfig = buildConfigFromEnv();
  }

  // Interpolate environment variables
  const interpolated = interpolateEnvVars(rawConfig) as Partial<ClaudiaConfig>;

  // Merge with defaults
  const config: ClaudiaConfig = {
    gateway: { ...DEFAULT_CONFIG.gateway, ...interpolated.gateway },
    runtime: { ...DEFAULT_CONFIG.runtime, ...interpolated.runtime },
    session: { ...DEFAULT_CONFIG.session, ...interpolated.session },
    extensions: interpolated.extensions ?? DEFAULT_CONFIG.extensions,
    federation: { ...DEFAULT_CONFIG.federation, ...interpolated.federation },
  };

  cachedConfig = config;
  return config;
}

/**
 * Build config from environment variables (backward compatibility)
 */
function buildConfigFromEnv(): Partial<ClaudiaConfig> {
  const config: Partial<ClaudiaConfig> = {
    gateway: {
      port: parseInt(process.env.CLAUDIA_PORT || '30086'),
      host: process.env.CLAUDIA_HOST || 'localhost',
    },
    session: {
      model: process.env.CLAUDIA_MODEL || 'sonnet',
      thinking: process.env.CLAUDIA_THINKING === 'true',
      effort: (process.env.CLAUDIA_THINKING_EFFORT || 'medium') as ThinkingEffort,
      systemPrompt: process.env.CLAUDIA_SYSTEM_PROMPT || null,
    },
    extensions: {},
  };

  // Build extensions from CLAUDIA_EXTENSIONS env var
  const extensionIds = process.env.CLAUDIA_EXTENSIONS?.split(',').map(s => s.trim()) || [];

  for (const id of extensionIds) {
    if (id === 'voice') {
      config.extensions![id] = {
        enabled: true,
        config: {
          apiKey: process.env.ELEVENLABS_API_KEY || '',
          voiceId: process.env.ELEVENLABS_VOICE_ID,
          autoSpeak: process.env.CLAUDIA_VOICE_AUTO_SPEAK === 'true',
        },
      };
    } else {
      // Generic extension
      config.extensions![id] = {
        enabled: true,
        config: {},
      };
    }
  }

  return config;
}

/**
 * Get extension config by ID
 */
export function getExtensionConfig(id: string): ExtensionConfig | undefined {
  const config = loadConfig();
  return config.extensions[id];
}

/**
 * Check if extension is enabled
 */
export function isExtensionEnabled(id: string): boolean {
  const ext = getExtensionConfig(id);
  return ext?.enabled ?? false;
}

/**
 * Get all enabled extensions as [id, config] pairs
 */
export function getEnabledExtensions(): [string, ExtensionConfig][] {
  const config = loadConfig();
  return Object.entries(config.extensions).filter(([_, ext]) => ext.enabled);
}

/**
 * Clear cached config (useful for testing)
 */
export function clearConfigCache(): void {
  cachedConfig = null;
}
