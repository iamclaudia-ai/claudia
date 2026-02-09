/**
 * Claudia Web UI Server
 *
 * Simple static file server using Bun's native HTML imports.
 * The app connects directly to the Gateway WebSocket.
 *
 * Serves /api/config so the client knows where the gateway is,
 * reading from ~/.claudia/claudia.json (gateway.endpoint for remote,
 * gateway.port + gateway.host for local fallback).
 */

import index from "../index.html";
import { loadConfig } from "@claudia/shared";

const config = loadConfig();
const PORT = Number(process.env.PORT || 30087);

// Build the gateway WebSocket URL from config
// If endpoint is set, use it (wss:// for remote). Otherwise use host:port (ws:// for local).
function getGatewayUrl(): string {
  if (config.gateway.endpoint) {
    return `wss://${config.gateway.endpoint}/ws`;
  }
  return `ws://${config.gateway.host}:${config.gateway.port}/ws`;
}

const GATEWAY_URL = process.env.CLAUDIA_GATEWAY_URL || getGatewayUrl();

Bun.serve({
  port: PORT,
  routes: {
    "/": index,
  },
  fetch(req) {
    const url = new URL(req.url);
    // Serve gateway config for the web client to discover the gateway URL
    if (url.pathname === "/api/config") {
      return new Response(
        JSON.stringify({
          gatewayUrl: GATEWAY_URL,
          session: config.session,
        }),
        {
          headers: { "Content-Type": "application/json" },
        },
      );
    }
    // Legacy endpoint
    if (url.pathname === "/api/gateway") {
      return new Response(JSON.stringify({ url: GATEWAY_URL }), {
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response("Not found", { status: 404 });
  },
  development: {
    hmr: true,
    console: true,
  },
});

console.log(`
╔═══════════════════════════════════════════════════════════╗
║                                                           ║
║   💙 Claudia Web UI running on http://localhost:${PORT}    ║
║                                                           ║
║   Gateway: ${GATEWAY_URL.padEnd(37)}║
║                                                           ║
╚═══════════════════════════════════════════════════════════╝
`);
