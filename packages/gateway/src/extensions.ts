/**
 * Extension Manager
 *
 * Loads, manages, and routes to extensions.
 * Supports source-based routing for responses (e.g., "imessage/+1555..." -> iMessage extension)
 */

import type { ExtensionMethodDefinition, GatewayEvent } from "@claudia/shared";
import { createLogger } from "@claudia/shared";
import { join } from "node:path";
import { homedir } from "node:os";
import type { ExtensionHostProcess, ExtensionRegistration } from "./extension-host";

const log = createLogger("ExtensionManager", join(homedir(), ".claudia", "logs", "gateway.log"));

export class ExtensionManager {
  // Source routing: maps source prefix -> extension ID
  private sourceRoutes = new Map<string, string>();

  // Out-of-process extensions
  private remoteHosts = new Map<string, ExtensionHostProcess>();
  private remoteRegistrations = new Map<string, ExtensionRegistration>();
  private remoteSourceRoutes = new Map<string, ExtensionHostProcess>();

  /**
   * Register a remote (out-of-process) extension.
   * Called when an ExtensionHostProcess sends its registration message.
   */
  registerRemote(registration: ExtensionRegistration, host: ExtensionHostProcess): void {
    // Clean up old routes if re-registering (HMR reload)
    if (this.remoteRegistrations.has(registration.id)) {
      log.info("Re-registering extension (HMR)", { id: registration.id });
      this.unregisterRemote(registration.id);
    }

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
      this.remoteRegistrations.delete(extensionId);
      for (const prefix of reg.sourceRoutes) {
        // If another extension also declares this prefix, restore the most
        // recently registered owner; otherwise remove the route.
        const fallback = Array.from(this.remoteRegistrations.entries())
          .reverse()
          .find(([, candidate]) => candidate.sourceRoutes.includes(prefix));

        if (!fallback) {
          this.remoteSourceRoutes.delete(prefix);
          this.sourceRoutes.delete(prefix);
          continue;
        }

        const [fallbackExtensionId] = fallback;
        const fallbackHost = this.remoteHosts.get(fallbackExtensionId);
        if (!fallbackHost) {
          this.remoteSourceRoutes.delete(prefix);
          this.sourceRoutes.delete(prefix);
          continue;
        }

        this.remoteSourceRoutes.set(prefix, fallbackHost);
        this.sourceRoutes.set(prefix, fallbackExtensionId);
      }
    }
  }

  /**
   * Get a remote extension host by ID.
   */
  getHost(extensionId: string): ExtensionHostProcess | undefined {
    return this.remoteHosts.get(extensionId);
  }

  /**
   * Get all registered extension IDs.
   */
  getExtensionIds(): string[] {
    return Array.from(this.remoteHosts.keys());
  }

  /**
   * Route a method call to the appropriate out-of-process extension host.
   * Supports RPC metadata for ctx.call() routing through the hub.
   */
  async handleMethod(
    method: string,
    params: Record<string, unknown>,
    connectionId?: string,
    meta?: { traceId?: string; depth?: number; deadlineMs?: number },
    tags?: string[],
  ): Promise<unknown> {
    // Extract extension ID from method (e.g., "voice.speak" -> "voice")
    const [extensionId] = method.split(".");

    const remoteHost = this.remoteHosts.get(extensionId);
    if (!remoteHost) {
      throw new Error(`No extension found for method: ${method}`);
    }
    return remoteHost.callMethod(method, params ?? {}, connectionId, { ...meta, tags });
  }

  /**
   * Broadcast an event to all out-of-process extension hosts.
   */
  async broadcast(event: GatewayEvent, skipExtensionId?: string): Promise<void> {
    // Forward to all remote extension hosts — skip the emitter extension if requested.
    for (const [extId, host] of this.remoteHosts) {
      if (extId !== skipExtensionId) {
        host.sendEvent(event);
      }
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

    return false;
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
    return false;
  }

  /**
   * Get extension list for discovery (used by Mission Control)
   */
  getExtensionList(): Array<{ id: string; name: string; methods: string[] }> {
    const remote = Array.from(this.remoteRegistrations.values()).map((reg) => ({
      id: reg.id,
      name: reg.name,
      methods: reg.methods.map((m) => m.name),
    }));
    return remote;
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

    // Remote extensions don't have Zod schemas in the gateway,
    // but we still include them for method discovery.
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
    this.sourceRoutes.clear();
  }

  /**
   * Synchronous force-kill for process "exit" handler (last resort).
   */
  forceKillRemoteHosts(): void {
    for (const [, host] of this.remoteHosts) {
      host.forceKill();
    }
    this.remoteHosts.clear();
    this.remoteRegistrations.clear();
    this.remoteSourceRoutes.clear();
    this.sourceRoutes.clear();
  }
}
