/**
 * Thinking Injection Proxy
 *
 * Lightweight HTTP request handler that injects adaptive thinking
 * configuration into Anthropic API requests.
 *
 * With --sdk-url, the CLI handles everything (streaming, tool results,
 * interrupts) over WebSocket. But the CLI's --effort flag doesn't inject
 * the API-level thinking parameters, so this handler intercepts requests to add:
 * - `thinking: { type: "adaptive" }`
 * - `output_config: { effort: "medium" }`
 *
 * Once injected, the API returns thinking blocks in the SSE response, and
 * the CLI forwards them via --sdk-url stream_events naturally.
 *
 * Integrated into the runtime server — no separate port needed.
 * CLI sends API requests here via ANTHROPIC_BASE_URL=http://localhost:30087.
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
  private effort: ThinkingEffort;

  constructor(options: ThinkingProxyOptions = {}) {
    this.effort = options.effort || "medium";
  }

  /**
   * Update effort level dynamically.
   */
  setEffort(effort: ThinkingEffort): void {
    this.effort = effort;
    console.log(`[ThinkingProxy] Effort set to: ${effort}`);
  }

  /**
   * Handle an incoming API request — inject thinking config and forward to Anthropic.
   * Called by the runtime server's fetch handler for /v1/ paths.
   */
  async handleRequest(req: Request): Promise<Response> {
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
