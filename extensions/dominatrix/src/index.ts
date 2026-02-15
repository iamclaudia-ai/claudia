/**
 * DOMINATRIX Gateway Extension
 *
 * Browser automation through Chrome extension clients.
 * Commands flow: CLI/API → Gateway → Extension → Chrome Extension → Content Script → DOM.
 *
 * Chrome extension clients connect to the gateway WebSocket, subscribe to
 * `dominatrix.command` events, and respond via `dominatrix.response` method calls.
 */

import type { ClaudiaExtension, ExtensionContext, HealthCheckResponse } from "@claudia/shared";
import { z } from "zod";

// ============================================================================
// Types
// ============================================================================

interface ChromeClient {
  id: string;
  profileName?: string;
  extensionId: string;
  registeredAt: number;
}

interface PendingRequest {
  resolve: (data: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

// ============================================================================
// Constants
// ============================================================================

const COMMAND_TIMEOUT_MS = 15_000;

// ============================================================================
// Schemas
// ============================================================================

// --- Common params ---

const tabIdParam = z.object({
  tabId: z.number().optional().describe("Target tab ID (defaults to active tab)"),
});

const refOrSelectorParam = z.object({
  tabId: z.number().optional().describe("Target tab ID (defaults to active tab)"),
  ref: z.string().optional().describe("Element ref from snapshot (e.g. @e3)"),
  selector: z.string().optional().describe("CSS selector fallback"),
});

// --- Snapshot & page info ---

const snapshotParam = z.object({
  tabId: z.number().optional().describe("Target tab ID (defaults to active tab)"),
  full: z.boolean().optional().describe("Return full a11y tree JSON instead of compact refs"),
  scope: z.string().optional().describe("CSS selector to scope the snapshot"),
});

const getTextParam = z.object({
  tabId: z.number().optional().describe("Target tab ID (defaults to active tab)"),
  ref: z.string().optional().describe("Element ref to get text of (omit for full page)"),
});

const getMarkdownParam = z.object({
  tabId: z.number().optional().describe("Target tab ID (defaults to active tab)"),
  ref: z.string().optional().describe("Element ref to get markdown of (omit for full page)"),
});

const getHtmlParam = z.object({
  tabId: z.number().optional().describe("Target tab ID (defaults to active tab)"),
  selector: z.string().optional().describe("CSS selector (omit for full page)"),
});

// --- Interaction ---

const fillParam = z.object({
  tabId: z.number().optional().describe("Target tab ID (defaults to active tab)"),
  ref: z.string().optional().describe("Element ref from snapshot (e.g. @e3)"),
  selector: z.string().optional().describe("CSS selector fallback"),
  value: z.string().describe("Value to fill"),
});

const selectParam = z.object({
  tabId: z.number().optional().describe("Target tab ID (defaults to active tab)"),
  ref: z.string().optional().describe("Element ref from snapshot"),
  selector: z.string().optional().describe("CSS selector fallback"),
  value: z.string().describe("Option value to select"),
});

// --- Semantic find ---

const performEnum = z.enum(["click", "fill"]).describe("Action to perform on found element");

const findTextParam = z.object({
  tabId: z.number().optional(),
  text: z.string().describe("Visible text to search for"),
  perform: performEnum,
  value: z.string().optional().describe("Value for fill action"),
});

const findLabelParam = z.object({
  tabId: z.number().optional(),
  label: z.string().describe("Label text or aria-label to search for"),
  perform: performEnum,
  value: z.string().optional().describe("Value for fill action"),
});

const findRoleParam = z.object({
  tabId: z.number().optional(),
  role: z.string().describe("ARIA role (e.g. button, link, textbox)"),
  name: z.string().optional().describe("Accessible name to match"),
  perform: performEnum,
  value: z.string().optional().describe("Value for fill action"),
});

const findPlaceholderParam = z.object({
  tabId: z.number().optional(),
  placeholder: z.string().describe("Placeholder text to search for"),
  perform: performEnum,
  value: z.string().optional().describe("Value for fill action"),
});

// --- Navigation & scrolling ---

const navigateParam = z.object({
  tabId: z.number().optional(),
  url: z.string().url().describe("URL to navigate to"),
});

const scrollValueParam = z.object({
  tabId: z.number().optional(),
  value: z.number().optional().describe("Pixels to scroll (default: 300)"),
});

const scrollToParam = z.object({
  tabId: z.number().optional(),
  ref: z.string().optional().describe("Element ref to scroll into view"),
  position: z.enum(["top", "bottom"]).optional().describe("Scroll to top or bottom of page"),
});

// --- Wait ---

const waitForElementParam = z.object({
  tabId: z.number().optional(),
  selector: z.string().describe("CSS selector to wait for"),
  timeout: z.number().optional().describe("Timeout in ms (default: 5000)"),
});

const waitForTextParam = z.object({
  tabId: z.number().optional(),
  text: z.string().describe("Text to wait for"),
  timeout: z.number().optional().describe("Timeout in ms (default: 5000)"),
});

const waitForUrlParam = z.object({
  tabId: z.number().optional(),
  pattern: z.string().describe("URL glob pattern to match (e.g. **/posts)"),
  timeout: z.number().optional().describe("Timeout in ms (default: 10000)"),
});

const waitParam = z.object({
  tabId: z.number().optional(),
  ms: z.number().describe("Milliseconds to wait"),
});

// --- Script execution ---

const execParam = z.object({
  tabId: z.number().optional(),
  script: z.string().describe("JavaScript to execute in page context"),
});

const evalParam = z.object({
  tabId: z.number().optional(),
  expression: z.string().describe("JavaScript expression to evaluate"),
});

// --- Screenshot ---

const screenshotParam = z.object({
  tabId: z.number().optional(),
  fullPage: z.boolean().optional().describe("Capture full page"),
});

// --- Internal ---

const registerParam = z.object({
  extensionId: z.string(),
  instanceId: z.string(),
  profileName: z.string().optional(),
});

const responseParam = z.object({
  requestId: z.string(),
  success: z.boolean(),
  data: z.unknown().optional(),
  error: z.string().optional(),
});

// ============================================================================
// Extension Factory
// ============================================================================

export default function createDominatrixExtension(): ClaudiaExtension {
  let ctx: ExtensionContext;
  const clients = new Map<string, ChromeClient>();
  const pendingRequests = new Map<string, PendingRequest>();

  // --------------------------------------------------------------------------
  // Command dispatch — sends command event and waits for response
  // --------------------------------------------------------------------------

  function sendCommand(action: string, params: Record<string, unknown> = {}): Promise<unknown> {
    ctx.log.info(
      `sendCommand: action=${action}, clients=${clients.size}, params=${JSON.stringify(params)}`,
    );

    if (clients.size === 0) {
      return Promise.reject(new Error("No Chrome extension clients connected"));
    }

    const requestId = crypto.randomUUID();

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        ctx.log.warn(`Command timed out: action=${action}, requestId=${requestId}`);
        pendingRequests.delete(requestId);
        reject(new Error(`Command '${action}' timed out after ${COMMAND_TIMEOUT_MS}ms`));
      }, COMMAND_TIMEOUT_MS);

      pendingRequests.set(requestId, { resolve, reject, timer });

      ctx.log.info(`Emitting dominatrix.command: requestId=${requestId}, action=${action}`);
      ctx.emit("dominatrix.command", {
        requestId,
        action,
        params,
      });
    });
  }

  // --------------------------------------------------------------------------
  // Method handlers
  // --------------------------------------------------------------------------

  const methods: Record<string, (params: Record<string, unknown>) => Promise<unknown>> = {
    // --- Snapshot & page info ---
    "dominatrix.snapshot": (p) => sendCommand("snapshot", p),
    "dominatrix.get-text": (p) => sendCommand("get-text", p),
    "dominatrix.get-markdown": (p) => sendCommand("get-markdown", p),
    "dominatrix.get-url": (p) => sendCommand("get-url", p),
    "dominatrix.get-title": (p) => sendCommand("get-title", p),
    "dominatrix.get-html": (p) => sendCommand("get-html", p),

    // --- Interaction ---
    "dominatrix.click": (p) => sendCommand("click", p),
    "dominatrix.fill": (p) => sendCommand("fill", p),
    "dominatrix.check": (p) => sendCommand("check", p),
    "dominatrix.uncheck": (p) => sendCommand("uncheck", p),
    "dominatrix.select": (p) => sendCommand("select", p),

    // --- Semantic find ---
    "dominatrix.find-text": (p) => sendCommand("find-text", p),
    "dominatrix.find-label": (p) => sendCommand("find-label", p),
    "dominatrix.find-role": (p) => sendCommand("find-role", p),
    "dominatrix.find-placeholder": (p) => sendCommand("find-placeholder", p),

    // --- Navigation & scrolling ---
    "dominatrix.navigate": (p) => sendCommand("navigate", p),
    "dominatrix.scroll-down": (p) => sendCommand("scroll-down", p),
    "dominatrix.scroll-up": (p) => sendCommand("scroll-up", p),
    "dominatrix.scroll-to": (p) => sendCommand("scroll-to", p),

    // --- Wait ---
    "dominatrix.wait-for-element": (p) => sendCommand("wait-for-element", p),
    "dominatrix.wait-for-text": (p) => sendCommand("wait-for-text", p),
    "dominatrix.wait-for-url": (p) => sendCommand("wait-for-url", p),
    "dominatrix.wait": (p) => sendCommand("wait", p),

    // --- Debugging ---
    "dominatrix.screenshot": (p) => sendCommand("screenshot", p),
    "dominatrix.exec": (p) => sendCommand("executeScript", p),
    "dominatrix.eval": (p) => sendCommand("evaluateExpression", p),
    "dominatrix.get-console": (p) => sendCommand("get-console", p),
    "dominatrix.get-network": (p) => sendCommand("get-network", p),
    "dominatrix.get-storage": (p) => sendCommand("get-storage", p),
    "dominatrix.get-cookies": (p) => sendCommand("get-cookies", p),

    // --- Internal ---
    "dominatrix.register": async (p) => {
      const client: ChromeClient = {
        id: p.instanceId as string,
        profileName: p.profileName as string | undefined,
        extensionId: p.extensionId as string,
        registeredAt: Date.now(),
      };
      clients.set(client.id, client);
      ctx.log.info("Chrome extension registered", client);
      return { ok: true };
    },

    "dominatrix.response": async (p) => {
      const requestId = p.requestId as string;
      ctx.log.info(
        `Response received: requestId=${requestId}, success=${p.success}, pending=${pendingRequests.size}`,
      );
      const pending = pendingRequests.get(requestId);
      if (!pending) {
        ctx.log.warn(
          `Response for unknown request: requestId=${requestId}, pendingKeys=[${Array.from(pendingRequests.keys()).join(",")}]`,
        );
        return { ok: false };
      }

      pendingRequests.delete(requestId);
      clearTimeout(pending.timer);

      if (p.success) {
        ctx.log.info(`Resolving request: requestId=${requestId}`);
        pending.resolve(p.data);
      } else {
        ctx.log.warn(`Rejecting request: requestId=${requestId}, error=${p.error}`);
        pending.reject(new Error((p.error as string) || "Command failed"));
      }

      return { ok: true };
    },

    "dominatrix.health-check": async (): Promise<HealthCheckResponse> => {
      const clientList = Array.from(clients.values());
      return {
        ok: clientList.length > 0,
        status: clientList.length > 0 ? "healthy" : "disconnected",
        label: "Browser Control (DOMINATRIX)",
        metrics: [
          { label: "Connected Clients", value: clientList.length },
          { label: "Pending Commands", value: pendingRequests.size },
        ],
        items: clientList.map((c) => ({
          id: c.id,
          label: c.profileName || c.extensionId,
          status: "healthy" as const,
          details: {
            registered: new Date(c.registeredAt).toISOString(),
          },
        })),
      };
    },
  };

  // --------------------------------------------------------------------------
  // Extension interface
  // --------------------------------------------------------------------------

  return {
    id: "dominatrix",
    name: "DOMINATRIX Browser Control",
    events: ["dominatrix.command", "dominatrix.tab.*"],
    methods: [
      // --- Snapshot & page info ---
      {
        name: "dominatrix.snapshot",
        description: "Get interactive element refs (default) or full a11y tree (--full)",
        inputSchema: snapshotParam,
      },
      {
        name: "dominatrix.get-text",
        description: "Get plain text of page or element by ref",
        inputSchema: getTextParam,
      },
      {
        name: "dominatrix.get-markdown",
        description: "Get page or element content as Markdown",
        inputSchema: getMarkdownParam,
      },
      { name: "dominatrix.get-url", description: "Get current page URL", inputSchema: tabIdParam },
      {
        name: "dominatrix.get-title",
        description: "Get current page title",
        inputSchema: tabIdParam,
      },
      {
        name: "dominatrix.get-html",
        description: "Get HTML of page or element",
        inputSchema: getHtmlParam,
      },

      // --- Interaction ---
      {
        name: "dominatrix.click",
        description: "Click element by @ref or CSS selector",
        inputSchema: refOrSelectorParam,
      },
      {
        name: "dominatrix.fill",
        description: "Fill form field by @ref or CSS selector",
        inputSchema: fillParam,
      },
      {
        name: "dominatrix.check",
        description: "Check a checkbox by @ref or CSS selector",
        inputSchema: refOrSelectorParam,
      },
      {
        name: "dominatrix.uncheck",
        description: "Uncheck a checkbox by @ref or CSS selector",
        inputSchema: refOrSelectorParam,
      },
      {
        name: "dominatrix.select",
        description: "Select dropdown option by @ref or CSS selector",
        inputSchema: selectParam,
      },

      // --- Semantic find ---
      {
        name: "dominatrix.find-text",
        description: "Find element by visible text and act",
        inputSchema: findTextParam,
      },
      {
        name: "dominatrix.find-label",
        description: "Find element by label/aria-label and act",
        inputSchema: findLabelParam,
      },
      {
        name: "dominatrix.find-role",
        description: "Find element by ARIA role and act",
        inputSchema: findRoleParam,
      },
      {
        name: "dominatrix.find-placeholder",
        description: "Find element by placeholder and act",
        inputSchema: findPlaceholderParam,
      },

      // --- Navigation & scrolling ---
      {
        name: "dominatrix.navigate",
        description: "Navigate tab to URL",
        inputSchema: navigateParam,
      },
      {
        name: "dominatrix.scroll-down",
        description: "Scroll down by pixels",
        inputSchema: scrollValueParam,
      },
      {
        name: "dominatrix.scroll-up",
        description: "Scroll up by pixels",
        inputSchema: scrollValueParam,
      },
      {
        name: "dominatrix.scroll-to",
        description: "Scroll to element or position",
        inputSchema: scrollToParam,
      },

      // --- Wait ---
      {
        name: "dominatrix.wait-for-element",
        description: "Wait for element to appear",
        inputSchema: waitForElementParam,
      },
      {
        name: "dominatrix.wait-for-text",
        description: "Wait for text to appear",
        inputSchema: waitForTextParam,
      },
      {
        name: "dominatrix.wait-for-url",
        description: "Wait for URL to match pattern",
        inputSchema: waitForUrlParam,
      },
      { name: "dominatrix.wait", description: "Wait fixed milliseconds", inputSchema: waitParam },

      // --- Debugging ---
      {
        name: "dominatrix.screenshot",
        description: "Capture visible tab as PNG data URL",
        inputSchema: screenshotParam,
      },
      {
        name: "dominatrix.exec",
        description: "Execute JavaScript in page context",
        inputSchema: execParam,
      },
      {
        name: "dominatrix.eval",
        description: "Evaluate JavaScript expression",
        inputSchema: evalParam,
      },
      {
        name: "dominatrix.get-console",
        description: "Get console logs from page",
        inputSchema: tabIdParam,
      },
      {
        name: "dominatrix.get-network",
        description: "Get network requests from page",
        inputSchema: tabIdParam,
      },
      {
        name: "dominatrix.get-storage",
        description: "Get localStorage and sessionStorage",
        inputSchema: tabIdParam,
      },
      {
        name: "dominatrix.get-cookies",
        description: "Get cookies for page domain",
        inputSchema: tabIdParam,
      },

      // --- Internal ---
      {
        name: "dominatrix.register",
        description: "Register Chrome extension client",
        inputSchema: registerParam,
      },
      {
        name: "dominatrix.response",
        description: "Handle command response from Chrome extension",
        inputSchema: responseParam,
      },
      { name: "dominatrix.health-check", description: "Health check", inputSchema: z.object({}) },
    ],

    async start(extensionCtx) {
      ctx = extensionCtx;
      ctx.log.info("DOMINATRIX extension started");
    },

    async stop() {
      // Clean up pending requests
      for (const [id, pending] of pendingRequests) {
        clearTimeout(pending.timer);
        pending.reject(new Error("Extension shutting down"));
        pendingRequests.delete(id);
      }
      clients.clear();
      ctx.log.info("DOMINATRIX extension stopped");
    },

    async handleMethod(method, params) {
      const handler = methods[method];
      if (!handler) throw new Error(`Unknown method: ${method}`);
      return handler(params);
    },

    health() {
      return {
        ok: clients.size > 0,
        details: { connectedClients: clients.size },
      };
    },
  };
}
