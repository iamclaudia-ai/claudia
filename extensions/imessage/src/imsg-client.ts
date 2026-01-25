/**
 * imsg RPC Client
 *
 * Spawns `imsg rpc` and communicates via JSON-RPC 2.0 over stdin/stdout.
 * Optimized for Bun's native subprocess handling.
 */

import { spawn, type Subprocess } from 'bun';
import { EventEmitter } from 'node:events';

// ============================================================================
// Types
// ============================================================================

export interface ImsgRpcError {
  code?: number;
  message?: string;
  data?: unknown;
}

export interface ImsgRpcResponse<T> {
  jsonrpc?: string;
  id?: string | number | null;
  result?: T;
  error?: ImsgRpcError;
  method?: string;
  params?: unknown;
}

export interface ImsgChat {
  id: number;
  identifier: string;
  guid: string;
  name: string | null;
  service: string;
  last_message_at: string;
  participants: string[];
}

export interface ImsgMessage {
  id: number;
  rowid: number;
  chat_id: number;
  guid: string;
  reply_to_guid: string | null;
  sender: string;
  is_from_me: boolean;
  text: string | null;
  created_at: string;
  chat_identifier: string;
  chat_guid: string;
  participants: string[];
  attachments?: ImsgAttachment[];
  reactions?: ImsgReaction[];
  is_group: boolean;
}

export interface ImsgAttachment {
  filename: string;
  transfer_name: string;
  uti: string;
  mime_type: string;
  total_bytes: number;
  is_sticker: boolean;
  original_path: string;
  missing: boolean;
}

export interface ImsgReaction {
  sender: string;
  type: string;
  is_from_me: boolean;
}

export interface ImsgClientOptions {
  /** Path to imsg CLI (default: "imsg") */
  cliPath?: string;
  /** Path to Messages database */
  dbPath?: string;
  /** Callback for new message notifications */
  onMessage?: (message: ImsgMessage) => void;
  /** Callback for errors */
  onError?: (error: Error) => void;
  /** Logging functions */
  log?: {
    info(msg: string, ...args: unknown[]): void;
    warn(msg: string, ...args: unknown[]): void;
    error(msg: string, ...args: unknown[]): void;
  };
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer?: Timer;
}

// ============================================================================
// ImsgRpcClient
// ============================================================================

export class ImsgRpcClient extends EventEmitter {
  private readonly cliPath: string;
  private readonly dbPath?: string;
  private readonly log: ImsgClientOptions['log'];
  private readonly onMessage?: (message: ImsgMessage) => void;
  private readonly onError?: (error: Error) => void;

  private proc: Subprocess<'pipe', 'pipe', 'pipe'> | null = null;
  private pending = new Map<string, PendingRequest>();
  private nextId = 1;
  private subscriptionId: number | null = null;
  private stdoutReader: ReadableStreamDefaultReader<Uint8Array> | null = null;

  constructor(opts: ImsgClientOptions = {}) {
    super();
    this.cliPath = opts.cliPath?.trim() || 'imsg';
    this.dbPath = opts.dbPath?.trim();
    this.log = opts.log || console;
    this.onMessage = opts.onMessage;
    this.onError = opts.onError;
  }

  /**
   * Start the imsg rpc process
   */
  async start(): Promise<void> {
    if (this.proc) return;

    const args = ['rpc'];
    if (this.dbPath) {
      args.push('--db', this.dbPath);
    }

    this.log?.info?.(`Starting: ${this.cliPath} ${args.join(' ')}`);

    this.proc = spawn([this.cliPath, ...args], {
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    });

    // Read stdout line by line using Bun's native stream
    this.readStdout();

    // Log stderr
    this.readStderr();

    this.log?.info?.('imsg rpc started');
  }

  /**
   * Read stdout and process lines
   */
  private async readStdout(): Promise<void> {
    if (!this.proc?.stdout) return;

    this.stdoutReader = this.proc.stdout.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await this.stdoutReader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        // Process complete lines
        const lines = buffer.split('\n');
        buffer = lines.pop() || ''; // Keep incomplete line in buffer

        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed) {
            this.handleLine(trimmed);
          }
        }
      }
    } catch (err) {
      // Process ended or was cancelled
      if (String(err).includes('cancelled')) {
        // Normal shutdown
      } else {
        this.log?.error?.(`stdout read error: ${err}`);
      }
    }
  }

  /**
   * Read stderr in the background
   */
  private async readStderr(): Promise<void> {
    if (!this.proc?.stderr) return;

    const reader = this.proc.stderr.getReader();
    const decoder = new TextDecoder();

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const text = decoder.decode(value);
        for (const line of text.split('\n')) {
          if (line.trim()) {
            this.log?.error?.(`imsg stderr: ${line.trim()}`);
          }
        }
      }
    } catch {
      // Process ended
    }
  }

  /**
   * Stop the imsg rpc process
   */
  async stop(): Promise<void> {
    if (!this.proc) return;

    // Unsubscribe from watch if active
    if (this.subscriptionId !== null) {
      try {
        await this.unsubscribe();
      } catch {
        // Ignore errors during shutdown
      }
    }

    // Cancel the stdout reader
    this.stdoutReader?.cancel();
    this.stdoutReader = null;

    // Close stdin to signal EOF
    this.proc.stdin.end();

    // Wait a bit then kill if needed
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        if (this.proc && !this.proc.killed) {
          this.proc.kill();
        }
        resolve();
      }, 500);

      this.proc?.exited.then(() => {
        clearTimeout(timeout);
        resolve();
      });
    });

    this.proc = null;
    this.failAll(new Error('imsg rpc stopped'));
    this.log?.info?.('imsg rpc stopped');
  }

  /**
   * Send a JSON-RPC request and wait for response
   */
  async request<T = unknown>(
    method: string,
    params?: Record<string, unknown>,
    opts?: { timeoutMs?: number }
  ): Promise<T> {
    if (!this.proc || !this.proc.stdin) {
      throw new Error('imsg rpc not running');
    }

    const id = this.nextId++;
    const payload = {
      jsonrpc: '2.0',
      id,
      method,
      params: params ?? {},
    };

    const line = JSON.stringify(payload) + '\n';
    const timeoutMs = opts?.timeoutMs ?? 10_000;

    const response = new Promise<T>((resolve, reject) => {
      const key = String(id);
      const timer =
        timeoutMs > 0
          ? setTimeout(() => {
              this.pending.delete(key);
              reject(new Error(`imsg rpc timeout (${method})`));
            }, timeoutMs)
          : undefined;

      this.pending.set(key, {
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      });
    });

    this.proc.stdin.write(line);
    return await response;
  }

  /**
   * List recent chats
   */
  async listChats(limit = 20): Promise<ImsgChat[]> {
    const result = await this.request<{ chats: ImsgChat[] }>('chats.list', { limit });
    return result.chats;
  }

  /**
   * Get message history for a chat
   */
  async getHistory(chatId: number, limit = 50, attachments = false): Promise<ImsgMessage[]> {
    const result = await this.request<{ messages: ImsgMessage[] }>('messages.history', {
      chat_id: chatId,
      limit,
      attachments,
    });
    return result.messages;
  }

  /**
   * Subscribe to new messages
   */
  async subscribe(opts: {
    chatId?: number;
    sinceRowId?: number;
    attachments?: boolean;
  } = {}): Promise<number> {
    const result = await this.request<{ subscription: number }>('watch.subscribe', {
      chat_id: opts.chatId,
      since_rowid: opts.sinceRowId,
      attachments: opts.attachments ?? false,
    });
    this.subscriptionId = result.subscription;
    return result.subscription;
  }

  /**
   * Unsubscribe from watch
   */
  async unsubscribe(): Promise<void> {
    if (this.subscriptionId === null) return;
    await this.request('watch.unsubscribe', { subscription: this.subscriptionId });
    this.subscriptionId = null;
  }

  /**
   * Send a message
   */
  async send(opts: {
    to?: string;
    chatId?: number;
    text?: string;
    file?: string;
    service?: 'imessage' | 'sms' | 'auto';
  }): Promise<void> {
    await this.request('send', {
      to: opts.to,
      chat_id: opts.chatId,
      text: opts.text,
      file: opts.file,
      service: opts.service ?? 'auto',
    });
  }

  /**
   * Handle a line of JSON-RPC output
   */
  private handleLine(line: string): void {
    let parsed: ImsgRpcResponse<unknown>;
    try {
      parsed = JSON.parse(line);
    } catch (err) {
      this.log?.error?.(`imsg rpc: failed to parse: ${line}`);
      return;
    }

    // Response to a request (has id)
    if (parsed.id !== undefined && parsed.id !== null) {
      const key = String(parsed.id);
      const pending = this.pending.get(key);
      if (!pending) return;

      if (pending.timer) clearTimeout(pending.timer);
      this.pending.delete(key);

      if (parsed.error) {
        const msg = parsed.error.message ?? 'imsg rpc error';
        const details = parsed.error.data ? `: ${JSON.stringify(parsed.error.data)}` : '';
        pending.reject(new Error(`${msg}${details}`));
        return;
      }

      pending.resolve(parsed.result);
      return;
    }

    // Notification (no id, has method)
    if (parsed.method) {
      this.handleNotification(parsed.method, parsed.params);
    }
  }

  /**
   * Handle a JSON-RPC notification
   */
  private handleNotification(method: string, params: unknown): void {
    if (method === 'message') {
      const data = params as { subscription: number; message: ImsgMessage };
      this.emit('message', data.message);
      this.onMessage?.(data.message);
    } else if (method === 'error') {
      const data = params as { subscription: number; error: { message: string } };
      const err = new Error(data.error?.message || 'Unknown error');
      this.emit('error', err);
      this.onError?.(err);
    }
  }

  /**
   * Fail all pending requests
   */
  private failAll(err: Error): void {
    for (const [key, pending] of this.pending.entries()) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(err);
      this.pending.delete(key);
    }
  }
}
