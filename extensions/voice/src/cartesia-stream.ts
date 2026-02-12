/**
 * Cartesia WebSocket Streaming
 *
 * Manages WebSocket connection to Cartesia Sonic 3.0 for real-time TTS
 * with emotion controls, voice cloning, and ultra-fast streaming.
 *
 * Features:
 * - Sonic 3.0 model with <200ms latency
 * - 60+ emotion controls (positivity:high, curiosity, etc.)
 * - Laughter support via [laughter] tags
 * - Voice cloning with instant setup
 * - Multiplexed WebSocket connections
 */

export interface CartesiaStreamOptions {
  apiKey: string;
  voiceId: string;
  model?: string;
  outputFormat?: {
    container: string;
    encoding: string;
    sample_rate: number;
  };
  /** Emotion controls like ["positivity:high", "curiosity"] */
  emotions?: string[];
  /** Speed control (0.5-2.0) */
  speed?: number;
  onAudioChunk: (data: { audio: string; index: number }) => void;
  onError: (error: Error) => void;
  onDone: () => void;
  /** Optional logging function for diagnostics */
  log?: (level: string, msg: string) => void;
}

export class CartesiaStream {
  private ws: WebSocket | null = null;
  private chunkIndex = 0;
  private closed = false;
  private connected = false;
  private closeResolve: (() => void) | null = null;
  private streamActive = false;
  private contextId: string | null = null;

  constructor(private options: CartesiaStreamOptions) {}

  private log(level: string, msg: string): void {
    this.options.log?.(level, `[CartesiaStream] ${msg}`);
  }

  /** Open WebSocket connection to Cartesia */
  async connect(): Promise<void> {
    const url = "wss://api.cartesia.ai/tts/websocket";

    this.log("INFO", `Connecting to ${url}`);
    const WebSocketWithHeaders = WebSocket as unknown as {
      new (u: string, opts: { headers: Record<string, string> }): WebSocket;
    };
    this.ws = new WebSocketWithHeaders(url, {
      headers: {
        "Cartesia-Version": "2024-06-30",
        "X-API-Key": this.options.apiKey,
      },
    });

    return new Promise<void>((resolve, reject) => {
      this.ws!.onopen = () => {
        this.log("INFO", "WebSocket OPEN — Cartesia connection established");
        this.connected = true;
        resolve();
      };

      this.ws!.onmessage = (event: MessageEvent) => {
        try {
          const data = JSON.parse(typeof event.data === "string" ? event.data : "{}");

          if (data.type === "chunk" && data.data) {
            this.log("INFO", `Received audio chunk #${this.chunkIndex}`);
            this.options.onAudioChunk({
              audio: data.data, // Base64 encoded audio
              index: this.chunkIndex++,
            });
          }

          if (data.type === "done") {
            this.log(
              "INFO",
              `Sentence complete — ${this.chunkIndex} total chunks (stream still active)`,
            );
            // Note: Don't set streamActive = false here!
            // This is just one sentence finishing, not the entire stream.
            // The stream stays active for more sentences until endStream() is called.
            this.options.onDone();
            // Only resolve endStream() promise if we're explicitly ending
            if (this.closeResolve) {
              this.log("INFO", "Stream ending - resolving close promise");
              this.streamActive = false;
              this.closeResolve();
              this.closeResolve = null;
            }
          }

          if (data.type === "error") {
            this.log("ERROR", `Cartesia error: ${data.error?.message || "Unknown error"}`);
            this.options.onError(new Error(data.error?.message || "Cartesia WebSocket error"));
          }

          // Log other message types for debugging
          if (!["chunk", "done"].includes(data.type)) {
            this.log("INFO", `WS message: ${JSON.stringify(data).substring(0, 400)}`);
          }
        } catch {
          this.log("WARN", `Failed to parse WS message: ${String(event.data).substring(0, 100)}`);
        }
      };

      this.ws!.onerror = () => {
        this.log("ERROR", `WebSocket error (connected=${this.connected})`);
        const err = new Error("Cartesia WebSocket error");
        if (!this.connected) {
          reject(err);
        } else {
          this.options.onError(err);
        }
      };

      this.ws!.onclose = (event) => {
        this.log(
          "INFO",
          `WebSocket CLOSE (code=${event.code}, reason="${event.reason}", closed=${this.closed})`,
        );
        if (!this.closed && this.connected) {
          // Unexpected close before done — treat as completed
          this.log("WARN", "Unexpected close before done message");
          this.options.onDone();
        }
        // Resolve any pending close() promise
        this.closeResolve?.();
        this.closeResolve = null;
      };
    });
  }

  /** Start a new stream session */
  startStream(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.log("WARN", `startStream called but WS not open (state=${this.ws?.readyState})`);
      return;
    }

    if (this.streamActive) {
      this.log("WARN", "Stream already active, call endStream() first");
      return;
    }

    this.log("INFO", "Starting new stream session with Sonic 3.0");
    this.chunkIndex = 0;
    this.streamActive = true;
    this.contextId = crypto.randomUUID();
  }

  /** Send text for TTS generation */
  sendText(text: string): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.log("WARN", `sendText called but WS not open (state=${this.ws?.readyState})`);
      return;
    }
    if (!this.streamActive) {
      this.log("WARN", "sendText called but no active stream, call startStream() first");
      return;
    }

    const request = {
      model_id: this.options.model || "sonic-3",
      transcript: text,
      voice: this.buildVoiceConfig(),
      output_format: this.options.outputFormat || {
        container: "raw",
        encoding: "pcm_s16le",
        sample_rate: 24000,
      },
      context_id: this.contextId,
    };

    this.log("INFO", `📢 SENDING TO CARTESIA (${text.length} chars): "${text}"`);
    this.ws.send(JSON.stringify(request));
  }

  /** Build voice configuration with emotion controls */
  private buildVoiceConfig() {
    const voiceConfig: any = {
      mode: "id",
      id: this.options.voiceId,
    };

    // Add experimental controls for emotions and speed
    if (this.options.emotions?.length || this.options.speed) {
      voiceConfig.__experimental_controls = {};

      if (this.options.emotions?.length) {
        voiceConfig.__experimental_controls.emotion = this.options.emotions;
      }

      if (this.options.speed && this.options.speed !== 1.0) {
        voiceConfig.__experimental_controls.speed = this.options.speed;
      }
    }

    return voiceConfig;
  }

  /** End the current stream session */
  endStream(): Promise<void> {
    if (!this.streamActive) return Promise.resolve();

    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.log("WARN", "endStream() called but WS not open");
      this.streamActive = false;
      return Promise.resolve();
    }

    this.log("INFO", "Ending stream session — waiting for done message...");

    // Cartesia automatically ends when transcript is complete
    // Just wait for the 'done' message
    return new Promise<void>((resolve) => {
      this.closeResolve = resolve;

      // Safety timeout: if Cartesia never sends done, force end after 10s
      setTimeout(() => {
        if (this.streamActive) {
          this.log("WARN", "Timeout waiting for done message — force ending stream");
          this.streamActive = false;
          this.options.onDone();
          resolve();
        }
      }, 10_000);
    });
  }

  /**
   * Gracefully close the connection.
   */
  close(): Promise<void> {
    if (this.closed) return Promise.resolve();
    this.closed = true;

    this.log("INFO", "Closing Cartesia connection");
    this.cleanup();
    return Promise.resolve();
  }

  /** Hard-close the stream immediately (for voice.stop / abort) */
  abort(): void {
    this.log("INFO", "Aborting stream");
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
