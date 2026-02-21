# DOMINATRIX Architecture

Browser automation through a Chrome extension that bridges Claudia's gateway to live browser tabs. Commands flow from CLI/API through the gateway to the Chrome extension's content scripts.

## Connection Architecture

```
┌──────────────┐     ┌──────────────┐     ┌──────────────────┐     ┌──────────────┐
│  CLI / Agent  │     │   Gateway    │     │  Chrome Extension │     │  Content      │
│  (dominatrix  │     │   :30086     │     │  (background.ts)  │     │  Script       │
│   commands)   │     │              │     │                    │     │  (per tab)    │
└──────┬───────┘     └──────┬───────┘     └────────┬───────────┘     └──────┬───────┘
       │                     │                      │                        │
       │  req: dominatrix.   │                      │                        │
       │  snapshot           │                      │                        │
       ├────────────────────►│                      │                        │
       │                     │                      │                        │
       │                     │  Extension host      │                        │
       │                     │  dispatches via       │                        │
       │                     │  sendCommand()       │                        │
       │                     │                      │                        │
       │                     │  ctx.emit(           │                        │
       │                     │   "dominatrix.       │                        │
       │                     │    command",         │                        │
       │                     │   {requestId,        │                        │
       │                     │    action})          │                        │
       │                     │                      │                        │
       │                     │  broadcastEvent()    │                        │
       │                     │  (to subscribers)    │                        │
       │                     ├─────────────────────►│                        │
       │                     │                      │                        │
       │                     │                      │  chrome.tabs.          │
       │                     │                      │  sendMessage()         │
       │                     │                      ├───────────────────────►│
       │                     │                      │                        │
       │                     │                      │                        │  Execute in
       │                     │                      │                        │  page DOM
       │                     │                      │                        │
       │                     │                      │  Response via          │
       │                     │                      │  chrome.runtime        │
       │                     │                      │◄───────────────────────┤
       │                     │                      │                        │
       │                     │  req: dominatrix.    │                        │
       │                     │  response            │                        │
       │                     │  {requestId,         │                        │
       │                     │   success, data}     │                        │
       │                     │◄─────────────────────┤                        │
       │                     │                      │                        │
       │                     │  Extension host      │                        │
       │                     │  resolves pending    │                        │
       │                     │  promise             │                        │
       │                     │                      │                        │
       │  res: {data}        │                      │                        │
       │◄────────────────────┤                      │                        │
       │                     │                      │                        │
```

### Key Insight: Commands Use Events, Responses Use Methods

The protocol is asymmetric by design:

- **Commands** (gateway → Chrome): Emitted as `dominatrix.command` **events** via the gateway event bus. The Chrome extension receives these because it subscribes to `dominatrix.command` on its WebSocket connection.
- **Responses** (Chrome → gateway): Sent as `dominatrix.response` **method calls** (regular `req` messages). The gateway routes these to the dominatrix extension host, which resolves the pending promise.

This means commands broadcast to ALL subscribed Chrome extension clients, but only one needs to respond.

---

## Chrome Extension Lifecycle

### Service Worker Startup

```
Chrome starts/restarts service worker
  │
  ├─ new DominatrixBackground()
  │    └─ this.instanceId = crypto.randomUUID()  ← NEW ID each time
  │
  ├─ connect() → WebSocket to ws://localhost:30086/ws
  │
  ├─ onopen:
  │    ├─ subscribe({events: ["dominatrix.command"]})
  │    └─ dominatrix.register({extensionId, instanceId, profileName})
  │
  └─ onclose:
       └─ scheduleReconnect() → retry after 3s
```

### Registration in Extension

```typescript
// dominatrix extension (server-side)
"dominatrix.register": async (p) => {
  const client: ChromeClient = {
    id: p.instanceId,          // ← Key: instanceId from Chrome
    profileName: p.profileName,
    extensionId: p.extensionId,
    registeredAt: Date.now(),
  };
  clients.set(client.id, client);  // ← Added to Map, never removed!
};
```

---

## Bug: Client Connection Leak

### The Problem

The dominatrix extension's `clients` Map grows unbounded because **clients are registered but never unregistered**.

### How Clients Accumulate

**Cause 1: Chrome Service Worker Restarts**

Chrome kills idle service workers after ~30 seconds of inactivity. On restart:

```
1. Service worker killed by Chrome
2. Service worker restarts (any event triggers this)
3. new DominatrixBackground() → NEW instanceId (crypto.randomUUID())
4. Connects to gateway → registers with new instanceId
5. Old instanceId still in dominatrix clients Map ← LEAKED
```

Over hours/overnight, this accumulates dozens of stale client entries.

**Cause 2: Gateway/Extension Host Restart + Reconnect Race**

```
1. Gateway restarts (watchdog or HMR)
2. Extension host respawns → clients Map is fresh (empty)
3. Chrome extension WS disconnects → reconnects after 3s
4. Re-registers with same instanceId → OK, single entry
```

This case actually works fine because the extension host restart clears the Map. But combined with Cause 1, it doesn't help.

**Cause 3: Extension Host HMR Without Chrome Re-register**

```
1. Extension host HMR reloads (file change in extensions/dominatrix/)
2. dispose() → clients.clear()
3. Extension re-registers with gateway
4. Chrome extension's WS is still alive (connected to gateway, not ext host)
5. Chrome extension does NOT re-register (only registers on ws.onopen)
6. clients Map is now empty — commands fail: "No Chrome extension clients"
```

### Why There's No Cleanup

The gateway knows when a WebSocket client disconnects (`close` handler in index.ts), but there's no mechanism to notify the dominatrix extension that one of its registered Chrome clients dropped.

The disconnect happens at two different layers:

- **Gateway layer**: WebSocket close → removes from gateway `clients` Map, cleans up voice streams
- **Extension layer**: dominatrix `clients` Map → **nothing happens**

These two layers are completely decoupled — the gateway doesn't know which WS connections are Chrome extension clients vs regular web UI clients.

### Fix Options

**Option A: Heartbeat-Based Cleanup (simplest)**

Add a periodic sweep in the dominatrix extension that pings registered clients:

```typescript
// Every 30s, emit a heartbeat event
// Chrome extensions that are alive respond via dominatrix.heartbeat_response
// Clients that don't respond within 10s get pruned
setInterval(() => {
  for (const [id, client] of clients) {
    if (Date.now() - client.lastSeen > 60_000) {
      clients.delete(id);
    }
  }
}, 30_000);
```

Chrome extension sends periodic heartbeats or responds to pings to update `lastSeen`.

**Option B: Gateway Disconnect Notification (architectural)**

When the gateway's WebSocket close handler fires, check if the disconnecting client was subscribed to `dominatrix.command` and notify the extension:

```typescript
// In gateway close handler:
close(ws) {
  clients.delete(ws);

  // Notify extensions about client disconnect
  if (ws.data.subscriptions.has("dominatrix.command")) {
    extensions.broadcast({
      type: "client.disconnected",
      payload: { connectionId: ws.data.id },
    });
  }
}
```

The dominatrix extension would need to track `connectionId → instanceId` mapping to know which client to remove.

**Option C: Re-register on Any Reconnect (Chrome-side fix)**

Store `instanceId` in `chrome.storage.local` so it survives service worker restarts, and always re-register with the same ID:

```typescript
// In background.ts constructor:
const stored = await chrome.storage.local.get("instanceId");
this.instanceId = stored.instanceId || crypto.randomUUID();
await chrome.storage.local.set({ instanceId: this.instanceId });
```

This prevents Cause 1 (new UUIDs on restart) since re-registering with the same ID overwrites the Map entry. Stale entries from truly dead clients would still need cleanup via Option A or B.

### Recommended: Option C + Option A

- **Option C** eliminates the main source of leaks (service worker restarts generating new UUIDs)
- **Option A** (simple heartbeat/TTL) catches any remaining edge cases

---

## Health Check

Mission Control queries `dominatrix.health_check` which returns:

```typescript
{
  ok: boolean,              // true if any clients connected
  status: "healthy" | "disconnected",
  label: "Browser Control (DOMINATRIX)",
  metrics: [
    { label: "Connected Clients", value: N },  // ← inflated by leak
    { label: "Pending Commands", value: N },
  ],
  items: [                  // ← one entry per registered client
    {
      id: "instance-uuid",
      label: "user@gmail.com",
      status: "healthy",    // ← always "healthy", no liveness check
      details: { registered: "2026-02-16T..." }
    }
  ]
}
```

Note: `status: "healthy"` is hardcoded for all clients — there's no actual liveness check. A stale client entry looks identical to a live one in Mission Control.

---

## Tab Resolution: Current Behavior and Problems

### How resolveTabId Works Today

```typescript
// background.ts
private async resolveTabId(tabId?: number): Promise<number> {
  if (tabId) return tabId;                              // 1. Explicit tabId wins
  if (this.contextTabId) return this.contextTabId;      // 2. Side panel context
  const active = await this.getActiveTab();             // 3. chrome.tabs.query fallback
  return active.id;
}

private async getActiveTab(): Promise<TabInfo | null> {
  // "currentWindow" = the LAST FOCUSED window for this profile
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs[0];
}
```

### Side Panel Context Tracking

```typescript
// sidepanel.ts — runs when side panel opens
const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
chrome.runtime.sendMessage({ type: "sidepanel-context", tabId: tab.id });

// Also tracks tab switches while panel is open:
chrome.tabs.onActivated.addListener((activeInfo) => {
  chrome.runtime.sendMessage({ type: "sidepanel-context", tabId: activeInfo.tabId });
});
```

### Problem 1: Side Panel is Per-Window, Not Per-Tab

Chrome's side panel API is window-scoped. When you open it on Tab A and switch to Tab B, the panel stays open. The `onActivated` listener updates `contextTabId` to Tab B, which is correct. But the iframe URL still has `?tabId=<Tab A's id>` from initial load — though this is cosmetic since the background worker uses `contextTabId` for routing, not the iframe URL param.

### Problem 2: `currentWindow` in Service Workers

`chrome.tabs.query({ active: true, currentWindow: true })` behaves differently in service workers vs page contexts:

- **In a page context** (popup, side panel): `currentWindow` = the window containing that page
- **In a service worker** (background.ts): `currentWindow` = the **last focused window**

So when `getActiveTab()` is called from the service worker (which handles commands), it returns the active tab in whichever window Chrome considers "current" — which may not be the window you're looking at if you recently clicked on another window.

### Problem 3: Commands Broadcast to ALL Chrome Extensions

```
sendCommand() → ctx.emit("dominatrix.command", {...})
  → broadcastEvent("dominatrix.command", {...})
    → ALL WebSocket clients subscribed to "dominatrix.command" receive it
```

With multiple Chrome profiles, each has its own extension instance, each subscribed to `dominatrix.command`. **ALL of them execute the command.** The gateway accepts the **first** `dominatrix.response` and the rest hit `pendingRequests` as "unknown request" warnings.

This means:

- Profile A's extension might respond first with the wrong tab
- Both extensions execute side effects (screenshots, clicks, etc.)
- Race conditions determine which response wins

### Problem 4: No Profile-Aware Routing

The `dominatrix.command` event has no concept of "which Chrome extension instance should handle this." Every registered client gets every command.

---

## Tab Resolution: Options

### Option A: Always Require Tab ID (Explicit Routing)

The most reliable approach. Every command includes a `tabId`. The workflow becomes:

1. **Get tabs**: `dominatrix tabs` → shows all tabs across all profiles with IDs
2. **Target tab**: `dominatrix snapshot --tab-id 123`

For the chat UI / agent workflow:

- When Claudia needs to interact with the browser, first call `dominatrix tabs` to see what's available
- Pick the right tab from the list
- Use `--tab-id` for all subsequent commands

**Pros**: Completely unambiguous, works with any number of profiles/windows
**Cons**: Extra step to discover tab IDs, doesn't "just work" for the common case

### Option B: Focus-Aware Active Tab (OS-Level)

Query the truly focused tab using `chrome.windows.getLastFocused()` combined with the active tab in that window:

```typescript
private async getActiveTab(): Promise<TabInfo | null> {
  const window = await chrome.windows.getLastFocused({ populate: false });
  const tabs = await chrome.tabs.query({ active: true, windowId: window.id });
  return tabs[0];
}
```

This is slightly better than `currentWindow` but still has the same profile problem — each extension instance only sees its own profile's windows. If you're focused on a Profile B window, Profile A's extension can't know that.

**Pros**: Better than current `currentWindow` behavior
**Cons**: Still can't cross profile boundaries

### Option C: Focus-Aware Sticky Subscriptions (Recommended)

Use the existing gateway subscription system. The Chrome extension subscribes to `dominatrix.command` when its window gains focus. It does NOT unsubscribe on blur — the subscription is "sticky" until another client subscribes, which implicitly takes over as the active handler.

```
Chrome Extension A (personal):
  window.onFocusChanged → subscribe({events: ["dominatrix.command"]})

Chrome Extension B (work):
  window.onFocusChanged → subscribe({events: ["dominatrix.command"]})

Only the LAST extension to subscribe receives command events.
If no window is focused (e.g. you're in terminal), the last-focused
extension still handles commands.
```

Combined with explicit `--tab-id` override for when you need to target a specific tab.

**Pros**: Uses existing gateway infrastructure, no bespoke routing logic, naturally handles multi-profile, recoverable (just click the window to re-assert focus)
**Cons**: Requires gateway support for "exclusive" subscriptions (last subscriber wins)

### Implementation Plan

**1. Gateway: Ping/Pong Protocol (general-purpose)**

Add connection liveness to the gateway WebSocket protocol. This benefits all clients, not just dominatrix:

```typescript
// Gateway → Client (periodic, every 30s)
{ type: "ping", id: "ping-123", timestamp: 1234567890 }

// Client → Gateway (must respond within 10s)
{ type: "pong", id: "ping-123" }

// Missed 2 consecutive pings:
//   → Clean up subscriptions
//   → Remove client from clients Map
//   → Emit "client.disconnected" event to extensions
```

This gives:

- Reliable subscription state (stale clients pruned automatically)
- Accurate Mission Control health checks (no ghost entries)
- Latency tracking (ping/pong RTT useful for diagnostics)

**2. Gateway: Exclusive Subscriptions**

New subscription mode where only the last subscriber receives events for a pattern:

```typescript
// Client → Gateway
{
  type: "req",
  method: "subscribe",
  params: {
    events: ["dominatrix.command"],
    exclusive: true  // ← last subscriber wins
  }
}
```

When a client subscribes exclusively:

- Previous exclusive subscriber for that pattern is unsubscribed
- Only one client receives events matching that pattern
- Non-exclusive subscribers are unaffected

**3. Chrome Extension: Focus Tracking**

```typescript
// background.ts
chrome.windows.onFocusChanged.addListener((windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) return; // All windows lost focus
  // Re-subscribe — this makes us the active command handler
  this.sendRequest("subscribe", {
    events: ["dominatrix.command"],
    exclusive: true,
  });
});
```

No unsubscribe on blur. No heartbeat logic. Just re-assert on focus. Sticky by default.

**4. Explicit Override: --tab-id**

`--tab-id` always works regardless of focus state. The command includes the tab ID, and the Chrome extension that owns that tab handles it. For this to work, the `dominatrix.command` event payload includes the `tabId`, and Chrome extensions that receive it check if they own that tab before executing.

**5. Dominatrix Extension: Client Cleanup via Gateway Events**

```typescript
ctx.on("client.disconnected", (event) => {
  // Gateway pruned a stale connection — remove from our clients Map
  const connectionId = event.payload.connectionId;
  // Look up which instanceId maps to this connectionId and remove it
});
```

No more ghost entries. Mission Control health check becomes accurate.
