/**
 * Extension Manager
 *
 * Loads, manages, and routes to extensions.
 * Supports source-based routing for responses (e.g., "imessage/+1555..." -> iMessage extension)
 */

import type {
  ClaudiaExtension,
  ExtensionContext,
  ExtensionMethodDefinition,
  GatewayEvent,
} from "@claudia/shared";

type EventHandler = (event: GatewayEvent) => void | Promise<void>;

export class ExtensionManager {
  private extensions = new Map<string, ClaudiaExtension>();
  private eventHandlers = new Map<string, Set<EventHandler>>();
  private emitCallback: ((type: string, payload: unknown, origin: string) => void) | null = null;

  // Source routing: maps source prefix -> extension ID
  private sourceRoutes = new Map<string, string>();

  /**
   * Set the callback for when extensions emit events
   */
  setEmitCallback(callback: (type: string, payload: unknown, source: string) => void): void {
    this.emitCallback = callback;
  }

  /**
   * Register and start an extension
   */
  async register(extension: ClaudiaExtension): Promise<void> {
    if (this.extensions.has(extension.id)) {
      throw new Error(`Extension ${extension.id} already registered`);
    }

    console.log(`[ExtensionManager] Registering extension: ${extension.id}`);

    // Create context for this extension
    const ctx = this.createContext(extension.id);

    // Start the extension
    await extension.start(ctx);

    this.extensions.set(extension.id, extension);

    // Register source routes if extension handles any
    if (extension.sourceRoutes?.length) {
      for (const prefix of extension.sourceRoutes) {
        this.sourceRoutes.set(prefix, extension.id);
        console.log(`[ExtensionManager] Registered source route: ${prefix}/* -> ${extension.id}`);
      }
    }

    console.log(`[ExtensionManager] Extension ${extension.id} started`);
  }

  /**
   * Unregister and stop an extension
   */
  async unregister(extensionId: string): Promise<void> {
    const extension = this.extensions.get(extensionId);
    if (!extension) {
      return;
    }

    console.log(`[ExtensionManager] Stopping extension: ${extensionId}`);
    await extension.stop();
    this.extensions.delete(extensionId);

    // Remove all handlers for this extension
    for (const [_pattern, _handlers] of this.eventHandlers) {
      // Note: We'd need to track which handlers belong to which extension
      // For now, this is a simplified version
    }
  }

  /**
   * Route a method call to the appropriate extension
   */
  async handleMethod(method: string, params: Record<string, unknown>): Promise<unknown> {
    // Extract extension ID from method (e.g., "voice.speak" -> "voice")
    const [extensionId] = method.split('.');

    const extension = this.extensions.get(extensionId);
    if (!extension) {
      throw new Error(`No extension found for method: ${method}`);
    }

    const methodDef = extension.methods.find((m) => m.name === method);
    if (!methodDef) {
      throw new Error(`Extension ${extensionId} does not handle method: ${method}`);
    }

    const parsed = methodDef.inputSchema.safeParse(params ?? {});
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "params"}: ${i.message}`);
      throw new Error(`Invalid params for ${method}: ${issues.join("; ")}`);
    }

    return extension.handleMethod(method, parsed.data as Record<string, unknown>);
  }

  /**
   * Broadcast an event to all subscribed extensions
   */
  async broadcast(event: GatewayEvent): Promise<void> {
    const handlers: EventHandler[] = [];

    for (const [pattern, handlerSet] of this.eventHandlers) {
      if (this.matchesPattern(event.type, pattern)) {
        handlers.push(...handlerSet);
      }
    }

    // Run all handlers (allow async)
    await Promise.all(handlers.map((handler) => handler(event)));
  }

  /**
   * Route a response event back to the source that originated the request
   * Source format: "prefix/id" (e.g., "imessage/+15551234567", "slack/C123")
   */
  async routeToSource(source: string, event: GatewayEvent): Promise<boolean> {
    // Extract prefix from source (e.g., "imessage/+1555..." -> "imessage")
    const prefix = source.split('/')[0];

    const extensionId = this.sourceRoutes.get(prefix);
    if (!extensionId) {
      // No route registered for this source prefix
      return false;
    }

    const extension = this.extensions.get(extensionId);
    if (!extension?.handleSourceResponse) {
      console.warn(`[ExtensionManager] Extension ${extensionId} has no handleSourceResponse`);
      return false;
    }

    try {
      await extension.handleSourceResponse(source, event);
      return true;
    } catch (error) {
      console.error(`[ExtensionManager] Failed to route to source ${source}:`, error);
      return false;
    }
  }

  /**
   * Check if a source has a registered route
   */
  hasSourceRoute(source: string): boolean {
    const prefix = source.split('/')[0];
    return this.sourceRoutes.has(prefix);
  }

  /**
   * Get the extension ID that handles a source
   */
  getSourceHandler(source: string): string | undefined {
    const prefix = source.split('/')[0];
    return this.sourceRoutes.get(prefix);
  }

  /**
   * Check if a method is handled by any extension
   */
  hasMethod(method: string): boolean {
    const [extensionId] = method.split('.');
    const extension = this.extensions.get(extensionId);
    return extension?.methods.some((m) => m.name === method) ?? false;
  }

  /**
   * Get all registered extensions
   */
  getExtensions(): ClaudiaExtension[] {
    return Array.from(this.extensions.values());
  }

  /**
   * Get extension list for discovery (used by Mission Control)
   */
  getExtensionList(): Array<{ id: string; name: string; methods: string[] }> {
    return Array.from(this.extensions.values()).map((ext) => ({
      id: ext.id,
      name: ext.name,
      methods: ext.methods.map((m) => m.name),
    }));
  }

  getMethodDefinitions(): Array<{
    extensionId: string;
    extensionName: string;
    method: ExtensionMethodDefinition;
  }> {
    const methods: Array<{
      extensionId: string;
      extensionName: string;
      method: ExtensionMethodDefinition;
    }> = [];

    for (const extension of this.extensions.values()) {
      for (const method of extension.methods) {
        methods.push({
          extensionId: extension.id,
          extensionName: extension.name,
          method,
        });
      }
    }

    return methods;
  }

  /**
   * Get extension health status
   */
  getHealth(): Record<string, { ok: boolean; details?: Record<string, unknown> }> {
    const health: Record<string, { ok: boolean; details?: Record<string, unknown> }> = {};
    for (const [id, extension] of this.extensions) {
      health[id] = extension.health();
    }
    return health;
  }

  /**
   * Get all registered source routes
   */
  getSourceRoutes(): Record<string, string> {
    const routes: Record<string, string> = {};
    for (const [prefix, extensionId] of this.sourceRoutes) {
      routes[prefix] = extensionId;
    }
    return routes;
  }

  /**
   * Create an extension context
   */
  private createContext(extensionId: string): ExtensionContext {
    return {
      on: (pattern: string, handler: EventHandler) => {
        if (!this.eventHandlers.has(pattern)) {
          this.eventHandlers.set(pattern, new Set());
        }
        this.eventHandlers.get(pattern)!.add(handler);

        // Return unsubscribe function
        return () => {
          this.eventHandlers.get(pattern)?.delete(handler);
        };
      },

      emit: (type: string, payload: unknown) => {
        if (this.emitCallback) {
          this.emitCallback(type, payload, `extension:${extensionId}`);
        }
      },

      config: {}, // TODO: Load from config file

      log: {
        info: (msg: string, ...args: unknown[]) => {
          console.log(`[${extensionId}] ${msg}`, ...args);
        },
        warn: (msg: string, ...args: unknown[]) => {
          console.warn(`[${extensionId}] ${msg}`, ...args);
        },
        error: (msg: string, ...args: unknown[]) => {
          console.error(`[${extensionId}] ${msg}`, ...args);
        },
      },
    };
  }

  /**
   * Check if an event type matches a pattern
   */
  private matchesPattern(eventType: string, pattern: string): boolean {
    if (pattern === '*') return true;
    if (pattern === eventType) return true;
    if (pattern.endsWith('.*')) {
      const prefix = pattern.slice(0, -2);
      return eventType.startsWith(prefix + '.');
    }
    return false;
  }
}
