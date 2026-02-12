/**
 * Claudia Voice Extension
 *
 * Provides TTS (text-to-speech) capabilities using ElevenLabs.
 * Hooks into session events to speak assistant responses in real-time.
 *
 * Features:
 * - Real-time streaming TTS via ElevenLabs WebSocket API
 * - Sentence-level chunking for low-latency speech
 * - Batch fallback for manual voice.speak calls
 * - Auto-speak assistant responses (configurable)
 * - Audio saving for future playback
 */

import type { ClaudiaExtension, ExtensionContext, GatewayEvent, HealthCheckResponse } from '@claudia/shared';
import { existsSync, mkdirSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { ElevenLabsStream } from './elevenlabs-stream';
import { SentenceChunker } from './sentence-chunker';
import { saveAudio, getAudioPath } from './audio-store';

// ============================================================================
// File Logging (tail -f ~/.claudia/logs/voice.log)
// ============================================================================

const LOG_DIR = join(homedir(), '.claudia', 'logs');
if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true });
const LOG_FILE = join(LOG_DIR, 'voice.log');

function fileLog(level: string, msg: string): void {
  try {
    const ts = new Date().toISOString();
    appendFileSync(LOG_FILE, `[${ts}] [${level}] ${msg}\n`);
  } catch {
    // Ignore log write errors
  }
}

// ============================================================================
// Configuration
// ============================================================================

export interface VoiceConfig {
  /** ElevenLabs API key */
  apiKey?: string;
  /** Voice ID to use */
  voiceId?: string;
  /** Model to use */
  model?: string;
  /** Auto-speak assistant responses */
  autoSpeak?: boolean;
  /** Word count threshold for summarization */
  summarizeThreshold?: number;
  /** Voice stability (0-1) */
  stability?: number;
  /** Voice similarity boost (0-1) */
  similarityBoost?: number;
  /** Use streaming WebSocket (true) or batch REST API (false) */
  streaming?: boolean;
}

const DEFAULT_CONFIG: Required<VoiceConfig> = {
  apiKey: process.env.ELEVENLABS_API_KEY || '',
  voiceId: process.env.ELEVENLABS_VOICE_ID || 'EXAVITQu4vr4xnSDxMaL', // Sarah
  model: 'eleven_turbo_v2_5',
  autoSpeak: false,
  summarizeThreshold: 150,
  stability: 0.5,
  similarityBoost: 0.75,
  streaming: true,
};

// ============================================================================
// Text Processing Utilities
// ============================================================================

/**
 * Clean text for speech (strip markdown, emojis, etc.)
 */
function cleanForSpeech(text: string): string {
  return (
    text
      // Remove code blocks entirely
      .replace(/```[\s\S]*?```/g, '')
      // Remove inline code
      .replace(/`[^`]+`/g, '')
      // Remove markdown links, keep text
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
      // Remove markdown emphasis
      .replace(/[*_]{1,2}([^*_]+)[*_]{1,2}/g, '$1')
      // Remove headers
      .replace(/^#{1,6}\s+/gm, '')
      // Remove emojis
      .replace(
        /[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/gu,
        ''
      )
      // Remove entire list lines (bullets and numbered lists — typically technical)
      .replace(/^[\s]*[-*•]\s+.*$/gm, '')
      .replace(/^[\s]*\d+[.)]\s+.*$/gm, '')
      // Collapse multiple spaces/newlines
      .replace(/\s+/g, ' ')
      .trim()
  );
}

// ============================================================================
// Batch TTS (fallback, used for voice.speak method)
// ============================================================================

const EL_API_BASE = 'https://api.elevenlabs.io/v1';

async function batchSpeak(
  text: string,
  cfg: Required<VoiceConfig>,
): Promise<Buffer> {
  const res = await fetch(`${EL_API_BASE}/text-to-speech/${cfg.voiceId}`, {
    method: 'POST',
    headers: {
      'xi-api-key': cfg.apiKey,
      'Content-Type': 'application/json',
      Accept: 'audio/mpeg',
    },
    body: JSON.stringify({
      text,
      model_id: cfg.model,
      output_format: 'mp3_44100_128',
      voice_settings: {
        stability: cfg.stability,
        similarity_boost: cfg.similarityBoost,
      },
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`ElevenLabs API error ${res.status}: ${body}`);
  }

  return Buffer.from(await res.arrayBuffer());
}

// ============================================================================
// Voice Extension
// ============================================================================

export function createVoiceExtension(config: VoiceConfig = {}): ClaudiaExtension {
  // Filter out undefined values so they don't override defaults
  const defined = Object.fromEntries(
    Object.entries(config).filter(([, v]) => v !== undefined)
  );
  const cfg: Required<VoiceConfig> = { ...DEFAULT_CONFIG, ...defined };

  let ctx: ExtensionContext | null = null;
  let unsubscribers: Array<() => void> = [];

  // --- Streaming state (per response turn) ---
  let currentStream: ElevenLabsStream | null = null;
  let currentChunker: SentenceChunker | null = null;
  let currentStreamId: string | null = null;
  let currentSessionId: string | null = null;

  // --- Shared state ---
  let currentBlockType: string | null = null;
  let textBuffer = '';
  let isSpeaking = false;
  let currentRequestWantsVoice = false;

  /** Generate a unique stream ID for this utterance */
  function newStreamId(): string {
    return crypto.randomUUID().slice(0, 8);
  }

  /** Determine if we should speak this response */
  function shouldSpeak(): boolean {
    return cfg.autoSpeak || currentRequestWantsVoice;
  }

  // --- Streaming TTS ---

  async function startStream(sessionId: string): Promise<void> {
    if (!cfg.apiKey) { fileLog('WARN', 'startStream called but no apiKey'); return; }

    // Close any existing stream before starting a new one
    if (currentStream) {
      fileLog('WARN', 'startStream: aborting existing stream before starting new one');
      currentStream.abort();
      currentStream = null;
      currentChunker = null;
    }

    const streamId = newStreamId();
    currentStreamId = streamId;
    fileLog('INFO', `startStream: session=${sessionId}, stream=${streamId}`);
    currentSessionId = sessionId;
    currentChunker = new SentenceChunker();

    // Capture chunks in a closure so they survive state reset
    const audioChunks: Buffer[] = [];
    const capturedSessionId = sessionId;
    const capturedStreamId = streamId;

    currentStream = new ElevenLabsStream({
      apiKey: cfg.apiKey,
      voiceId: cfg.voiceId,
      model: cfg.model,
      stability: cfg.stability,
      similarityBoost: cfg.similarityBoost,
      log: fileLog,
      onAudioChunk: ({ audio, index }) => {
        fileLog('INFO', `onAudioChunk: stream=${capturedStreamId}, index=${index}, size=${audio.length} b64chars`);
        // Forward audio chunk to clients
        ctx?.emit('voice.audio_chunk', {
          audio,
          index,
          streamId: capturedStreamId,
          sessionId: capturedSessionId,
        });
        // Accumulate for saving
        audioChunks.push(Buffer.from(audio, 'base64'));
      },
      onError: (error) => {
        fileLog('ERROR', `EL stream error: ${error.message}`);
        ctx?.emit('voice.error', { error: error.message, streamId: capturedStreamId });
      },
      onDone: () => {
        fileLog('INFO', `onDone: stream=${capturedStreamId}, ${audioChunks.length} chunks accumulated`);
        // Save accumulated audio to disk
        if (audioChunks.length > 0) {
          const fullAudio = Buffer.concat(audioChunks);
          saveAudio(fullAudio, capturedSessionId, capturedStreamId).then((path) => {
            ctx?.log.info(`Audio saved: ${path} (${(fullAudio.length / 1024).toFixed(1)}KB)`);
          }).catch((err) => {
            ctx?.log.error(`Failed to save audio: ${err.message}`);
          });
        }
      },
    });

    try {
      await currentStream.connect();
      isSpeaking = true;
      ctx?.emit('voice.stream_start', {
        streamId: currentStreamId,
        sessionId: currentSessionId,
      });
      ctx?.log.info(`Streaming TTS started (stream=${currentStreamId})`);
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Connection failed';
      fileLog('ERROR', `Failed to start stream: ${msg}`);
      ctx?.log.error(`Failed to start stream: ${msg}`);
      ctx?.emit('voice.error', { error: msg });
      currentStream = null;
      currentChunker = null;
    }
  }

  function feedStreamingText(text: string): void {
    if (!currentStream?.isOpen || !currentChunker) return;

    const sentences = currentChunker.feed(text);
    for (const sentence of sentences) {
      const cleaned = cleanForSpeech(sentence);
      if (cleaned) {
        fileLog('INFO', `sendText: "${cleaned.substring(0, 80)}${cleaned.length > 80 ? '...' : ''}"`);
        currentStream.sendText(cleaned);
      }
    }
  }

  async function endStream(): Promise<void> {
    if (!currentStream || !currentChunker) return;

    const streamId = currentStreamId;
    const sessionId = currentSessionId;

    // Flush any remaining text in the chunker
    const remaining = currentChunker.flush();
    if (remaining) {
      const cleaned = cleanForSpeech(remaining);
      if (cleaned) {
        fileLog('INFO', `endStream: flushing remaining text: "${cleaned.substring(0, 80)}"`);
        currentStream.sendText(cleaned);
      }
    }

    // Flush EL's internal buffer then send EOS and wait for isFinal
    currentStream.flush();
    fileLog('INFO', `endStream: awaiting graceful close (stream=${streamId})`);
    await currentStream.close();
    fileLog('INFO', `endStream: close resolved (stream=${streamId})`);

    ctx?.emit('voice.stream_end', {
      streamId,
      sessionId,
    });
    ctx?.log.info(`Streaming TTS ended (stream=${streamId})`);

    // Reset streaming state
    isSpeaking = false;
    currentStream = null;
    currentChunker = null;
    currentStreamId = null;
  }

  function abortStream(): void {
    if (!currentStream) return;

    const streamId = currentStreamId;
    currentStream.abort();
    ctx?.emit('voice.stream_end', {
      streamId,
      sessionId: currentSessionId,
      aborted: true,
    });
    ctx?.log.info(`Streaming TTS aborted (stream=${streamId})`);

    isSpeaking = false;
    currentStream = null;
    currentChunker = null;
    currentStreamId = null;
  }

  // --- Batch TTS (for voice.speak method) ---

  async function speakBatch(text: string): Promise<void> {
    if (!cfg.apiKey) {
      throw new Error('No ELEVENLABS_API_KEY configured');
    }

    if (!text.trim()) return;

    isSpeaking = true;
    ctx?.emit('voice.speaking', { text: text.substring(0, 100) });

    try {
      const audioBuffer = await batchSpeak(text, cfg);
      const base64Audio = audioBuffer.toString('base64');
      ctx?.emit('voice.audio', {
        format: 'mp3',
        data: base64Audio,
        text: text.substring(0, 100),
      });
      ctx?.emit('voice.done', { text: text.substring(0, 100) });
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      ctx?.log.error(`Batch TTS error: ${errorMsg}`);
      ctx?.emit('voice.error', { error: errorMsg });
      throw error;
    } finally {
      isSpeaking = false;
    }
  }

  // ============================================================================
  // Extension Implementation
  // ============================================================================

  return {
    id: 'voice',
    name: 'Voice (TTS)',
    methods: ['voice.speak', 'voice.stop', 'voice.status', 'voice.replay', 'voice.health-check'],
    events: [
      'voice.speaking', 'voice.done', 'voice.audio', 'voice.error', // batch compat
      'voice.stream_start', 'voice.audio_chunk', 'voice.stream_end', // streaming
    ],

    async start(context: ExtensionContext) {
      ctx = context;
      fileLog('INFO', `Voice extension starting (autoSpeak=${cfg.autoSpeak}, streaming=${cfg.streaming}, apiKey=${!!cfg.apiKey}, voice=${cfg.voiceId})`);
      ctx.log.info('Starting voice extension...');

      if (!cfg.apiKey) {
        ctx.log.warn('No ELEVENLABS_API_KEY - TTS will not work');
      } else {
        ctx.log.info(`ElevenLabs configured (voice=${cfg.voiceId}, streaming=${cfg.streaming})`);
      }

      // --- Event Subscriptions ---

      // Track content block type and per-request voice preference
      unsubscribers.push(
        ctx.on('session.content_block_start', (event: GatewayEvent) => {
          const payload = event.payload as {
            content_block?: { type: string };
            speakResponse?: boolean;
            sessionId?: string;
          };
          currentBlockType = payload.content_block?.type || null;

          if (payload.speakResponse !== undefined) {
            currentRequestWantsVoice = payload.speakResponse;
          }

          fileLog('INFO', `content_block_start: type=${currentBlockType}, speakResponse=${payload.speakResponse}, shouldSpeak=${shouldSpeak()}, streaming=${cfg.streaming}`);

          if (currentBlockType === 'text') {
            textBuffer = '';

            // Start streaming if enabled and voice is requested
            if (cfg.streaming && shouldSpeak() && cfg.apiKey) {
              const sessionId = payload.sessionId || event.sessionId || 'unknown';
              startStream(sessionId);
            }
          }
        })
      );

      // Process text deltas
      unsubscribers.push(
        ctx.on('session.content_block_delta', (event: GatewayEvent) => {
          if (currentBlockType !== 'text') return;

          const payload = event.payload as {
            delta?: { type: string; text?: string };
            speakResponse?: boolean;
          };

          if (payload.speakResponse !== undefined) {
            currentRequestWantsVoice = payload.speakResponse;
          }

          if (payload.delta?.type === 'text_delta' && payload.delta.text) {
            const deltaText = payload.delta.text;
            textBuffer += deltaText;

            // Stream text to ElevenLabs in real-time
            if (cfg.streaming && currentStream?.isOpen) {
              feedStreamingText(deltaText);
            }
          }
        })
      );

      // On message complete
      unsubscribers.push(
        ctx.on('session.message_stop', async (event: GatewayEvent) => {
          fileLog('INFO', `message_stop: streaming=${cfg.streaming}, hasStream=${!!currentStream}, textBuffer=${textBuffer.length} chars, shouldSpeak=${shouldSpeak()}`);
          const payload = event.payload as { speakResponse?: boolean };
          if (payload.speakResponse !== undefined) {
            currentRequestWantsVoice = payload.speakResponse || currentRequestWantsVoice;
          }

          if (cfg.streaming && currentStream) {
            // End the streaming session
            await endStream();
          } else if (!cfg.streaming && textBuffer && shouldSpeak()) {
            // Batch mode fallback: speak accumulated text
            const cleaned = cleanForSpeech(textBuffer);
            if (cleaned) {
              await speakBatch(cleaned);
            }
          }

          // Reset for next request
          textBuffer = '';
          currentBlockType = null;
          currentRequestWantsVoice = false;
        })
      );

      ctx.log.info('Voice extension started');
    },

    async stop() {
      ctx?.log.info('Stopping voice extension...');

      // Abort any active stream
      abortStream();

      for (const unsub of unsubscribers) {
        unsub();
      }
      unsubscribers = [];
      ctx = null;
    },

    async handleMethod(method: string, params: Record<string, unknown>) {
      switch (method) {
        case 'voice.speak': {
          const text = params.text as string;
          if (!text) throw new Error('Missing "text" parameter');
          const cleaned = cleanForSpeech(text);
          await speakBatch(cleaned);
          return { ok: true };
        }

        case 'voice.stop': {
          abortStream();
          return { ok: true };
        }

        case 'voice.status': {
          return {
            speaking: isSpeaking,
            streaming: cfg.streaming,
            activeStream: currentStreamId,
            autoSpeak: cfg.autoSpeak,
            voiceId: cfg.voiceId,
            model: cfg.model,
          };
        }

        case 'voice.replay': {
          const sessionId = params.sessionId as string;
          const streamId = params.streamId as string;
          if (!sessionId || !streamId) throw new Error('Missing sessionId or streamId');

          const path = getAudioPath(sessionId, streamId);
          if (!path) throw new Error('Audio not found');

          const audio = await Bun.file(path).arrayBuffer();
          ctx?.emit('voice.audio', {
            format: 'mp3',
            data: Buffer.from(audio).toString('base64'),
            streamId,
          });
          return { ok: true };
        }

        case 'voice.health-check': {
          const response: HealthCheckResponse = {
            ok: !!cfg.apiKey,
            status: cfg.apiKey ? 'healthy' : 'disconnected',
            label: 'Voice (ElevenLabs)',
            metrics: [
              { label: 'Auto-Speak', value: cfg.autoSpeak ? 'on' : 'off' },
              { label: 'Streaming', value: cfg.streaming ? 'on' : 'off' },
              { label: 'Voice', value: cfg.voiceId },
              { label: 'Model', value: cfg.model },
              { label: 'Speaking', value: isSpeaking ? 'yes' : 'no' },
            ],
          };
          return response;
        }

        default:
          throw new Error(`Unknown method: ${method}`);
      }
    },

    health() {
      return {
        ok: !!cfg.apiKey,
        details: {
          apiKeyConfigured: !!cfg.apiKey,
          streaming: cfg.streaming,
          autoSpeak: cfg.autoSpeak,
          voiceId: cfg.voiceId,
          speaking: isSpeaking,
          activeStream: currentStreamId,
        },
      };
    },
  };
}

export default createVoiceExtension;
