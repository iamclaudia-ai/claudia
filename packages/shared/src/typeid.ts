/**
 * TypeID utilities for generating prefixed, sortable IDs
 *
 * Uses TypeID (https://github.com/jetify-com/typeid) which provides:
 * - Prefixed IDs for type safety (e.g., ws_01aryzwvv662w7z9h61zcf5x)
 * - UUIDv7 based (timestamp-ordered for better indexing)
 * - Base32 encoded (no dashes, double-click friendly)
 * - URL-safe
 */

import { typeid } from "typeid-js";

/**
 * ID prefixes for different resource types
 */
export const ID_PREFIXES = {
  workspace: "ws",
  session: "ses",
} as const;

export type IdPrefix = (typeof ID_PREFIXES)[keyof typeof ID_PREFIXES];

/**
 * Generate a new TypeID with the given prefix
 */
export function generateId(prefix: IdPrefix): string {
  return typeid(prefix).toString();
}

/**
 * Parse a TypeID into its prefix and suffix
 */
export function parseId(id: string): { prefix: string; suffix: string } {
  const parts = id.split("_");
  if (parts.length !== 2) {
    throw new Error(`Invalid TypeID format: ${id}`);
  }
  return {
    prefix: parts[0],
    suffix: parts[1],
  };
}

/**
 * Validate that an ID has the expected prefix
 */
export function validateIdPrefix(id: string, expectedPrefix: IdPrefix): boolean {
  try {
    const { prefix } = parseId(id);
    return prefix === expectedPrefix;
  } catch {
    return false;
  }
}

/** Generate workspace ID (ws_...) */
export function generateWorkspaceId(): string {
  return generateId(ID_PREFIXES.workspace);
}

/** Generate session ID (ses_...) */
export function generateSessionId(): string {
  return generateId(ID_PREFIXES.session);
}
