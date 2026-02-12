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
    if (queueRef.current.length === 0) {
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
      currentSourceRef.current = null;
      playNext();
    };

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
        const arrayBuffer = base64ToArrayBuffer(audio);

        ctx.decodeAudioData(arrayBuffer).then((buffer) => {
          queueRef.current.push(buffer);
          // Start playing if not already
          if (!isPlayingRef.current) {
            playNext();
          }
        }).catch((err) => {
          console.warn("[AudioPlayback] Failed to decode audio chunk:", err);
        });
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
