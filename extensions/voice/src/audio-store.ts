/**
 * Audio Store
 *
 * Saves and retrieves generated TTS audio files for future playback.
 * Audio is stored at ~/.claudia/audio/{sessionId}/{streamId}.mp3
 */

import { join } from 'node:path';
import { homedir } from 'node:os';
import { existsSync, mkdirSync } from 'node:fs';

const AUDIO_DIR = join(homedir(), '.claudia', 'audio');

/** Save audio buffer to disk. Returns the file path. */
export async function saveAudio(
  audio: Buffer,
  sessionId: string,
  streamId: string,
): Promise<string> {
  const dir = join(AUDIO_DIR, sessionId);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const path = join(dir, `${streamId}.mp3`);
  await Bun.write(path, audio);
  return path;
}

/** Get the path to a saved audio file, or null if it doesn't exist. */
export function getAudioPath(sessionId: string, streamId: string): string | null {
  const path = join(AUDIO_DIR, sessionId, `${streamId}.mp3`);
  return existsSync(path) ? path : null;
}
