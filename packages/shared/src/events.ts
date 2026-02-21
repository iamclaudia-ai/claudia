/**
 * Event Pattern Matching
 *
 * Shared utility for matching event names against subscription patterns.
 * Used by: gateway extensions manager, extension host, WS client subscriptions.
 *
 * Pattern syntax:
 *   "*"                          — matches everything
 *   "session.send_prompt"        — exact match
 *   "session.*"                  — trailing wildcard: matches any event under session. (any depth)
 *   "session.*.content_block_delta" — middle wildcard: * matches exactly one segment
 */

export function matchesEventPattern(eventType: string, pattern: string): boolean {
  if (pattern === "*") return true;
  if (pattern === eventType) return true;

  const patternParts = pattern.split(".");
  const eventParts = eventType.split(".");

  // Trailing wildcard: "session.*" matches "session.abc" AND "session.abc.xyz" (any depth)
  const lastPart = patternParts[patternParts.length - 1];
  if (lastPart === "*" && patternParts.length === 2) {
    return eventParts[0] === patternParts[0];
  }

  // Segment-by-segment matching: * matches exactly one segment
  if (patternParts.length !== eventParts.length) return false;
  return patternParts.every((p, i) => p === "*" || p === eventParts[i]);
}
