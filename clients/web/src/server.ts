/**
 * Claudia Web UI Server
 *
 * Simple static file server using Bun's native HTML imports.
 * The app connects directly to the Gateway WebSocket.
 */

import index from "../index.html";

const PORT = Number(process.env.PORT || 3000);
const GATEWAY_URL = process.env.CLAUDIA_GATEWAY_URL || "ws://localhost:3033/ws";

Bun.serve({
  port: PORT,
  routes: {
    "/": index,
  },
  fetch(req) {
    // Return gateway URL for client to connect to
    const url = new URL(req.url);
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
