/**
 * Thinking Injection Proxy
 *
 * Lightweight HTTP proxy that sits between Claude CLI and the Anthropic API.
 * Its ONLY job is to inject adaptive thinking configuration into API requests.
 *
 * With --sdk-url, the CLI handles everything (streaming, tool results,
 * interrupts) over WebSocket. But the CLI's --effort flag doesn't inject
 * the API-level thinking parameters, so this proxy intercepts requests to add:
 * - `thinking: { type: "adaptive" }`
 * - `output_config: { effort: "medium" }`
 *
 * Once injected, the API returns thinking blocks in the SSE response, and
 * the CLI forwards them via --sdk-url stream_events naturally.
 *
 * This is a single shared proxy (not per-session) since all sessions
 * go to the same Anthropic API endpoint.
 */

// ── Types ────────────────────────────────────────────────────

export type ThinkingEffort = "low" | "medium" | "high" | "max";

export interface ThinkingProxyOptions {
  /** Thinking effort level */
  effort?: ThinkingEffort;
}

// ── Constants ────────────────────────────────────────────────

const ANTHROPIC_API = "https://api.anthropic.com";

// ── ThinkingProxy ────────────────────────────────────────────

export class ThinkingProxy {
  private server: ReturnType<typeof Bun.serve> | null = null;
  private _port = 0;
  private effort: ThinkingEffort;

  constructor(options: ThinkingProxyOptions = {}) {
    this.effort = options.effort || "medium";
  }

  get port(): number {
    return this._port;
  }

  get baseUrl(): string {
    return `http://localhost:${this._port}`;
  }

  /**
   * Update effort level dynamically.
   */
  setEffort(effort: ThinkingEffort): void {
    this.effort = effort;
    console.log(`[ThinkingProxy] Effort set to: ${effort}`);
  }

  /**
   * Start the proxy server.
   */
  async start(port: number): Promise<number> {
    this.server = Bun.serve({
      port,
      fetch: async (req) => this.handleRequest(req),
    });
    this._port = this.server.port;
    console.log(`[ThinkingProxy] Listening on port ${this._port} (effort: ${this.effort})`);
    return this._port;
  }

  /**
   * Stop the proxy server.
   */
  stop(): void {
    if (this.server) {
      this.server.stop();
      this.server = null;
    }
  }

  // ── Request Handling ─────────────────────────────────────

  private async handleRequest(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const targetUrl = `${ANTHROPIC_API}${url.pathname}${url.search}`;

    // Read and potentially modify request body
    let body = await req.text();
    const isMessages = url.pathname.includes("/v1/messages") && !url.pathname.includes("count_tokens");

    if (req.method === "POST" && isMessages && body.length > 0) {
      try {
        const parsed = JSON.parse(body);

        // Skip Haiku side-channel requests
        const model = parsed.model as string | undefined;
        const isHaiku = model?.includes("haiku") ?? false;

        if (!isHaiku) {
          // Inject adaptive thinking
          parsed.thinking = { type: "adaptive" };
          parsed.output_config = { effort: this.effort };
          body = JSON.stringify(parsed);
        }
      } catch {
        // Not JSON — pass through
      }
    }

    // Build headers (strip host)
    const headers = new Headers();
    req.headers.forEach((value, key) => {
      if (key.toLowerCase() !== "host") {
        headers.set(key, value);
      }
    });

    // Forward to Anthropic
    const response = await fetch(targetUrl, {
      method: req.method,
      headers,
      body: ["POST", "PUT", "PATCH"].includes(req.method) ? body : undefined,
    });

    // Pass through response as-is — thinking events flow through
    // --sdk-url WebSocket bridge naturally
    return response;
  }
}
