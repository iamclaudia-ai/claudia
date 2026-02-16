/**
 * DOMINATRIX Background Service Worker
 *
 * Connects to Claudia gateway WebSocket and bridges browser automation
 * commands between the gateway extension and content scripts.
 *
 * Protocol: Uses Claudia's standard WS message format.
 *   Gateway → Extension: { type: "event", event: "dominatrix.command", payload: {...} }
 *   Extension → Gateway: { type: "req", method: "dominatrix.response", params: {...} }
 */

interface ConsoleLog {
  id: string;
  type: "log" | "info" | "warn" | "error" | "debug";
  message: string;
  args?: unknown[];
  timestamp: number;
  url?: string;
}

interface NetworkRequest {
  id: string;
  url: string;
  method: string;
  type: string;
  timestamp: number;
  status?: number;
  statusText?: string;
  requestBody?: unknown;
  responseHeaders?: Record<string, string>;
}

interface TabInfo {
  id: number;
  url: string;
  title: string;
  active: boolean;
  windowId: number;
  profileId?: string;
  profileName?: string;
}

// ============================================================================
// Gateway connection config
// ============================================================================

const GATEWAY_URL = "ws://localhost:30086/ws";
const RECONNECT_DELAY = 3000;

// ============================================================================
// Background worker
// ============================================================================

class DominatrixBackground {
  private ws: WebSocket | null = null;
  private reconnectTimer: number | null = null;
  private consoleLogs = new Map<number, ConsoleLog[]>();
  private networkRequests = new Map<number, NetworkRequest[]>();
  private instanceId: string = ""; // Set in init() from storage
  private extensionId: string;
  private contextTabId: number | null = null; // Tab the side panel is scoped to

  constructor() {
    this.extensionId = chrome.runtime.id;
    this.init();
  }

  private async init() {
    console.log("[DOMINATRIX] Background worker initializing...");

    // Persist instanceId across service worker restarts — prevents client leak
    const stored = await chrome.storage.local.get("instanceId");
    this.instanceId = (stored.instanceId as string) || crypto.randomUUID();
    await chrome.storage.local.set({ instanceId: this.instanceId });
    console.log("[DOMINATRIX] Instance ID:", this.instanceId);

    this.connect();

    // Open side panel when extension icon is clicked
    chrome.action.onClicked.addListener((tab) => {
      if (tab.id) {
        chrome.sidePanel.open({ tabId: tab.id });
      }
    });

    // Focus tracking — re-subscribe exclusively when this profile's window gains focus.
    // This makes this extension instance the active command handler (last subscriber wins).
    chrome.windows.onFocusChanged.addListener((windowId) => {
      if (windowId === chrome.windows.WINDOW_ID_NONE) return;
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.sendRequest("subscribe", {
          events: ["dominatrix.command"],
          exclusive: true,
        });
      }
    });

    // Tab event listeners
    chrome.tabs.onCreated.addListener(this.onTabCreated.bind(this));
    chrome.tabs.onUpdated.addListener(this.onTabUpdated.bind(this));
    chrome.tabs.onRemoved.addListener(this.onTabRemoved.bind(this));

    // Content script messages
    chrome.runtime.onMessage.addListener(this.onContentScriptMessage.bind(this));

    // Network monitoring
    chrome.webRequest.onBeforeRequest.addListener(
      this.onNetworkRequest.bind(this),
      { urls: ["<all_urls>"] },
      ["requestBody"],
    );
    chrome.webRequest.onCompleted.addListener(
      this.onNetworkComplete.bind(this),
      { urls: ["<all_urls>"] },
      ["responseHeaders"],
    );
  }

  // --------------------------------------------------------------------------
  // Resilient content script communication
  // --------------------------------------------------------------------------

  /**
   * Send message to content script with automatic injection fallback.
   * If the content script hasn't loaded yet (e.g., manual navigation, page reload),
   * inject it on demand via chrome.scripting.executeScript().
   */
  private async sendToContentScript(
    tabId: number,
    message: Record<string, unknown>,
  ): Promise<unknown> {
    try {
      return await chrome.tabs.sendMessage(tabId, message);
    } catch (_err) {
      // Content script not loaded — inject it on demand
      console.log("[DOMINATRIX] Content script not ready, injecting on demand for tab:", tabId);
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ["content-script.js"],
      });
      // Brief delay for script initialization
      await new Promise((resolve) => setTimeout(resolve, 100));
      return await chrome.tabs.sendMessage(tabId, message);
    }
  }

  // --------------------------------------------------------------------------
  // WebSocket connection to gateway
  // --------------------------------------------------------------------------

  private connect() {
    try {
      console.log("[DOMINATRIX] Connecting to gateway...");
      this.ws = new WebSocket(GATEWAY_URL);

      this.ws.onopen = async () => {
        console.log("[DOMINATRIX] Connected to gateway");
        if (this.reconnectTimer) {
          clearTimeout(this.reconnectTimer);
          this.reconnectTimer = null;
        }

        // Subscribe to command events exclusively (last subscriber wins)
        this.sendRequest("subscribe", {
          events: ["dominatrix.command"],
          exclusive: true,
        });

        // Register ourselves
        const profileName = await this.getProfileName();
        this.sendRequest("dominatrix.register", {
          extensionId: this.extensionId,
          instanceId: this.instanceId,
          profileName,
        });
      };

      this.ws.onmessage = (event) => {
        console.log("[DOMINATRIX] WS message received:", (event.data as string).substring(0, 200));
        this.handleGatewayMessage(event.data as string);
      };

      this.ws.onerror = (error) => {
        console.error("[DOMINATRIX] WebSocket error:", error);
      };

      this.ws.onclose = () => {
        console.log("[DOMINATRIX] Disconnected from gateway, reconnecting...");
        this.ws = null;
        this.scheduleReconnect();
      };
    } catch (error) {
      console.error("[DOMINATRIX] Failed to connect:", error);
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect() {
    if (!this.reconnectTimer) {
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
        this.connect();
      }, RECONNECT_DELAY) as unknown as number;
    }
  }

  private sendRequest(method: string, params: Record<string, unknown>) {
    if (this.ws?.readyState !== WebSocket.OPEN) {
      console.warn("[DOMINATRIX] Cannot send: WebSocket not connected");
      return;
    }
    this.ws.send(
      JSON.stringify({
        type: "req",
        id: crypto.randomUUID(),
        method,
        params,
      }),
    );
  }

  private async getProfileName(): Promise<string | undefined> {
    try {
      const profileInfo = await chrome.identity.getProfileUserInfo({ accountStatus: "ANY" as any });
      if (profileInfo?.email) return profileInfo.email;
    } catch {
      // chrome.identity might not be available
    }
    return undefined;
  }

  // --------------------------------------------------------------------------
  // Handle incoming messages from gateway
  // --------------------------------------------------------------------------

  private async handleGatewayMessage(data: string) {
    try {
      const message = JSON.parse(data);

      // Respond to gateway pings immediately
      if (message.type === "ping") {
        this.ws?.send(JSON.stringify({ type: "pong", id: message.id }));
        return;
      }

      console.log(
        "[DOMINATRIX] Parsed message:",
        message.type,
        message.event || message.method || "",
      );

      // We only care about command events
      if (message.type === "event" && message.event === "dominatrix.command") {
        const { requestId, action, params = {} } = message.payload as Record<string, unknown>;
        console.log(
          "[DOMINATRIX] Command received:",
          action,
          "requestId:",
          requestId,
          "params:",
          JSON.stringify(params),
        );

        try {
          const result = await this.executeCommand(
            action as string,
            (params || {}) as Record<string, unknown>,
          );
          console.log(
            "[DOMINATRIX] Command success:",
            action,
            "sending response for requestId:",
            requestId,
          );
          this.sendRequest("dominatrix.response", {
            requestId,
            success: true,
            data: result,
          });
        } catch (error) {
          console.error("[DOMINATRIX] Command failed:", action, error);
          this.sendRequest("dominatrix.response", {
            requestId,
            success: false,
            error: error instanceof Error ? error.message : "Unknown error",
          });
        }
      } else {
        console.log("[DOMINATRIX] Ignoring message type:", message.type, message.event || "");
      }
    } catch (error) {
      console.error("[DOMINATRIX] Error handling gateway message:", error);
    }
  }

  // --------------------------------------------------------------------------
  // Command execution
  // --------------------------------------------------------------------------

  private async executeCommand(action: string, params: Record<string, unknown>): Promise<unknown> {
    const tabId = params.tabId as number | undefined;

    switch (action) {
      // --- Content script commands: pass action + params straight through ---
      case "snapshot":
      case "get-text":
      case "get-markdown":
      case "get-url":
      case "get-title":
      case "get-html":
      case "get-source":
      case "click":
      case "fill":
      case "check":
      case "uncheck":
      case "select":
      case "find-text":
      case "find-label":
      case "find-role":
      case "find-placeholder":
      case "scroll-down":
      case "scroll-up":
      case "scroll-to":
      case "wait-for-element":
      case "wait-for-text":
      case "wait":
      case "executeScript":
      case "evaluateExpression":
      case "getStorage":
      case "get-storage":
        return this.delegateToContentScript(tabId, { ...params, action });

      // --- Legacy content script actions ---
      case "getSnapshot":
      case "getHTML":
      case "getText":
      case "getMarkdown":
        return this.delegateToContentScript(tabId, { ...params, action });

      // --- Browser-level commands (no content script needed) ---
      case "screenshot":
        return this.takeScreenshot(tabId);
      case "navigate":
        return this.navigate(tabId, params.url as string);
      case "get-console":
      case "getConsoleLogs":
        return this.getConsoleLogs(tabId);
      case "get-network":
      case "listNetworkRequests":
        return this.listNetworkRequests(tabId);
      case "get-cookies":
      case "getCookies":
        return this.getCookies(tabId);
      case "wait-for-url":
        return this.waitForUrl(
          tabId,
          params.pattern as string,
          params.timeout as number | undefined,
        );
      case "listTabs":
        return this.listTabs();
      case "getActiveTab":
        return this.getActiveTab();

      default:
        throw new Error(`Unknown command: ${action}`);
    }
  }

  /**
   * Delegate a command to the content script via the resilient dispatcher.
   */
  private async delegateToContentScript(
    tabId: number | undefined,
    message: Record<string, unknown>,
  ): Promise<unknown> {
    const id = await this.resolveTabId(tabId);
    return this.sendToContentScript(id, message);
  }

  // --------------------------------------------------------------------------
  // Tab helpers
  // --------------------------------------------------------------------------

  private async resolveTabId(tabId?: number): Promise<number> {
    if (tabId) return tabId;
    // Prefer the side panel's context tab over generic "active tab"
    if (this.contextTabId) return this.contextTabId;
    const active = await this.getActiveTab();
    if (!active) throw new Error("No active tab");
    return active.id;
  }

  private async listTabs(): Promise<TabInfo[]> {
    const tabs = await chrome.tabs.query({});
    const profileName = await this.getProfileName();
    return tabs.map((tab) => ({
      id: tab.id!,
      url: tab.url || "",
      title: tab.title || "",
      active: tab.active,
      windowId: tab.windowId,
      profileId: this.instanceId,
      profileName,
    }));
  }

  private async getActiveTab(): Promise<TabInfo | null> {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tabs.length === 0) return null;
    const tab = tabs[0];
    const profileName = await this.getProfileName();
    return {
      id: tab.id!,
      url: tab.url || "",
      title: tab.title || "",
      active: tab.active,
      windowId: tab.windowId,
      profileId: this.instanceId,
      profileName,
    };
  }

  // --------------------------------------------------------------------------
  // Browser-level command implementations (no content script needed)
  // --------------------------------------------------------------------------

  private async takeScreenshot(tabId?: number) {
    const id = await this.resolveTabId(tabId);
    const tab = await chrome.tabs.get(id);
    if (!tab.windowId) throw new Error("Tab has no window");
    await chrome.tabs.update(id, { active: true });
    return chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
  }

  private async navigate(tabId?: number, url?: string) {
    const id = await this.resolveTabId(tabId);
    if (!url) throw new Error("No URL provided");
    await chrome.tabs.update(id, { url });
    return { tabId: id, url };
  }

  private async getConsoleLogs(tabId?: number): Promise<ConsoleLog[]> {
    const id = await this.resolveTabId(tabId);
    return this.consoleLogs.get(id) || [];
  }

  private async listNetworkRequests(tabId?: number): Promise<NetworkRequest[]> {
    const id = await this.resolveTabId(tabId);
    return this.networkRequests.get(id) || [];
  }

  private async getCookies(tabId?: number) {
    const id = await this.resolveTabId(tabId);
    const tab = await chrome.tabs.get(id);
    if (!tab.url) throw new Error("Tab has no URL");
    return chrome.cookies.getAll({ url: tab.url });
  }

  private async waitForUrl(
    tabId?: number,
    pattern?: string,
    timeout = 10000,
  ): Promise<{ matched: boolean; url: string }> {
    const id = await this.resolveTabId(tabId);
    if (!pattern) throw new Error("URL pattern is required");

    return new Promise((resolve) => {
      const check = async () => {
        const tab = await chrome.tabs.get(id);
        if (tab.url && this.urlMatchesPattern(tab.url, pattern)) {
          resolve({ matched: true, url: tab.url });
          return true;
        }
        return false;
      };

      // Check immediately
      check().then((matched) => {
        if (matched) return;

        // Poll every 200ms
        const interval = setInterval(async () => {
          if (await check()) clearInterval(interval);
        }, 200);

        // Timeout
        setTimeout(() => {
          clearInterval(interval);
          chrome.tabs.get(id).then((tab) => {
            resolve({ matched: false, url: tab.url || "" });
          });
        }, timeout);
      });
    });
  }

  private urlMatchesPattern(url: string, pattern: string): boolean {
    // Simple glob-style matching: ** matches anything
    const regex = new RegExp(
      "^" +
        pattern
          .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
          .replace(/\*\*/g, ".*")
          .replace(/\*/g, "[^/]*") +
        "$",
    );
    return regex.test(url);
  }

  // --------------------------------------------------------------------------
  // Tab event listeners
  // --------------------------------------------------------------------------

  private onTabCreated(_tab: chrome.tabs.Tab) {
    // Tab events could be forwarded to gateway if needed
  }

  private onTabUpdated(
    _tabId: number,
    _changeInfo: chrome.tabs.TabChangeInfo,
    _tab: chrome.tabs.Tab,
  ) {
    // Could emit pageLoad events to gateway
  }

  private onTabRemoved(tabId: number) {
    this.consoleLogs.delete(tabId);
    this.networkRequests.delete(tabId);
  }

  // --------------------------------------------------------------------------
  // Content script & network listeners
  // --------------------------------------------------------------------------

  private onContentScriptMessage(
    message: { type: string; data?: ConsoleLog; tabId?: number },
    sender: chrome.runtime.MessageSender,
    _sendResponse: (response: unknown) => void,
  ): boolean {
    // Side panel telling us which tab it's scoped to
    if (message.type === "sidepanel-context" && message.tabId) {
      this.contextTabId = message.tabId;
      console.log("[DOMINATRIX] Context tab set:", this.contextTabId);
      return false;
    }

    const tabId = sender.tab?.id;
    if (!tabId) return false;

    if (message.type === "consoleLog" && message.data) {
      const logs = this.consoleLogs.get(tabId) || [];
      logs.push(message.data);
      this.consoleLogs.set(tabId, logs);
    }

    return false;
  }

  private onNetworkRequest(details: chrome.webRequest.WebRequestBodyDetails) {
    if (details.tabId === -1) return;
    const request: NetworkRequest = {
      id: details.requestId,
      url: details.url,
      method: details.method,
      type: details.type,
      timestamp: details.timeStamp,
      requestBody: details.requestBody,
    };
    const requests = this.networkRequests.get(details.tabId) || [];
    requests.push(request);
    this.networkRequests.set(details.tabId, requests);
  }

  private onNetworkComplete(details: chrome.webRequest.WebResponseHeadersDetails) {
    if (details.tabId === -1) return;
    const requests = this.networkRequests.get(details.tabId);
    if (!requests) return;
    const request = requests.find((r) => r.id === details.requestId);
    if (request) {
      request.status = details.statusCode;
      request.statusText = details.statusLine;
      request.responseHeaders = details.responseHeaders?.reduce(
        (acc, h) => {
          acc[h.name] = h.value || "";
          return acc;
        },
        {} as Record<string, string>,
      );
    }
  }
}

// Initialize
new DominatrixBackground();
