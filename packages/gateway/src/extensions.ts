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
import { createLogger } from "@claudia/shared";
import { join } from "node:path";
import { homedir } from "node:os";
import type { ExtensionHostProcess, ExtensionRegistration } from "./extension-host";

const log = createLogger("ExtensionManager", join(homedir(), ".claudia", "logs", "gateway.log"));

type EventHandler = (event: GatewayEvent) => void | Promise<void>;

export class ExtensionManager {
  private extensions = new Map<string, ClaudiaExtension>();
  private eventHandlers = new Map<string, Set<EventHandler>>();
  private emitCallback: ((type: string, payload: unknown, origin: string) => void) | null = null;

  // Source routing: maps source prefix -> extension ID (or remote host)
  private sourceRoutes = new Map<string, string>();

  // Remote (out-of-process) extensions
  private remoteHosts = new Map<string, ExtensionHostProcess>();
  private remoteRegistrations = new Map<string, ExtensionRegistration>();
  private remoteSourceRoutes = new Map<string, ExtensionHostProcess>();

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

    log.info("Registering extension", { id: extension.id });

    // Create context for this extension
    const ctx = this.createContext(extension.id);

    // Start the extension
    await extension.start(ctx);

    this.extensions.set(extension.id, extension);

    // Register source routes if extension handles any
    if (extension.sourceRoutes?.length) {
      for (const prefix of extension.sourceRoutes) {
        this.sourceRoutes.set(prefix, extension.id);
        log.info("Registered source route", { prefix, extensionId: extension.id });
      }
    }

    log.info("Extension started", { id: extension.id });
  }

  /**
   * Unregister and stop an extension
   */
  async unregister(extensionId: string): Promise<void> {
    const extension = this.extensions.get(extensionId);
    if (!extension) {
      return;
    }

    log.info("Stopping extension", { id: extensionId });
    await extension.stop();
    this.extensions.delete(extensionId);

    // Remove all handlers for this extension
    for (const [_pattern, _handlers] of this.eventHandlers) {
      // Note: We'd need to track which handlers belong to which extension
      // For now, this is a simplified version
    }
  }

  /**
   * Register a remote (out-of-process) extension.
   * Called when an ExtensionHostProcess sends its registration message.
   */
  registerRemote(registration: ExtensionRegistration, host: ExtensionHostProcess): void {
    log.info("Registering remote extension", {
      id: registration.id,
      methods: registration.methods.map((m) => m.name),
    });

    this.remoteHosts.set(registration.id, host);
    this.remoteRegistrations.set(registration.id, registration);

    // Register source routes for remote extension
    for (const prefix of registration.sourceRoutes) {
      this.remoteSourceRoutes.set(prefix, host);
      this.sourceRoutes.set(prefix, registration.id);
      log.info("Registered remote source route", { prefix, extensionId: registration.id });
    }
  }

  /**
   * Unregister a remote extension.
   */
  unregisterRemote(extensionId: string): void {
    this.remoteHosts.delete(extensionId);
    const reg = this.remoteRegistrations.get(extensionId);
    if (reg) {
      for (const prefix of reg.sourceRoutes) {
        this.remoteSourceRoutes.delete(prefix);
        this.sourceRoutes.delete(prefix);
      }
      this.remoteRegistrations.delete(extensionId);
    }
  }

  /**
   * Route a method call to the appropriate extension (local or remote)
   */
  async handleMethod(
    method: string,
    params: Record<string, unknown>,
    connectionId?: string,
  ): Promise<unknown> {
    // Extract extension ID from method (e.g., "voice.speak" -> "voice")
    const [extensionId] = method.split(".");

    // Check remote extensions first
    const remoteHost = this.remoteHosts.get(extensionId);
    if (remoteHost) {
      return remoteHost.callMethod(method, params ?? {}, connectionId);
    }

    // Local extension
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
      const issues = parsed.error.issues.map(
        (i) => `${i.path.join(".") || "params"}: ${i.message}`,
      );
      throw new Error(`Invalid params for ${method}: ${issues.join("; ")}`);
    }

    return extension.handleMethod(method, parsed.data as Record<string, unknown>);
  }

  /**
   * Broadcast an event to all subscribed extensions (local + remote)
   */
  async broadcast(event: GatewayEvent): Promise<void> {
    // Local handlers
    const handlers: EventHandler[] = [];

    for (const [pattern, handlerSet] of this.eventHandlers) {
      if (this.matchesPattern(event.type, pattern)) {
        handlers.push(...handlerSet);
      }
    }

    // Run all local handlers (allow async)
    await Promise.all(handlers.map((handler) => handler(event)));

    // Forward to all remote extension hosts
    for (const host of this.remoteHosts.values()) {
      host.sendEvent(event);
    }
  }

  /**
   * Route a response event back to the source that originated the request
   * Source format: "prefix/id" (e.g., "imessage/+15551234567", "slack/C123")
   */
  async routeToSource(source: string, event: GatewayEvent): Promise<boolean> {
    // Extract prefix from source (e.g., "imessage/+1555..." -> "imessage")
    const prefix = source.split("/")[0];

    // Check remote extension hosts first
    const remoteHost = this.remoteSourceRoutes.get(prefix);
    if (remoteHost) {
      try {
        await remoteHost.routeToSource(source, event);
        return true;
      } catch (error) {
        log.error("Failed to route to remote source", { source, error: String(error) });
        return false;
      }
    }

    // Local extensions
    const extensionId = this.sourceRoutes.get(prefix);
    if (!extensionId) {
      return false;
    }

    const extension = this.extensions.get(extensionId);
    if (!extension?.handleSourceResponse) {
      log.warn("Extension has no handleSourceResponse", { extensionId });
      return false;
    }

    try {
      await extension.handleSourceResponse(source, event);
      return true;
    } catch (error) {
      log.error("Failed to route to source", { source, error: String(error) });
      return false;
    }
  }

  /**
   * Check if a source has a registered route
   */
  hasSourceRoute(source: string): boolean {
    const prefix = source.split("/")[0];
    return this.sourceRoutes.has(prefix);
  }

  /**
   * Get the extension ID that handles a source
   */
  getSourceHandler(source: string): string | undefined {
    const prefix = source.split("/")[0];
    return this.sourceRoutes.get(prefix);
  }

  /**
   * Check if a method is handled by any extension
   */
  hasMethod(method: string): boolean {
    const [extensionId] = method.split(".");

    // Check remote
    const reg = this.remoteRegistrations.get(extensionId);
    if (reg?.methods.some((m) => m.name === method)) return true;

    // Check local
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
    const local = Array.from(this.extensions.values()).map((ext) => ({
      id: ext.id,
      name: ext.name,
      methods: ext.methods.map((m) => m.name),
    }));
    const remote = Array.from(this.remoteRegistrations.values()).map((reg) => ({
      id: reg.id,
      name: reg.name,
      methods: reg.methods.map((m) => m.name),
    }));
    return [...local, ...remote];
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

    // Local extensions (have full Zod schemas)
    for (const extension of this.extensions.values()) {
      for (const method of extension.methods) {
        methods.push({
          extensionId: extension.id,
          extensionName: extension.name,
          method,
        });
      }
    }

    // Remote extensions don't have Zod schemas in the gateway,
    // but we still include them for method.list discovery.
    // The inputSchema will be a plain object (Zod _def), not a ZodType.
    // Validation for remote methods happens in the host process.
    for (const reg of this.remoteRegistrations.values()) {
      for (const method of reg.methods) {
        methods.push({
          extensionId: reg.id,
          extensionName: reg.name,
          method: method as unknown as ExtensionMethodDefinition,
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
    // Local extensions
    for (const [id, extension] of this.extensions) {
      health[id] = extension.health();
    }
    // Remote extensions — report running status (async health check is separate)
    for (const [id, host] of this.remoteHosts) {
      health[id] = { ok: host.isRunning(), details: { remote: true } };
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
   * Kill all remote extension host processes (for gateway shutdown).
   */
  async killRemoteHosts(): Promise<void> {
    for (const [id, host] of this.remoteHosts) {
      log.info("Killing remote extension host", { id });
      await host.kill();
    }
    this.remoteHosts.clear();
    this.remoteRegistrations.clear();
    this.remoteSourceRoutes.clear();
  }

  /**
   * Synchronous force-kill for process "exit" handler (last resort).
   */
  forceKillRemoteHosts(): void {
    for (const [, host] of this.remoteHosts) {
      host.forceKill();
    }
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

      log: createLogger(extensionId, join(homedir(), ".claudia", "logs", `${extensionId}.log`)),
    };
  }

  /**
   * Check if an event type matches a pattern
   */
  private matchesPattern(eventType: string, pattern: string): boolean {
    if (pattern === "*") return true;
    if (pattern === eventType) return true;
    if (pattern.endsWith(".*")) {
      const prefix = pattern.slice(0, -2);
      return eventType.startsWith(prefix + ".");
    }
    return false;
  }
}
