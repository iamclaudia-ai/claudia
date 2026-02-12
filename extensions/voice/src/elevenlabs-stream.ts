/**
 * ElevenLabs WebSocket Streaming
 *
 * Manages a single WebSocket connection to ElevenLabs for real-time
 * text-to-speech streaming. One instance per Claude response turn.
 *
 * Protocol:
 *   1. Connect to wss://api.elevenlabs.io/v1/text-to-speech/{voiceId}/stream-input
 *   2. Send BOS (beginning of stream) with voice settings
 *   3. Send text chunks as they arrive (must end with space)
 *   4. Send flush to force generation of remaining buffered text
 *   5. Send EOS (empty text) to signal end — wait for isFinal before closing
 *   6. Receive base64 audio chunks + isFinal signal
 */

export interface ELStreamOptions {
  apiKey: string;
  voiceId: string;
  model: string;
  outputFormat?: string;
  stability: number;
  similarityBoost: number;
  onAudioChunk: (data: { audio: string; index: number }) => void;
  onError: (error: Error) => void;
  onDone: () => void;
  /** Optional logging function for diagnostics */
  log?: (level: string, msg: string) => void;
}

export class ElevenLabsStream {
  private ws: WebSocket | null = null;
  private chunkIndex = 0;
  private closed = false;
  private connected = false;
  private closeResolve: (() => void) | null = null;

  constructor(private options: ELStreamOptions) {}

  private log(level: string, msg: string): void {
    this.options.log?.(level, `[ELStream] ${msg}`);
  }

  /** Open WebSocket connection to ElevenLabs */
  connect(): Promise<void> {
    const { voiceId, model, outputFormat = 'mp3_44100_128' } = this.options;
    const url = `wss://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream-input?model_id=${model}&output_format=${outputFormat}`;

    this.log('INFO', `Connecting to ${url.replace(/xi_api_key=[^&]+/, 'xi_api_key=***')}`);
    this.ws = new WebSocket(url);

    return new Promise<void>((resolve, reject) => {
      this.ws!.onopen = () => {
        this.log('INFO', 'WebSocket OPEN — sending BOS');
        // Send BOS (beginning of stream) with configuration
        this.ws!.send(
          JSON.stringify({
            text: ' ',
            voice_settings: {
              stability: this.options.stability,
              similarity_boost: this.options.similarityBoost,
            },
            generation_config: {
              chunk_length_schedule: [120, 160, 250, 290],
            },
            xi_api_key: this.options.apiKey,
          })
        );
        this.connected = true;
        resolve();
      };

      this.ws!.onmessage = (event: MessageEvent) => {
        try {
          const data = JSON.parse(typeof event.data === 'string' ? event.data : '{}');

          if (data.audio) {
            this.log('INFO', `Received audio chunk #${this.chunkIndex} (${data.audio.length} b64 chars)`);
            this.options.onAudioChunk({
              audio: data.audio,
              index: this.chunkIndex++,
            });
          }

          if (data.isFinal) {
            this.log('INFO', `Received isFinal — ${this.chunkIndex} total chunks`);
            this.options.onDone();
            // Now we can safely close the WebSocket
            this.cleanup();
          }

          // Log non-audio messages (errors, alignment info, etc.)
          if (!data.audio && !data.isFinal) {
            this.log('DEBUG', `WS message: ${JSON.stringify(data).substring(0, 200)}`);
          }
        } catch {
          this.log('WARN', `Failed to parse WS message: ${String(event.data).substring(0, 100)}`);
        }
      };

      this.ws!.onerror = (event) => {
        this.log('ERROR', `WebSocket error (connected=${this.connected})`);
        const err = new Error('ElevenLabs WebSocket error');
        if (!this.connected) {
          reject(err);
        } else {
          this.options.onError(err);
        }
      };

      this.ws!.onclose = (event) => {
        this.log('INFO', `WebSocket CLOSE (code=${event.code}, reason="${event.reason}", closed=${this.closed})`);
        if (!this.closed && this.connected) {
          // Unexpected close before isFinal — treat as done
          this.log('WARN', 'Unexpected close before isFinal');
          this.options.onDone();
        }
        // Resolve any pending close() promise
        this.closeResolve?.();
        this.closeResolve = null;
      };
    });
  }

  /** Send a text chunk to ElevenLabs for TTS */
  sendText(text: string): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.log('WARN', `sendText called but WS not open (state=${this.ws?.readyState})`);
      return;
    }
    // EL requires text to end with a space for processing
    const normalized = text.endsWith(' ') ? text : text + ' ';
    this.ws.send(JSON.stringify({ text: normalized }));
  }

  /** Flush remaining buffered text to force audio generation */
  flush(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.log('WARN', `flush called but WS not open (state=${this.ws?.readyState})`);
      return;
    }
    this.log('INFO', 'Sending flush');
    this.ws.send(JSON.stringify({ text: ' ', flush: true }));
  }

  /**
   * Gracefully close the stream (send EOS, wait for isFinal).
   * Returns a Promise that resolves when EL sends isFinal or after timeout.
   */
  close(): Promise<void> {
    if (this.closed) return Promise.resolve();
    this.closed = true;

    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.log('WARN', 'close() called but WS not open — cleaning up');
      this.cleanup();
      return Promise.resolve();
    }

    this.log('INFO', 'Sending EOS (empty text) — waiting for isFinal...');
    this.ws.send(JSON.stringify({ text: '' }));

    // Wait for isFinal message or timeout
    return new Promise<void>((resolve) => {
      this.closeResolve = resolve;

      // Safety timeout: if EL never sends isFinal, force close after 10s
      setTimeout(() => {
        if (this.ws) {
          this.log('WARN', 'Timeout waiting for isFinal — force closing');
          this.options.onDone();
          this.cleanup();
        }
      }, 10_000);
    });
  }

  /** Hard-close the stream immediately (for voice.stop / abort) */
  abort(): void {
    this.log('INFO', 'Aborting stream');
    this.closed = true;
    this.cleanup();
  }

  private cleanup(): void {
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        // Ignore close errors
      }
      this.ws = null;
    }
    this.closeResolve?.();
    this.closeResolve = null;
  }

  /** Whether the connection is open */
  get isOpen(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }
}
