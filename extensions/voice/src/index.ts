/**
 * Claudia Voice Extension
 *
 * Provides TTS (text-to-speech) capabilities using ElevenLabs.
 * Hooks into session events to speak assistant responses.
 *
 * Features:
 * - Auto-speak assistant responses (configurable)
 * - Hybrid TTS strategy: direct speech for short, summarize for long/technical
 * - Manual voice.speak method for CLI/clients
 */

import { ElevenLabsClient } from '@elevenlabs/elevenlabs-js';
import type { ClaudiaExtension, ExtensionContext, GatewayEvent } from '@claudia/shared';

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
}

const DEFAULT_CONFIG: Required<VoiceConfig> = {
  apiKey: process.env.ELEVENLABS_API_KEY || '',
  voiceId: process.env.ELEVENLABS_VOICE_ID || 'EXAVITQu4vr4xnSDxMaL', // Default Sarah voice
  model: 'eleven_turbo_v2_5',
  autoSpeak: false, // Off by default - enable explicitly
  summarizeThreshold: 150, // words
  stability: 0.5,
  similarityBoost: 0.75,
};

// ============================================================================
// Text Processing Utilities
// ============================================================================

/**
 * Check if text needs summarization (is technical/long)
 */
function needsSummarization(text: string, threshold: number): boolean {
  const wordCount = text.split(/\s+/).length;

  return (
    wordCount > threshold ||
    text.includes('```') || // Code blocks
    /\/[\w/]+\.\w+/.test(text) || // File paths
    /https?:\/\//.test(text) || // URLs
    /\d{8,}/.test(text) || // Long numbers/IDs
    (text.match(/^[\s]*[-*\d]+[.)]/gm)?.length || 0) > 3 // Lists with >3 items
  );
}

/**
 * Clean text for speech (strip markdown, emojis, etc.)
 */
function cleanForSpeech(text: string): string {
  return (
    text
      // Remove code blocks entirely
      .replace(/```[\s\S]*?```/g, ' (code block omitted) ')
      // Remove inline code
      .replace(/`[^`]+`/g, '')
      // Remove markdown links, keep text
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
      // Remove markdown emphasis
      .replace(/[*_]{1,2}([^*_]+)[*_]{1,2}/g, '$1')
      // Remove headers
      .replace(/^#{1,6}\s+/gm, '')
      // Remove emojis (basic pattern)
      .replace(
        /[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/gu,
        ''
      )
      // Remove bullet points
      .replace(/^[\s]*[-*•]\s+/gm, '')
      // Collapse multiple spaces/newlines
      .replace(/\s+/g, ' ')
      .trim()
  );
}

// ============================================================================
// Voice Extension
// ============================================================================

export function createVoiceExtension(config: VoiceConfig = {}): ClaudiaExtension {
  const cfg: Required<VoiceConfig> = { ...DEFAULT_CONFIG, ...config };

  let client: ElevenLabsClient | null = null;
  let ctx: ExtensionContext | null = null;
  let unsubscribers: Array<() => void> = [];

  // State for accumulating assistant text
  let currentBlockType: string | null = null;
  let textBuffer = '';
  let isSpeaking = false;

  /**
   * Speak text using ElevenLabs
   */
  async function speak(text: string): Promise<void> {
    if (!client) {
      throw new Error('ElevenLabs client not initialized');
    }

    if (!text.trim()) {
      return;
    }

    isSpeaking = true;
    ctx?.emit('voice.speaking', { text: text.substring(0, 100) });
    ctx?.log.info(`Speaking: "${text.substring(0, 50)}..."`);

    try {
      const audioStream = await client.textToSpeech.convert(cfg.voiceId, {
        text,
        modelId: cfg.model,
        outputFormat: 'mp3_44100_128',
        voiceSettings: {
          stability: cfg.stability,
          similarityBoost: cfg.similarityBoost,
        },
      });

      // Convert stream to buffer
      const chunks: Uint8Array[] = [];
      const reader = audioStream.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
      }

      const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
      const audioBuffer = new Uint8Array(totalLength);
      let offset = 0;
      for (const chunk of chunks) {
        audioBuffer.set(chunk, offset);
        offset += chunk.length;
      }

      // Emit audio data for playback
      // Convert to base64 for easy transport
      const base64Audio = Buffer.from(audioBuffer).toString('base64');
      ctx?.emit('voice.audio', {
        format: 'mp3',
        data: base64Audio,
        text: text.substring(0, 100),
      });

      ctx?.emit('voice.done', { text: text.substring(0, 100) });
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      ctx?.log.error(`TTS error: ${errorMsg}`);
      ctx?.emit('voice.error', { error: errorMsg });
      throw error;
    } finally {
      isSpeaking = false;
    }
  }

  /**
   * Process accumulated text and speak if appropriate
   */
  async function processAndSpeak(): Promise<void> {
    if (!textBuffer.trim() || !cfg.autoSpeak) {
      textBuffer = '';
      return;
    }

    let textToSpeak = textBuffer;
    textBuffer = '';

    // Decide whether to summarize or speak directly
    if (needsSummarization(textToSpeak, cfg.summarizeThreshold)) {
      // TODO: Add Haiku summarization here
      // For now, just clean and truncate
      ctx?.log.info('Text needs summarization (not implemented yet, cleaning instead)');
      textToSpeak = cleanForSpeech(textToSpeak);
      // Truncate if still too long
      const words = textToSpeak.split(/\s+/);
      if (words.length > cfg.summarizeThreshold) {
        textToSpeak = words.slice(0, cfg.summarizeThreshold).join(' ') + '...';
      }
    } else {
      textToSpeak = cleanForSpeech(textToSpeak);
    }

    if (textToSpeak.trim()) {
      await speak(textToSpeak);
    }
  }

  return {
    id: 'voice',
    name: 'Voice (TTS)',
    methods: ['voice.speak', 'voice.stop', 'voice.status'],
    events: ['voice.speaking', 'voice.done', 'voice.audio', 'voice.error'],

    async start(context: ExtensionContext) {
      ctx = context;
      ctx.log.info('Starting voice extension...');

      // Initialize ElevenLabs client
      if (cfg.apiKey) {
        client = new ElevenLabsClient({ apiKey: cfg.apiKey });
        ctx.log.info(`ElevenLabs client initialized with voice: ${cfg.voiceId}`);
      } else {
        ctx.log.warn('No ELEVENLABS_API_KEY - TTS will not work');
      }

      // Subscribe to session events for auto-speak
      if (cfg.autoSpeak) {
        ctx.log.info('Auto-speak enabled, subscribing to session events...');

        // Track content block type
        unsubscribers.push(
          ctx.on('session.content_block_start', (event: GatewayEvent) => {
            const payload = event.payload as { content_block?: { type: string } };
            currentBlockType = payload.content_block?.type || null;
            if (currentBlockType === 'text') {
              textBuffer = '';
            }
          })
        );

        // Accumulate text deltas
        unsubscribers.push(
          ctx.on('session.content_block_delta', (event: GatewayEvent) => {
            if (currentBlockType === 'text') {
              const payload = event.payload as { delta?: { type: string; text?: string } };
              if (payload.delta?.type === 'text_delta' && payload.delta.text) {
                textBuffer += payload.delta.text;
              }
            }
          })
        );

        // On message complete, process and speak
        unsubscribers.push(
          ctx.on('session.message_stop', async () => {
            if (textBuffer) {
              await processAndSpeak();
            }
          })
        );
      }

      ctx.log.info('Voice extension started');
    },

    async stop() {
      ctx?.log.info('Stopping voice extension...');

      // Unsubscribe from all events
      for (const unsub of unsubscribers) {
        unsub();
      }
      unsubscribers = [];

      client = null;
      ctx = null;
    },

    async handleMethod(method: string, params: Record<string, unknown>) {
      switch (method) {
        case 'voice.speak': {
          const text = params.text as string;
          if (!text) {
            throw new Error('Missing "text" parameter');
          }

          // Clean and speak
          const cleanText = cleanForSpeech(text);
          await speak(cleanText);
          return { ok: true };
        }

        case 'voice.stop': {
          // TODO: Implement audio playback cancellation
          return { ok: true };
        }

        case 'voice.status': {
          return {
            speaking: isSpeaking,
            autoSpeak: cfg.autoSpeak,
            voiceId: cfg.voiceId,
            model: cfg.model,
          };
        }

        default:
          throw new Error(`Unknown method: ${method}`);
      }
    },

    health() {
      return {
        ok: !!client,
        details: {
          clientInitialized: !!client,
          autoSpeak: cfg.autoSpeak,
          voiceId: cfg.voiceId,
          speaking: isSpeaking,
        },
      };
    },
  };
}

// Default export for easy importing
export default createVoiceExtension;
