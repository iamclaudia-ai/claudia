/**
 * Claudia Voice Extension
 *
 * Provides TTS (text-to-speech) capabilities using Cartesia Sonic 3.0.
 * Hooks into session events to speak assistant responses in real-time.
 *
 * Features:
 * - Real-time streaming TTS via Cartesia WebSocket API
 * - Ultra-fast <200ms latency with Sonic 3.0
 * - Emotion controls and voice cloning support
 * - Sentence-level chunking for low-latency speech
 * - Auto-speak assistant responses (configurable)
 * - Audio saving for future playback
 */

import type { ClaudiaExtension, ExtensionContext, GatewayEvent, HealthCheckResponse } from '@claudia/shared';
import { existsSync, mkdirSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { CartesiaStream } from './cartesia-stream';
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
  /** Cartesia API key */
  apiKey?: string;
  /** Voice ID to use */
  voiceId?: string;
  /** Model to use (default: sonic-3) */
  model?: string;
  /** Auto-speak assistant responses */
  autoSpeak?: boolean;
  /** Word count threshold for summarization */
  summarizeThreshold?: number;
  /** Emotion controls like ["positivity:high", "curiosity"] */
  emotions?: string[];
  /** Speed control (0.5-2.0) */
  speed?: number;
  /** Use streaming WebSocket (true) or batch REST API (false) */
  streaming?: boolean;
}

const DEFAULT_CONFIG: Required<VoiceConfig> = {
  apiKey: process.env.CARTESIA_API_KEY || '',
  voiceId: process.env.CARTESIA_VOICE_ID || 'a0e99841-438c-4a64-b679-ae501e7d6091', // Barbershop - Man
  model: 'sonic-3',
  autoSpeak: false,
  summarizeThreshold: 150,
  emotions: ['positivity:high', 'curiosity'],
  speed: 1.0,
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
      // Remove code blocks entirely (including language specifiers)
      .replace(/```[\s\S]*?```/g, '')
      .replace(/~~~[\s\S]*?~~~/g, '')
      // Remove inline code
      .replace(/`[^`\n]*`/g, '')
      // Remove HTML/XML tags
      .replace(/<[^>]+>/g, '')
      // Remove markdown links, keep text
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
      // Remove reference-style links
      .replace(/\[([^\]]+)\]\[[^\]]*\]/g, '$1')
      // Remove markdown emphasis
      .replace(/[*_]{1,2}([^*_]+)[*_]{1,2}/g, '$1')
      // Remove headers
      .replace(/^#{1,6}\s+/gm, '')
      // Remove strikethrough
      .replace(/~~([^~]+)~~/g, '$1')
      // Remove blockquotes (often contain code/technical content)
      .replace(/^>\s+.*$/gm, '')
      // Remove horizontal rules
      .replace(/^[-*_]{3,}$/gm, '')
      // Remove table syntax
      .replace(/\|.*\|/g, '')
      // Remove emojis
      .replace(
        /[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/gu,
        ''
      )
      // Remove entire list lines (bullets and numbered lists — typically technical)
      .replace(/^[\s]*[-*•]\s+.*$/gm, '')
      .replace(/^[\s]*\d+[.)]\s+.*$/gm, '')
      // Remove URLs (often technical/not worth reading aloud)
      .replace(/https?:\/\/[^\s]+/g, '')
      // Remove file paths and technical identifiers
      .replace(/[a-zA-Z_][a-zA-Z0-9_]*\.[a-zA-Z_][a-zA-Z0-9_]*[:][0-9]+/g, '')
      // Collapse multiple spaces/newlines
      .replace(/\s+/g, ' ')
      .trim()
  );
}

// ============================================================================
// Batch TTS (fallback, used for voice.speak method)
// ============================================================================

const CARTESIA_API_BASE = 'https://api.cartesia.ai';

async function batchSpeak(
  text: string,
  cfg: Required<VoiceConfig>,
): Promise<Buffer> {
  const voiceConfig: any = {
    mode: 'id',
    id: cfg.voiceId,
  };

  // Add experimental controls for emotions and speed
  if (cfg.emotions?.length || cfg.speed !== 1.0) {
    voiceConfig.__experimental_controls = {};

    if (cfg.emotions?.length) {
      voiceConfig.__experimental_controls.emotion = cfg.emotions;
    }

    if (cfg.speed !== 1.0) {
      voiceConfig.__experimental_controls.speed = cfg.speed;
    }
  }

  const res = await fetch(`${CARTESIA_API_BASE}/tts/bytes`, {
    method: 'POST',
    headers: {
      'Cartesia-Version': '2024-06-30',
      'X-API-Key': cfg.apiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model_id: cfg.model,
      transcript: text,
      voice: voiceConfig,
      output_format: {
        container: 'wav',
        encoding: 'pcm_s16le',
        sample_rate: 24000
      }
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Cartesia API error ${res.status}: ${body}`);
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

  // --- Persistent connection with auto-reconnection on context closure ---
  let persistentStream: CartesiaStream | null = null;

  // --- Streaming state (per response turn) ---
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

  /** Ensure persistent connection is ready, recreate if needed */
  async function ensurePersistentConnection(): Promise<void> {
    if (!cfg.apiKey) {
      throw new Error('No API key configured');
    }

    if (persistentStream?.isOpen) {
      return; // Already connected
    }

    fileLog('INFO', 'Creating persistent Cartesia connection');

    // Create fresh connection if needed
    persistentStream = new CartesiaStream({
      apiKey: cfg.apiKey,
      voiceId: cfg.voiceId,
      model: cfg.model,
      emotions: cfg.emotions,
      speed: cfg.speed,
      log: fileLog,
      onAudioChunk: ({ audio, index }) => {
        if (!currentStreamId) return;
        fileLog('INFO', `onAudioChunk: stream=${currentStreamId}, index=${index}, size=${audio.length} b64chars`);

        // Forward audio chunk to clients
        ctx?.emit('voice.audio_chunk', {
          audio,
          index,
          streamId: currentStreamId,
          sessionId: currentSessionId,
        });

        // Accumulate for saving if we have active stream
        if (currentStreamId && currentAudioChunks) {
          currentAudioChunks.push(Buffer.from(audio, 'base64'));
        }
      },
      onError: (error) => {
        fileLog('ERROR', `Persistent Cartesia stream error: ${error.message}`);

        // Check for context closure error and handle it
        if (error.message.includes('Context has closed') || error.message.includes('Context closed')) {
          fileLog('WARN', 'Cartesia context closed - will recreate connection on next sentence');
          // Close and nullify the current stream so it gets recreated
          if (persistentStream) {
            persistentStream.close().catch(() => {});
            persistentStream = null;
          }
        }

        if (currentStreamId) {
          ctx?.emit('voice.error', { error: error.message, streamId: currentStreamId });
        }
      },
      onDone: () => {
        fileLog('INFO', `Sentence completed: stream=${currentStreamId}, ${currentAudioChunks?.length || 0} chunks accumulated`);
        // Note: Don't end the stream here! onDone is called after each sentence,
        // not after the entire stream. The stream continues until endStream() is called.
      },
    });

    await persistentStream.connect();
    fileLog('INFO', 'Persistent Cartesia connection established');
  }

  // Current stream audio accumulator (for final save)
  let currentAudioChunks: Buffer[] = [];


  async function startStream(sessionId: string): Promise<void> {
    if (!cfg.apiKey) {
      fileLog('WARN', 'startStream called but no apiKey');
      return;
    }

    // End any active stream session first
    if (currentStreamId && persistentStream) {
      fileLog('WARN', 'startStream: ending existing stream session before starting new one');
      await endStream();
    }

    const streamId = newStreamId();
    currentStreamId = streamId;
    currentSessionId = sessionId;
    currentAudioChunks = [];
    currentChunker = new SentenceChunker();

    fileLog('INFO', `startStream: session=${sessionId}, stream=${streamId} (persistent connection with auto-reconnection)`);

    try {
      // Ensure persistent connection is ready
      await ensurePersistentConnection();

      // Start new stream session on existing connection
      if (persistentStream) {
        persistentStream.startStream();
      }

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
      currentStreamId = null;
      currentSessionId = null;
      currentChunker = null;
    }
  }

  async function feedStreamingText(text: string): Promise<void> {
    if (!currentChunker || !currentStreamId) return;

    fileLog('INFO', `🔤 FEEDING TEXT: "${text}"`);
    const sentences = currentChunker.feed(text);
    for (const sentence of sentences) {
      const cleaned = cleanForSpeech(sentence);
      if (cleaned) {
        fileLog('INFO', `🗣️ SPEAKING SENTENCE: "${cleaned}"`);

        try {
          // Ensure connection is ready (will recreate if context closed)
          await ensurePersistentConnection();

          if (persistentStream?.isOpen) {
            persistentStream.sendText(cleaned);
          }
        } catch (error) {
          fileLog('ERROR', `Failed to send sentence to Cartesia: ${error instanceof Error ? error.message : error}`);
        }
      }
    }
  }

  async function endStream(): Promise<void> {
    if (!persistentStream || !currentChunker || !currentStreamId) return;

    const streamId = currentStreamId;
    const sessionId = currentSessionId;

    // Flush any remaining text in the chunker
    const remaining = currentChunker.flush();
    if (remaining) {
      const cleaned = cleanForSpeech(remaining);
      if (cleaned) {
        fileLog('INFO', `endStream: flushing remaining text: "${cleaned.substring(0, 80)}"`);
        try {
          await ensurePersistentConnection();
          if (persistentStream?.isOpen) {
            persistentStream.sendText(cleaned);
          }
        } catch (error) {
          fileLog('ERROR', `Failed to send final sentence: ${error instanceof Error ? error.message : error}`);
        }
      }
    }

    // End Cartesia stream session and wait for done
    fileLog('INFO', `endStream: awaiting stream session end (stream=${streamId})`);
    if (persistentStream?.isOpen) {
      await persistentStream.endStream();
    }
    fileLog('INFO', `endStream: session ended (stream=${streamId})`);

    ctx?.log.info(`Streaming TTS ended (stream=${streamId})`);

    // Save accumulated audio from all sentences to disk
    if (streamId && sessionId && currentAudioChunks && currentAudioChunks.length > 0) {
      const fullAudio = Buffer.concat(currentAudioChunks);
      saveAudio(fullAudio, sessionId, streamId).then((path) => {
        ctx?.log.info(`Full response audio saved: ${path} (${(fullAudio.length / 1024).toFixed(1)}KB)`);
      }).catch((err) => {
        ctx?.log.error(`Failed to save full audio: ${err.message}`);
      });
    }

    // Signal stream end to clients
    if (streamId) {
      ctx?.emit('voice.stream_end', {
        streamId,
        sessionId,
      });
    }

    // Reset streaming state (but keep persistent connection alive)
    isSpeaking = false;
    currentChunker = null;
    currentStreamId = null;
    currentSessionId = null;
    currentAudioChunks = [];
  }

  function abortStream(): void {
    if (!currentStreamId) return;

    const streamId = currentStreamId;
    fileLog('INFO', `Aborting stream session: ${streamId}`);

    // Signal abort to clients
    ctx?.emit('voice.stream_end', {
      streamId,
      sessionId: currentSessionId,
      aborted: true,
    });
    ctx?.log.info(`Streaming TTS aborted (stream=${streamId})`);

    isSpeaking = false;
    currentChunker = null;
    currentStreamId = null;
    currentSessionId = null;
  }

  // --- Batch TTS (for voice.speak method) ---

  async function speakBatch(text: string): Promise<void> {
    if (!cfg.apiKey) {
      throw new Error('No CARTESIA_API_KEY configured');
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
        ctx.log.warn('No CARTESIA_API_KEY - TTS will not work');
      } else {
        ctx.log.info(`Cartesia configured (voice=${cfg.voiceId}, streaming=${cfg.streaming}, model=${cfg.model})`);
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

            // Stream text to Cartesia in real-time
            if (cfg.streaming && currentStreamId) {
              feedStreamingText(deltaText).catch((err) => {
                fileLog('ERROR', `feedStreamingText error: ${err.message}`);
              });
            }
          }
        })
      );

      // On message complete
      unsubscribers.push(
        ctx.on('session.message_stop', async (event: GatewayEvent) => {
          fileLog('INFO', `message_stop: streaming=${cfg.streaming}, hasActiveStream=${!!currentStreamId}, textBuffer=${textBuffer.length} chars, shouldSpeak=${shouldSpeak()}`);
          const payload = event.payload as { speakResponse?: boolean };
          if (payload.speakResponse !== undefined) {
            currentRequestWantsVoice = payload.speakResponse || currentRequestWantsVoice;
          }

          if (cfg.streaming && currentStreamId) {
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

      // Close persistent connection
      if (persistentStream) {
        fileLog('INFO', 'Closing persistent Cartesia connection');
        await persistentStream.close();
        persistentStream = null;
      }

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
          if (!cfg.apiKey) throw new Error('No CARTESIA_API_KEY configured');
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
            label: 'Voice (Cartesia)',
            metrics: [
              { label: 'Auto-Speak', value: cfg.autoSpeak ? 'on' : 'off' },
              { label: 'Streaming', value: cfg.streaming ? 'on' : 'off' },
              { label: 'Voice', value: cfg.voiceId },
              { label: 'Model', value: cfg.model },
              { label: 'Emotions', value: cfg.emotions?.join(', ') || 'none' },
              { label: 'Speed', value: cfg.speed?.toString() || '1.0' },
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
