/**
 * @claudia/sdk - Claude Code CLI wrapper
 *
 * A clean wrapper around Claude Code CLI that:
 * - Spawns Claude Code with --input-format stream-json
 * - Uses an HTTP proxy to intercept Anthropic API calls
 * - Captures raw SSE streaming events
 * - Supports thinking mode injection, session resume, interrupts
 * - EventEmitter-based interface
 */

// Re-export from the main SDK file
export {
  ClaudiaSession,
  createSession,
  resumeSession,
} from './claudia-sdk';

export type { SessionOptions, StreamEvent } from './claudia-sdk';
