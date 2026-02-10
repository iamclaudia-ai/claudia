/**
 * Anthropic API Proxy
 *
 * HTTP proxy that intercepts Claude CLI's API calls to Anthropic.
 * Extracted from @claudia/sdk for use in the session runtime.
 *
 * Responsibilities:
 * - Forward requests to Anthropic API
 * - Inject thinking configuration (budget tokens, max tokens)
 * - Capture SSE streaming events and emit them
 * - Emit tool_result events from requests
 * - Retry transient errors (429, 503, 529) with exponential backoff
 */

import {
  createServer,
  type Server,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { EventEmitter } from "node:events";
import fs from "node:fs";

// ── Types ────────────────────────────────────────────────────

export interface ProxyOptions {
  /** Enable extended thinking mode */
  thinking?: boolean;
  /** Budget tokens for thinking (defaults to 10000) */
  thinkingBudget?: number;
  /** Log events to file for debugging */
  logFile?: string;
}

export interface StreamEvent {
  type: string;
  [key: string]: unknown;
}

// ── Constants ────────────────────────────────────────────────

const ANTHROPIC_API = "https://api.anthropic.com";
const MAX_RETRIES = 3;
const RETRYABLE_STATUSES = new Set([429, 503, 529]);

// ── Proxy Class ──────────────────────────────────────────────

export class AnthropicProxy extends EventEmitter {
  private server: Server | null = null;
  private options: ProxyOptions;
  private _port = 0;
  private _inTurn = false;
  private _lastStopReason: string | null = null;
  private _eventSequence = 0;

  constructor(options: ProxyOptions = {}) {
    super();
    this.options = options;
  }

  get port(): number {
    return this._port;
  }

  /**
   * Start the proxy server on the given port.
   * If the port is in use, tries the next port.
   */
  async start(targetPort: number): Promise<number> {
    return new Promise((resolve, reject) => {
      const tryPort = (port: number) => {
        const server = createServer(async (req, res) => {
          await this.handleRequest(req, res);
        });

        server.on("error", (err: NodeJS.ErrnoException) => {
          if (err.code === "EADDRINUSE") {
            tryPort(port + 1);
          } else {
            reject(err);
          }
        });

        server.listen(port, () => {
          this.server = server;
          this._port = port;
          resolve(port);
        });
      };

      tryPort(targetPort);
    });
  }

  /**
   * Stop the proxy server.
   */
  async stop(): Promise<void> {
    if (!this.server) return;
    return new Promise((resolve) => {
      this.server!.close(() => {
        this.server = null;
        resolve();
      });
    });
  }

  /**
   * Reset turn state — called on interrupt/abort to prevent stale turn tracking.
   */
  resetTurn(): void {
    this._inTurn = false;
    this._lastStopReason = null;
  }

  /**
   * Update thinking configuration (can be changed between prompts).
   */
  setThinking(thinking: boolean, budget?: number): void {
    this.options.thinking = thinking;
    if (budget !== undefined) {
      this.options.thinkingBudget = budget;
    }
  }

  // ── Request Handling ─────────────────────────────────────

  private async handleRequest(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const targetUrl = `${ANTHROPIC_API}${req.url}`;

    // Read request body
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }
    const body = Buffer.concat(chunks);

    let modifiedBody: Buffer | undefined;
    let isHaikuRequest = false;

    if (req.method === "POST" && body.length > 0) {
      try {
        const requestBody = JSON.parse(body.toString());

        // Handle /v1/messages requests - emit turn events and inject thinking
        if (req.url?.includes("/v1/messages")) {
          // Check if this is a primary model request (not Haiku side-channel)
          const requestModel = requestBody.model as string | undefined;
          const isHaiku = requestModel?.includes("haiku") ?? false;
          isHaikuRequest = isHaiku;

          if (!isHaiku) {
            // Emit request_start only for primary model requests
            this.emit("sse", {
              type: "request_start",
              seq: ++this._eventSequence,
              timestamp: new Date().toISOString(),
              model: requestModel,
            });
            // Emit turn_start only on the first primary model request of a turn
            if (!this._inTurn) {
              this._inTurn = true;
              this._lastStopReason = null;
              this.emit("sse", {
                type: "turn_start",
                seq: ++this._eventSequence,
                timestamp: new Date().toISOString(),
              });
            }
          }

          // Inject thinking configuration (only for non-Haiku)
          if (!isHaiku && this.options.thinking) {
            const thinkingBudget = this.options.thinkingBudget || 10000;
            requestBody.max_tokens = thinkingBudget + 8000;
            requestBody.thinking = {
              type: "enabled",
              budget_tokens: thinkingBudget,
            };
            modifiedBody = Buffer.from(JSON.stringify(requestBody));

            this.log({
              type: "thinking_injected",
              timestamp: new Date().toISOString(),
              budget_tokens: thinkingBudget,
              max_tokens: requestBody.max_tokens,
            });
          }
        }

        // Emit tool results from requests
        const toolResults = requestBody.messages?.filter(
          (m: Record<string, unknown>) =>
            m.role === "user" &&
            (m.content as Record<string, unknown>[])?.some?.((c: Record<string, unknown>) => c.type === "tool_result"),
        );
        if (toolResults?.length > 0) {
          const logEntry = {
            type: "request_tool_results",
            timestamp: new Date().toISOString(),
            url: req.url,
            tool_results: toolResults.flatMap((m: Record<string, unknown>) =>
              (m.content as Record<string, unknown>[])
                .filter((c: Record<string, unknown>) => c.type === "tool_result")
                .map((c: Record<string, unknown>) => ({
                  tool_use_id: c.tool_use_id,
                  content: typeof c.content === "string" ? c.content.substring(0, 500) : c.content,
                  is_error: c.is_error,
                })),
            ),
          };
          this.log(logEntry);
          this.emit("sse", logEntry);
        }
      } catch {
        // Not JSON — pass through
      }
    }

    // Build headers (strip host, disable compression)
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(req.headers)) {
      if (key.toLowerCase() !== "host" && value) {
        const headerValue = Array.isArray(value) ? value[0] : value;
        if (headerValue) headers[key] = headerValue;
      }
    }
    headers["accept-encoding"] = "identity";

    // Forward with retries
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const response = await fetch(targetUrl, {
          method: req.method || "GET",
          headers,
          body: ["POST", "PUT", "PATCH"].includes(req.method || "")
            ? modifiedBody?.toString() || body.toString()
            : undefined,
        });

        // Retry on transient errors
        if (RETRYABLE_STATUSES.has(response.status) && attempt < MAX_RETRIES) {
          const delay = Math.min(1000 * Math.pow(2, attempt), 8000);
          const errorBody = await response.text().catch(() => "");
          console.warn(`[Proxy] API ${response.status} (attempt ${attempt + 1}/${MAX_RETRIES + 1}), retrying in ${delay}ms...`);
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

        // Set response headers
        const contentType = response.headers.get("content-type") || "";
        res.statusCode = response.status;
        response.headers.forEach((value, key) => {
          res.setHeader(key, value);
        });

        // Handle API errors
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

          console.error(`[Proxy] API error ${response.status}: ${errorMessage}`);
          if (!isHaikuRequest) {
            this._inTurn = false;
          }
          this.emit("sse", {
            type: "api_error",
            status: response.status,
            message: errorMessage,
            detail: errorDetail,
          });

          res.end(errorBody);
          return;
        }

        // Stream SSE responses
        if (contentType.includes("text/event-stream") && response.body) {
          const isMessagesEndpoint = req.url?.includes("/v1/messages") ?? false;
          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          let buffer = "";

          const pump = async (): Promise<void> => {
            const { done, value } = await reader.read();

            if (done) {
              if (buffer.trim()) this.processSSE(buffer, isHaikuRequest);
              // Only track turn events for primary model (not Haiku side-channel)
              if (isMessagesEndpoint && !isHaikuRequest) {
                this.emit("sse", {
                  type: "stream_end",
                  seq: ++this._eventSequence,
                  timestamp: new Date().toISOString(),
                  stop_reason: this._lastStopReason,
                });

                // Only end turn if stop_reason is not "tool_use"
                if (this._lastStopReason !== "tool_use") {
                  this._inTurn = false;
                  this.emit("sse", {
                    type: "turn_stop",
                    seq: ++this._eventSequence,
                    timestamp: new Date().toISOString(),
                    stop_reason: this._lastStopReason,
                  });
                }
              }
              res.end();

              // Emit response_end for primary model only
              if (!isHaikuRequest) {
                this.emit("sse", {
                  type: "response_end",
                  seq: ++this._eventSequence,
                  timestamp: new Date().toISOString(),
                  stop_reason: this._lastStopReason,
                  url: req.url,
                });
              }
              return;
            }

            const text = decoder.decode(value, { stream: true });
            buffer += text;
            const lines = buffer.split("\n");
            buffer = lines.pop() || "";

            for (const line of lines) {
              this.processSSE(line, isHaikuRequest);
            }

            res.write(value);
            return pump();
          };

          await pump();
        } else {
          // Non-streaming response
          const responseBody = await response.arrayBuffer();
          res.end(Buffer.from(responseBody));
        }

        return; // Success — exit retry loop
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);

        if (attempt < MAX_RETRIES) {
          const delay = Math.min(1000 * Math.pow(2, attempt), 8000);
          console.warn(`[Proxy] Error (attempt ${attempt + 1}/${MAX_RETRIES + 1}): ${errorMessage}, retrying in ${delay}ms...`);
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

        console.error(`[Proxy] Error (all retries exhausted): ${errorMessage}`);
        this._inTurn = false;
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

  // ── SSE Parsing ──────────────────────────────────────────

  private processSSE(line: string, isHaiku = false): void {
    if (!line.startsWith("data: ")) return;

    const data = line.slice(6);
    if (data === "[DONE]") return;

    try {
      const event: StreamEvent = JSON.parse(data);
      this.log(event);

      // Don't emit Haiku SSE events (client filters them anyway)
      if (!isHaiku) {
        this.emit("sse", event);
      }

      // Track stop_reason only from primary model responses
      if (!isHaiku && event.type === "message_delta") {
        const delta = event.delta as { stop_reason?: string } | undefined;
        if (delta?.stop_reason) {
          this._lastStopReason = delta.stop_reason;
        }
      }
    } catch {
      // Not valid JSON
    }
  }

  // ── Logging ──────────────────────────────────────────────

  private log(event: Record<string, unknown>): void {
    if (!this.options.logFile) return;
    try {
      fs.appendFileSync(this.options.logFile, JSON.stringify(event) + "\n");
    } catch {
      // Ignore log errors
    }
  }
}
