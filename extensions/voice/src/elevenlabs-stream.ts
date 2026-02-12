/**
 * ElevenLabs WebSocket Streaming
 *
 * Manages a persistent WebSocket connection to ElevenLabs for real-time
 * text-to-speech streaming. Connection stays open across multiple responses.
 *
 * Protocol:
 *   1. Connect to wss://api.elevenlabs.io/v1/text-to-speech/{voiceId}/stream-input
 *   2. Send BOS with configuration ONCE at connection time
 *   3. For each response: text chunks → flush → EOS (no BOS!)
 *   4. Connection and configuration persist across multiple responses
 *   5. Only close connection when extension stops or error occurs
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
  private firstTextSent = false;
  private streamActive = false;

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
        this.log('INFO', 'WebSocket OPEN — sending BOS configuration');

        // Send BOS (beginning of stream) with configuration - ONCE at connection time
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
            this.streamActive = false;
            this.options.onDone();
            // Resolve any pending endStream() promise
            if (this.closeResolve) {
              this.closeResolve();
              this.closeResolve = null;
            }
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

  /** Start a new stream session on the existing connection */
  startStream(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.log('WARN', `startStream called but WS not open (state=${this.ws?.readyState})`);
      return;
    }

    if (this.streamActive) {
      this.log('WARN', 'Stream already active, call endStream() first');
      return;
    }

    this.log('INFO', 'Starting new stream session — ready for text');
    this.chunkIndex = 0;
    this.streamActive = true;

    // No BOS here! Connection already configured.
    // Just mark session as active and ready to receive text.
  }

  /** Send a text chunk to ElevenLabs for TTS */
  sendText(text: string): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.log('WARN', `sendText called but WS not open (state=${this.ws?.readyState})`);
      return;
    }
    if (!this.streamActive) {
      this.log('WARN', 'sendText called but no active stream, call startStream() first');
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
    if (!this.streamActive) {
      this.log('WARN', 'flush called but no active stream');
      return;
    }
    this.log('INFO', 'Sending flush');
    this.ws.send(JSON.stringify({ text: ' ', flush: true }));
  }

  /**
   * End the current stream session (send EOS, wait for isFinal).
   * Connection stays open for next stream.
   */
  endStream(): Promise<void> {
    if (!this.streamActive) return Promise.resolve();

    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.log('WARN', 'endStream() called but WS not open');
      this.streamActive = false;
      return Promise.resolve();
    }

    this.log('INFO', 'Ending stream session — sending EOS, waiting for isFinal...');
    this.ws.send(JSON.stringify({ text: '' }));

    // Wait for isFinal message or timeout
    return new Promise<void>((resolve) => {
      this.closeResolve = resolve;

      // Safety timeout: if EL never sends isFinal, force end after 10s
      setTimeout(() => {
        if (this.streamActive) {
          this.log('WARN', 'Timeout waiting for isFinal — force ending stream');
          this.streamActive = false;
          this.options.onDone();
          resolve();
        }
      }, 10_000);
    });
  }

  /**
   * Gracefully close the persistent connection.
   * Should only be called when extension is stopping.
   */
  close(): Promise<void> {
    if (this.closed) return Promise.resolve();
    this.closed = true;

    this.log('INFO', 'Closing persistent connection');
    this.cleanup();
    return Promise.resolve();
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
