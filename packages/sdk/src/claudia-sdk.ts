/**
 * Claudia SDK - Agent SDK-like interface over Claude Code (Headless Mode)
 *
 * Architecture:
 * - Spawns Claude CLI in headless mode (--input-format stream-json)
 * - HTTP proxy intercepts API calls to capture SSE events and inject config
 * - Persistent process - stays alive for multiple prompts
 * - All streaming events come through proxy
 *
 * Usage:
 *   const session = await createSession({ systemPrompt: "...", thinking: true });
 *
 *   // Start event loop (runs until session closes)
 *   (async () => {
 *     for await (const event of session.events()) {
 *       console.log(event);
 *     }
 *   })();
 *
 *   // Send prompts anytime
 *   await session.prompt("Hello!");
 *   await session.prompt("Follow up question...");
 *
 *   // Cleanup
 *   await session.close();
 */

import { spawn, type Subprocess, type FileSink } from "bun";
import {
  createServer,
  type Server,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import fs from "node:fs";

// ============ TYPES ============

export interface SessionOptions {
  /** System prompt for Claude (sent with first prompt) */
  systemPrompt?: string;
  /** Model to use (defaults to claude-sonnet-4-20250514) */
  model?: string;
  /** Working directory for Claude */
  cwd?: string;
  /** Base port for proxy (will find available port starting here) */
  basePort?: number;
  /** Resume an existing session by UUID */
  resume?: string;
  /** Log API events to file for debugging */
  logEvents?: string;
  /** Enable extended thinking mode */
  thinking?: boolean;
  /** Budget tokens for thinking (defaults to 10000) */
  thinkingBudget?: number;
}

export interface StreamEvent {
  type: string;
  [key: string]: any;
}

// ============ CONSTANTS ============

const ANTHROPIC_API = "https://api.anthropic.com";
const DEFAULT_MODEL = "claude-sonnet-4-20250514";
const DEFAULT_BASE_PORT = 9000;

// ============ SESSION CLASS ============

export class ClaudiaSession extends EventEmitter {
  readonly id: string;

  private options: SessionOptions;
  private proxyPort: number;
  private proxyServer: Server | null = null;
  private proc: Subprocess | null = null;
  private stdin: FileSink | null = null;
  private isStarted = false;
  private isFirstPrompt = true;
  private isClosed = false;

  // Abort tracking - track open blocks to emit synthetic stops
  private messageOpen = false;
  private openBlockIndices = new Set<number>();

  constructor(options: SessionOptions = {}) {
    super();
    this.id = options.resume || randomUUID();
    this.options = {
      model: DEFAULT_MODEL,
      basePort: DEFAULT_BASE_PORT,
      ...options,
    };
    this.proxyPort = this.derivePort(this.id);
  }

  /**
   * Derive a deterministic port from session ID
   */
  private derivePort(sessionId: string): number {
    const hash = sessionId
      .split("")
      .reduce((acc, c) => acc + c.charCodeAt(0), 0);
    const range = 1000;
    return (this.options.basePort || DEFAULT_BASE_PORT) + (hash % range);
  }

  /**
   * Start the session - spawns proxy server
   */
  async start(): Promise<void> {
    if (this.isStarted) {
      throw new Error("Session already started");
    }

    this.proxyPort = await this.startProxy();

    if (this.options.resume) {
      this.isFirstPrompt = false;
    }

    this.isStarted = true;
    this.isClosed = false;
    this.emit("ready", { sessionId: this.id, proxyPort: this.proxyPort });
  }

  /**
   * Ensure Claude process is running, start if needed
   */
  private ensureProcess(): void {
    if (this.proc && this.stdin) {
      return; // Already running
    }

    if (this.isClosed) {
      // Reopen if closed
      this.isClosed = false;
    }

    const systemPrompt = this.options.systemPrompt
      ? this.options.systemPrompt +
        "\n\nIMPORTANT: You are running in headless/non-interactive mode. Do NOT use the AskUserQuestion tool - make reasonable decisions autonomously instead."
      : undefined;

    const args = [
      "-p",
      "--dangerously-skip-permissions",
      "--model",
      this.options.model!,
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--verbose",
    ];

    if (systemPrompt && this.isFirstPrompt) {
      args.push("--system-prompt", systemPrompt);
    }

    if (this.isFirstPrompt) {
      args.push("--session-id", this.id);
    } else {
      args.push("--resume", this.id);
    }

    if (!this.options.cwd) {
      throw new Error(
        "SessionOptions.cwd is required — never fall back to process.cwd()",
      );
    }

    const cmd = ["claude", ...args];
    console.log(`[SDK] Spawning: ${cmd.join(" ")}`);
    console.log(`[SDK]   cwd: ${this.options.cwd}`);
    console.log(`[SDK]   proxy: http://localhost:${this.proxyPort}`);

    const proc = spawn({
      cmd,
      stdin: "pipe",
      stdout: "ignore",
      stderr: "inherit",
      cwd: this.options.cwd,
      env: {
        ...process.env,
        ANTHROPIC_BASE_URL: `http://localhost:${this.proxyPort}`,
      },
    });

    this.proc = proc;
    this.stdin = proc.stdin as FileSink;

    // Handle process exit
    proc.exited.then(() => {
      this.proc = null;
      this.stdin = null;
      this.emit("process_ended");
    });

    this.emit("process_started");
  }

  /**
   * Send a prompt to Claude
   * Automatically starts process if not running
   * @param content - Either a string for text-only, or an array of content blocks (for images + text)
   */
  prompt(content: string | any[]): void {
    if (!this.isStarted) {
      throw new Error("Session not started - call start() first");
    }

    this.ensureProcess();

    const message = {
      type: "user",
      message: {
        role: "user",
        content,
      },
    };

    this.stdin!.write(JSON.stringify(message) + "\n");
    this.isFirstPrompt = false;
    this.emit("prompt_sent", { content });
  }

  /**
   * Async generator that yields SSE events
   * Runs until session is closed
   */
  async *events(): AsyncGenerator<StreamEvent, void, unknown> {
    const eventQueue: StreamEvent[] = [];

    const sseHandler = (event: StreamEvent) => {
      eventQueue.push(event);

      // Track open message/blocks for abort cleanup
      if (event.type === "message_start") {
        this.messageOpen = true;
        this.openBlockIndices.clear();
      }

      if (
        event.type === "content_block_start" &&
        typeof event.index === "number"
      ) {
        this.openBlockIndices.add(event.index);
      }

      if (
        event.type === "content_block_stop" &&
        typeof event.index === "number"
      ) {
        this.openBlockIndices.delete(event.index);
      }

      if (event.type === "message_stop") {
        this.messageOpen = false;
        this.openBlockIndices.clear();
      }
    };

    this.on("sse", sseHandler);

    try {
      while (!this.isClosed) {
        if (eventQueue.length > 0) {
          yield eventQueue.shift()!;
        } else {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      }

      // Drain remaining events
      while (eventQueue.length > 0) {
        yield eventQueue.shift()!;
      }
    } finally {
      this.removeListener("sse", sseHandler);
    }
  }

  /**
   * Interrupt the current response (kills Claude process)
   * Emits synthetic stop events for any open blocks
   */
  interrupt(): void {
    if (this.proc) {
      // Emit synthetic content_block_stop for each open block
      for (const index of this.openBlockIndices) {
        this.emit("sse", { type: "content_block_stop", index });
      }
      this.openBlockIndices.clear();

      // Emit message_delta with abort stop_reason and message_stop
      if (this.messageOpen) {
        this.emit("sse", {
          type: "message_delta",
          delta: { stop_reason: "abort" },
          usage: { output_tokens: 0 },
        });
        this.emit("sse", { type: "message_stop" });
        this.messageOpen = false;
      }

      this.proc.kill("SIGTERM");
      this.proc = null;
      this.stdin = null;
      this.emit("interrupted");
    }
  }

  /**
   * Close the session - cleanup process and proxy
   */
  async close(): Promise<void> {
    if (!this.isStarted) return;

    this.isClosed = true;

    // Kill Claude process
    if (this.proc) {
      this.proc.kill("SIGTERM");
      this.proc = null;
      this.stdin = null;
    }

    // Stop proxy server
    if (this.proxyServer) {
      await new Promise<void>((resolve) => {
        this.proxyServer!.close(() => resolve());
      });
      this.proxyServer = null;
    }

    this.isStarted = false;
    this.emit("closed");
  }

  /**
   * Check if session is active (started and not closed)
   */
  get isActive(): boolean {
    return this.isStarted && !this.isClosed;
  }

  /**
   * Check if Claude process is currently running
   */
  get isProcessRunning(): boolean {
    return this.proc !== null;
  }

  /**
   * Check if this session was resumed
   */
  get isResumed(): boolean {
    return !!this.options.resume;
  }

  // ============ PRIVATE METHODS ============

  private async startProxy(): Promise<number> {
    return new Promise((resolve, reject) => {
      const targetPort = this.proxyPort;

      const tryPort = (port: number) => {
        const server = createServer(async (req, res) => {
          await this.handleProxyRequest(req, res);
        });

        server.on("error", (err: NodeJS.ErrnoException) => {
          if (err.code === "EADDRINUSE") {
            tryPort(port + 1);
          } else {
            reject(err);
          }
        });

        server.listen(port, () => {
          this.proxyServer = server;
          resolve(port);
        });
      };

      tryPort(targetPort);
    });
  }

  private async handleProxyRequest(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const targetUrl = `${ANTHROPIC_API}${req.url}`;

    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }
    const body = Buffer.concat(chunks);

    let modifiedBody: Buffer | undefined;

    if (req.method === "POST" && body.length > 0) {
      try {
        const requestBody = JSON.parse(body.toString());

        // Inject thinking configuration if enabled
        if (this.options.thinking && req.url?.includes("/v1/messages")) {
          const thinkingBudget = this.options.thinkingBudget || 10000;
          requestBody.max_tokens = thinkingBudget + 8000;
          requestBody.thinking = {
            type: "enabled",
            budget_tokens: thinkingBudget,
          };
          modifiedBody = Buffer.from(JSON.stringify(requestBody));

          if (this.options.logEvents) {
            fs.appendFileSync(
              this.options.logEvents,
              JSON.stringify({
                type: "thinking_injected",
                timestamp: new Date().toISOString(),
                budget_tokens: thinkingBudget,
                max_tokens: requestBody.max_tokens,
              }) + "\n",
            );
          }
        }

        // Emit tool results
        const toolResults = requestBody.messages?.filter(
          (m: any) =>
            m.role === "user" &&
            m.content?.some?.((c: any) => c.type === "tool_result"),
        );
        if (toolResults?.length > 0) {
          const logEntry = {
            type: "request_tool_results",
            timestamp: new Date().toISOString(),
            url: req.url,
            tool_results: toolResults.flatMap((m: any) =>
              m.content
                .filter((c: any) => c.type === "tool_result")
                .map((c: any) => ({
                  tool_use_id: c.tool_use_id,
                  content: c.content?.substring?.(0, 500) || c.content,
                  is_error: c.is_error,
                })),
            ),
          };
          if (this.options.logEvents) {
            fs.appendFileSync(
              this.options.logEvents,
              JSON.stringify(logEntry) + "\n",
            );
          }
          this.emit("sse", logEntry);
        }
      } catch {
        // Not JSON
      }
    }

    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(req.headers)) {
      if (key.toLowerCase() !== "host" && value) {
        const headerValue = Array.isArray(value) ? value[0] : value;
        if (headerValue) headers[key] = headerValue;
      }
    }
    headers["accept-encoding"] = "identity";

    const MAX_RETRIES = 3;
    const RETRYABLE_STATUSES = new Set([429, 503, 529]);

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const response = await fetch(targetUrl, {
          method: req.method || "GET",
          headers,
          body: ["POST", "PUT", "PATCH"].includes(req.method || "")
            ? modifiedBody?.toString() || body.toString()
            : undefined,
        });

        // Retry on transient errors with exponential backoff
        if (RETRYABLE_STATUSES.has(response.status) && attempt < MAX_RETRIES) {
          const delay = Math.min(1000 * Math.pow(2, attempt), 8000);
          const errorBody = await response.text().catch(() => "");
          console.warn(`[${this.id}] API ${response.status} (attempt ${attempt + 1}/${MAX_RETRIES + 1}), retrying in ${delay}ms...`);
          this.emit("sse", {
            type: "api_warning",
            status: response.status,
            attempt: attempt + 1,
            maxRetries: MAX_RETRIES + 1,
            retryInMs: delay,
            message: `API returned ${response.status}, retrying (${attempt + 1}/${MAX_RETRIES + 1})...`,
            body: errorBody.substring(0, 500),
          });
          await new Promise((r) => setTimeout(r, delay));
          continue;
        }

        const contentType = response.headers.get("content-type") || "";
        res.statusCode = response.status;
        response.headers.forEach((value, key) => {
          res.setHeader(key, value);
        });

        // Handle API error responses (non-2xx)
        if (response.status >= 400) {
          const errorBody = await response.text().catch(() => "Unknown error");
          let errorMessage = `API error ${response.status}`;
          let errorDetail: unknown = errorBody;

          try {
            const parsed = JSON.parse(errorBody);
            errorMessage = parsed.error?.message || parsed.message || errorMessage;
            errorDetail = parsed;
          } catch {
            // Not JSON
          }

          console.error(`[${this.id}] API error ${response.status}: ${errorMessage}`);
          this.emit("sse", {
            type: "api_error",
            status: response.status,
            message: errorMessage,
            detail: errorDetail,
          });

          res.end(errorBody);
          return;
        }

        if (contentType.includes("text/event-stream") && response.body) {
          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          let buffer = "";

          const pump = async (): Promise<void> => {
            const { done, value } = await reader.read();

            if (done) {
              if (buffer.trim()) this.processSSE(buffer);
              res.end();
              return;
            }

            const text = decoder.decode(value, { stream: true });
            buffer += text;
            const lines = buffer.split("\n");
            buffer = lines.pop() || "";

            for (const line of lines) {
              this.processSSE(line);
            }

            res.write(value);
            return pump();
          };

          await pump();
        } else {
          const responseBody = await response.arrayBuffer();
          res.end(Buffer.from(responseBody));
        }

        return; // Success — exit retry loop
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);

        if (attempt < MAX_RETRIES) {
          const delay = Math.min(1000 * Math.pow(2, attempt), 8000);
          console.warn(`[${this.id}] Proxy error (attempt ${attempt + 1}/${MAX_RETRIES + 1}): ${errorMessage}, retrying in ${delay}ms...`);
          this.emit("sse", {
            type: "api_warning",
            attempt: attempt + 1,
            maxRetries: MAX_RETRIES + 1,
            retryInMs: delay,
            message: `Connection error: ${errorMessage}, retrying (${attempt + 1}/${MAX_RETRIES + 1})...`,
          });
          await new Promise((r) => setTimeout(r, delay));
          continue;
        }

        console.error(`[${this.id}] Proxy error (all retries exhausted): ${errorMessage}`);
        this.emit("sse", {
          type: "api_error",
          status: 502,
          message: `Connection failed after ${MAX_RETRIES + 1} attempts: ${errorMessage}`,
        });
        res.statusCode = 502;
        res.end("Proxy error");
        return;
      }
    }
  }

  private processSSE(line: string): void {
    if (!line.startsWith("data: ")) return;

    const data = line.slice(6);
    if (data === "[DONE]") return;

    try {
      const event: StreamEvent = JSON.parse(data);

      if (this.options.logEvents) {
        fs.appendFileSync(this.options.logEvents, JSON.stringify(event) + "\n");
      }

      this.emit("sse", event);
    } catch {
      // Not valid JSON
    }
  }
}

// ============ FACTORY FUNCTIONS ============

export async function createSession(
  options?: SessionOptions,
): Promise<ClaudiaSession> {
  const session = new ClaudiaSession(options);
  await session.start();
  return session;
}

export async function resumeSession(
  sessionId: string,
  options?: Omit<SessionOptions, "resume" | "systemPrompt">,
): Promise<ClaudiaSession> {
  const session = new ClaudiaSession({
    ...options,
    resume: sessionId,
  });
  await session.start();
  return session;
}

export default { createSession, resumeSession, ClaudiaSession };
