/**
 * Audio Playback Hook
 *
 * Manages a queue-based audio playback system for streaming TTS.
 * Receives base64 MP3 audio chunks via gateway events (voice.audio_chunk)
 * and plays them sequentially using the Web Audio API.
 */

import { useState, useEffect, useRef, useCallback } from "react";
import type { UseGatewayReturn } from "./useGateway";

export interface UseAudioPlaybackReturn {
  /** Whether audio is currently playing */
  isPlaying: boolean;
  /** Whether a voice stream is active (may still be buffering) */
  isStreaming: boolean;
  /** Stop playback and clear queue */
  stop(): void;
}

/** Decode a base64 string to an ArrayBuffer */
function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

/** Convert raw PCM data to WAV format for browser playback */
function pcmToWav(pcmData: ArrayBuffer, sampleRate: number = 24000, channels: number = 1): ArrayBuffer {
  const pcmBytes = new Int16Array(pcmData);
  const length = pcmBytes.length;
  const buffer = new ArrayBuffer(44 + length * 2);
  const view = new DataView(buffer);

  // WAV header
  const writeString = (offset: number, str: string) => {
    for (let i = 0; i < str.length; i++) {
      view.setUint8(offset + i, str.charCodeAt(i));
    }
  };

  writeString(0, 'RIFF');                                    // ChunkID
  view.setUint32(4, 36 + length * 2, true);                 // ChunkSize
  writeString(8, 'WAVE');                                    // Format
  writeString(12, 'fmt ');                                   // Subchunk1ID
  view.setUint32(16, 16, true);                              // Subchunk1Size
  view.setUint16(20, 1, true);                               // AudioFormat (PCM)
  view.setUint16(22, channels, true);                        // NumChannels
  view.setUint32(24, sampleRate, true);                      // SampleRate
  view.setUint32(28, sampleRate * channels * 2, true);       // ByteRate
  view.setUint16(32, channels * 2, true);                    // BlockAlign
  view.setUint16(34, 16, true);                              // BitsPerSample
  writeString(36, 'data');                                   // Subchunk2ID
  view.setUint32(40, length * 2, true);                      // Subchunk2Size

  // Copy PCM data
  const offset = 44;
  for (let i = 0; i < length; i++) {
    view.setInt16(offset + i * 2, pcmBytes[i], true);
  }

  return buffer;
}

export function useAudioPlayback(
  gateway: UseGatewayReturn,
): UseAudioPlaybackReturn {
  const [isPlaying, setIsPlaying] = useState(false);
  const [isStreaming, setIsStreaming] = useState(false);

  const audioContextRef = useRef<AudioContext | null>(null);
  const queueRef = useRef<AudioBuffer[]>([]);
  const isPlayingRef = useRef(false);
  const currentSourceRef = useRef<AudioBufferSourceNode | null>(null);
  const isStreamingRef = useRef(false);

  /** Ensure AudioContext is initialized and resumed */
  const ensureAudioContext = useCallback((): AudioContext => {
    if (!audioContextRef.current) {
      audioContextRef.current = new AudioContext();
    }
    // Resume if suspended (browser autoplay policy)
    if (audioContextRef.current.state === "suspended") {
      audioContextRef.current.resume();
    }
    return audioContextRef.current;
  }, []);

  /** Play the next buffer in the queue */
  const playNext = useCallback(() => {
    console.log(`[AudioPlayback] playNext() called, queue length: ${queueRef.current.length}`);
    if (queueRef.current.length === 0) {
      console.log("[AudioPlayback] Queue empty, stopping playback");
      isPlayingRef.current = false;
      setIsPlaying(false);
      // If stream is done and queue is empty, we're fully done
      if (!isStreamingRef.current) {
        setIsStreaming(false);
      }
      return;
    }

    const ctx = audioContextRef.current;
    if (!ctx) return;

    isPlayingRef.current = true;
    setIsPlaying(true);

    const buffer = queueRef.current.shift()!;
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(ctx.destination);
    currentSourceRef.current = source;

    source.onended = () => {
      console.log("[AudioPlayback] Chunk finished, playing next");
      currentSourceRef.current = null;
      playNext();
    };

    console.log(`[AudioPlayback] Starting chunk: ${buffer.duration.toFixed(3)}s`);
    source.start();
  }, []);

  /** Stop playback and clear the queue */
  const stop = useCallback(() => {
    queueRef.current = [];

    if (currentSourceRef.current) {
      try {
        currentSourceRef.current.stop();
      } catch {
        // Already stopped
      }
      currentSourceRef.current = null;
    }

    isPlayingRef.current = false;
    isStreamingRef.current = false;
    setIsPlaying(false);
    setIsStreaming(false);

    // Tell the server to abort the stream
    gateway.sendRequest("voice.stop");
  }, [gateway]);

  // Subscribe to voice events
  useEffect(() => {
    return gateway.onEvent((event: string, payload: unknown) => {
      const data = payload as Record<string, unknown>;

      if (event === "voice.stream_start") {
        isStreamingRef.current = true;
        setIsStreaming(true);
        ensureAudioContext();
      }

      if (event === "voice.audio_chunk") {
        const audio = data.audio as string;
        if (!audio) return;

        const ctx = ensureAudioContext();
        const pcmArrayBuffer = base64ToArrayBuffer(audio);
        const pcmData = new Int16Array(pcmArrayBuffer);

        console.log(`[AudioPlayback] Processing chunk: ${pcmData.length} samples (${pcmArrayBuffer.byteLength} bytes PCM)`);

        // Create AudioBuffer directly from PCM data (no WAV conversion needed)
        // Use AudioContext's sample rate to avoid resampling artifacts
        const sampleRate = ctx.sampleRate;
        const cartesiaSampleRate = 24000;
        const channels = 1;
        const frameCount = pcmData.length;

        // If sample rates differ, we need to resample to match AudioContext
        let finalFrameCount = frameCount;
        let resampledData = pcmData;

        if (sampleRate !== cartesiaSampleRate) {
          // Simple resampling - not perfect but should reduce crackling
          const resampleRatio = sampleRate / cartesiaSampleRate;
          finalFrameCount = Math.floor(frameCount * resampleRatio);
          resampledData = new Int16Array(finalFrameCount);

          for (let i = 0; i < finalFrameCount; i++) {
            const sourceIndex = Math.floor(i / resampleRatio);
            resampledData[i] = pcmData[Math.min(sourceIndex, frameCount - 1)];
          }

          console.log(`[AudioPlaybook] Resampled ${frameCount} samples (${cartesiaSampleRate}Hz) to ${finalFrameCount} samples (${sampleRate}Hz)`);
        }

        const audioBuffer = ctx.createBuffer(channels, finalFrameCount, sampleRate);

        // Copy PCM data to AudioBuffer (convert from Int16 to Float32)
        const channelData = audioBuffer.getChannelData(0);
        for (let i = 0; i < finalFrameCount; i++) {
          channelData[i] = resampledData[i] / 32768.0; // Convert 16-bit signed int to float (-1 to 1)
        }

        console.log(`[AudioPlayback] Created AudioBuffer: ${audioBuffer.duration.toFixed(3)}s (${finalFrameCount} frames @ ${sampleRate}Hz), queue length: ${queueRef.current.length + 1}`);
        queueRef.current.push(audioBuffer);

        // Start playing if not already
        if (!isPlayingRef.current) {
          console.log("[AudioPlayback] Starting playback");
          playNext();
        }
      }

      if (event === "voice.stream_end") {
        isStreamingRef.current = false;
        // If nothing is playing and queue is empty, clear streaming state
        if (!isPlayingRef.current && queueRef.current.length === 0) {
          setIsStreaming(false);
        }
        // Otherwise, playNext() will clear it when queue drains
      }

      // Also handle batch mode (voice.audio with full base64 MP3)
      if (event === "voice.audio") {
        const audioData = data.data as string;
        if (!audioData) return;

        const ctx = ensureAudioContext();
        const arrayBuffer = base64ToArrayBuffer(audioData);

        isStreamingRef.current = true;
        setIsStreaming(true);

        ctx.decodeAudioData(arrayBuffer).then((buffer) => {
          queueRef.current.push(buffer);
          if (!isPlayingRef.current) {
            playNext();
          }
        }).catch((err) => {
          console.warn("[AudioPlayback] Failed to decode batch audio:", err);
        });
      }
    });
  }, [gateway, ensureAudioContext, playNext]);

  // Cleanup AudioContext on unmount
  useEffect(() => {
    return () => {
      if (audioContextRef.current) {
        audioContextRef.current.close();
        audioContextRef.current = null;
      }
    };
  }, []);

  return { isPlaying, isStreaming, stop };
}
