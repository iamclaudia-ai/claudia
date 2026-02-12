/**
 * Audio Store
 *
 * Saves and retrieves generated TTS audio files for future playback.
 * Audio is stored at ~/.claudia/audio/{sessionId}/{streamId}.wav
 */

import { join } from 'node:path';
import { homedir } from 'node:os';
import { existsSync, mkdirSync } from 'node:fs';

const AUDIO_DIR = join(homedir(), '.claudia', 'audio');

/** Convert raw PCM data to WAV format */
function pcmToWav(pcmData: Buffer, sampleRate: number = 24000, channels: number = 1): Buffer {
  const bitDepth = 16;
  const byteRate = sampleRate * channels * bitDepth / 8;
  const blockAlign = channels * bitDepth / 8;
  const dataSize = pcmData.length;
  const fileSize = 44 + dataSize; // 44 bytes for WAV header

  const header = Buffer.alloc(44);

  // RIFF chunk descriptor
  header.write('RIFF', 0);                     // ChunkID
  header.writeUInt32LE(fileSize - 8, 4);       // ChunkSize
  header.write('WAVE', 8);                     // Format

  // fmt sub-chunk
  header.write('fmt ', 12);                    // Subchunk1ID
  header.writeUInt32LE(16, 16);               // Subchunk1Size (PCM)
  header.writeUInt16LE(1, 20);                // AudioFormat (PCM)
  header.writeUInt16LE(channels, 22);         // NumChannels
  header.writeUInt32LE(sampleRate, 24);       // SampleRate
  header.writeUInt32LE(byteRate, 28);         // ByteRate
  header.writeUInt16LE(blockAlign, 32);       // BlockAlign
  header.writeUInt16LE(bitDepth, 34);         // BitsPerSample

  // data sub-chunk
  header.write('data', 36);                   // Subchunk2ID
  header.writeUInt32LE(dataSize, 40);         // Subchunk2Size

  return Buffer.concat([header, pcmData]);
}

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

  // Convert raw PCM to WAV format
  const wavData = pcmToWav(audio, 24000, 1);

  const path = join(dir, `${streamId}.wav`);
  await Bun.write(path, wavData);
  return path;
}

/** Get the path to a saved audio file, or null if it doesn't exist. */
export function getAudioPath(sessionId: string, streamId: string): string | null {
  const path = join(AUDIO_DIR, sessionId, `${streamId}.wav`);
  return existsSync(path) ? path : null;
}
