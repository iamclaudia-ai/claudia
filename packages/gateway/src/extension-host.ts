/**
 * Extension Host Process
 *
 * Manages a single out-of-process extension via stdio NDJSON.
 * Mirrors the RuntimeSession pattern for spawning + communicating with child processes.
 *
 * The gateway spawns one of these per extension that has `outOfProcess: true`.
 */

import { spawn, type Subprocess } from "bun";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { homedir } from "node:os";
import { createLogger } from "@claudia/shared";
import type { GatewayEvent } from "@claudia/shared";

const log = createLogger("ExtensionHost", join(homedir(), ".claudia", "logs", "gateway.log"));

/** Serialized method info from the host's register message (no Zod schemas) */
export interface RemoteMethodInfo {
  name: string;
  description: string;
}

/** Registration data sent by the host after extension.start() */
export interface ExtensionRegistration {
  id: string;
  name: string;
  methods: RemoteMethodInfo[];
  events: string[];
  sourceRoutes: string[];
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const HOST_SCRIPT = join(import.meta.dir, "..", "..", "extension-host", "src", "index.ts");
const REQUEST_TIMEOUT = 30_000;
const RESTART_DELAY = 2_000;
const MAX_RESTARTS = 5;

export class ExtensionHostProcess {
  private proc: Subprocess | null = null;
  private stdoutBuffer = "";
  private pendingRequests = new Map<string, PendingRequest>();
  private registration: ExtensionRegistration | null = null;
  private registrationResolve: ((reg: ExtensionRegistration) => void) | null = null;
  private restartCount = 0;
  private killed = false;

  constructor(
    private extensionId: string,
    private moduleSpec: string,
    private config: Record<string, unknown>,
    private onEvent: (type: string, payload: unknown) => void,
    private onRegister: (registration: ExtensionRegistration) => void,
  ) {}

  /**
   * Spawn the extension host process and wait for registration.
   */
  async spawn(): Promise<ExtensionRegistration> {
    const configJson = JSON.stringify(this.config);

    log.info("Spawning extension host", {
      extensionId: this.extensionId,
      module: this.moduleSpec,
    });

    this.proc = spawn({
      cmd: ["bun", "--hot", HOST_SCRIPT, this.moduleSpec, configJson],
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      cwd: join(import.meta.dir, "..", "..", ".."), // project root
    });

    this.stdoutBuffer = "";

    if (this.proc.stdout && typeof this.proc.stdout !== "number") {
      this.readStdout(this.proc.stdout);
    }
    if (this.proc.stderr && typeof this.proc.stderr !== "number") {
      this.readStderr(this.proc.stderr);
    }

    this.proc.exited.then((exitCode) => this.handleExit(exitCode));

    // Wait for the register message
    return new Promise<ExtensionRegistration>((resolve, reject) => {
      this.registrationResolve = resolve;

      // Timeout if host doesn't register in time
      setTimeout(() => {
        if (!this.registration) {
          reject(new Error(`Extension host ${this.extensionId} failed to register within 10s`));
        }
      }, 10_000);
    });
  }

  /**
   * Call a method on the extension. Returns a promise that resolves with the result.
   */
  async callMethod(
    method: string,
    params: Record<string, unknown>,
    connectionId?: string,
  ): Promise<unknown> {
    return this.sendRequest(method, params, connectionId);
  }

  /**
   * Forward an event to the extension host (so extension handlers can process it).
   */
  sendEvent(event: GatewayEvent): void {
    this.writeToStdin({
      type: "event",
      event: event.type,
      payload: event.payload,
      origin: event.origin,
      source: event.source,
      sessionId: event.sessionId,
      connectionId: event.connectionId,
    });
  }

  /**
   * Route a source response to the extension.
   */
  async routeToSource(source: string, event: GatewayEvent): Promise<void> {
    await this.sendRequest("__sourceResponse", { source, event });
  }

  /**
   * Get the extension's health status.
   */
  async health(): Promise<{ ok: boolean; details?: Record<string, unknown> }> {
    if (!this.proc) {
      return { ok: false, details: { status: "not_running" } };
    }
    try {
      const result = (await this.sendRequest("__health", {})) as {
        ok: boolean;
        details?: Record<string, unknown>;
      };
      return result;
    } catch {
      return { ok: false, details: { status: "health_check_failed" } };
    }
  }

  /**
   * Get the registration info (methods, events, source routes).
   */
  getRegistration(): ExtensionRegistration | null {
    return this.registration;
  }

  /**
   * Whether the process is currently running.
   */
  isRunning(): boolean {
    return this.proc !== null;
  }

  /**
   * Kill the host process. Used during gateway shutdown.
   */
  async kill(): Promise<void> {
    this.killed = true;
    if (this.proc) {
      // Close stdin first — the host process exits cleanly when stdin closes
      try {
        const stdin = this.proc.stdin;
        if (stdin && typeof stdin !== "number") {
          (stdin as unknown as { close?: () => void }).close?.();
        }
      } catch {
        // Ignore stdin close errors
      }
      this.proc.kill("SIGTERM");
      this.proc = null;
    }
    // Reject all pending requests
    for (const [id, pending] of this.pendingRequests) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Extension host killed"));
      this.pendingRequests.delete(id);
    }
  }

  /**
   * Synchronous force-kill (for process "exit" handler where async isn't possible).
   */
  forceKill(): void {
    this.killed = true;
    if (this.proc) {
      try {
        this.proc.kill("SIGKILL");
      } catch {
        // Process may already be dead
      }
      this.proc = null;
    }
  }

  // ── Private ──────────────────────────────────────────────────

  private async sendRequest(
    method: string,
    params: Record<string, unknown>,
    connectionId?: string,
  ): Promise<unknown> {
    if (!this.proc) {
      throw new Error(`Extension host ${this.extensionId} is not running`);
    }

    const id = randomUUID();

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`Request ${method} timed out after ${REQUEST_TIMEOUT}ms`));
      }, REQUEST_TIMEOUT);

      this.pendingRequests.set(id, { resolve, reject, timer });

      this.writeToStdin({ type: "req", id, method, params, connectionId });
    });
  }

  private writeToStdin(msg: unknown): void {
    const stdin = this.proc?.stdin;
    if (!stdin || typeof stdin === "number") {
      log.warn("Cannot write to extension host stdin", { extensionId: this.extensionId });
      return;
    }

    try {
      stdin.write(JSON.stringify(msg) + "\n");
    } catch (error) {
      log.error("Failed to write to extension host stdin", {
        extensionId: this.extensionId,
        error: String(error),
      });
    }
  }

  private async readStdout(stdout: ReadableStream<Uint8Array>): Promise<void> {
    const reader = stdout.getReader();
    const decoder = new TextDecoder();

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        this.stdoutBuffer += decoder.decode(value, { stream: true });

        let newlineIndex: number;
        while ((newlineIndex = this.stdoutBuffer.indexOf("\n")) !== -1) {
          const line = this.stdoutBuffer.slice(0, newlineIndex).trim();
          this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1);

          if (line.length > 0) {
            this.handleLine(line);
          }
        }
      }
    } catch {
      // Stream closed — process exited
    }
  }

  private async readStderr(stderr: ReadableStream<Uint8Array>): Promise<void> {
    const reader = stderr.getReader();
    const decoder = new TextDecoder();

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const text = decoder.decode(value, { stream: true });
        if (text.trim()) {
          log.warn(`[${this.extensionId}] stderr`, { text: text.trim().substring(0, 500) });
        }
      }
    } catch {
      // Stream closed
    }
  }

  private handleLine(line: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(line);
    } catch {
      log.warn("Invalid JSON from extension host", {
        extensionId: this.extensionId,
        line: line.slice(0, 100),
      });
      return;
    }

    const msgType = msg.type as string;

    if (msgType === "register") {
      // Extension registered — store metadata and notify gateway
      this.registration = msg.extension as ExtensionRegistration;
      log.info("Extension registered", {
        id: this.registration.id,
        name: this.registration.name,
        methods: this.registration.methods.map((m) => m.name),
      });
      this.onRegister(this.registration);
      if (this.registrationResolve) {
        this.registrationResolve(this.registration);
        this.registrationResolve = null;
      }
    } else if (msgType === "res") {
      // Response to a pending request
      const id = msg.id as string;
      const pending = this.pendingRequests.get(id);
      if (pending) {
        clearTimeout(pending.timer);
        this.pendingRequests.delete(id);
        if (msg.ok) {
          pending.resolve(msg.payload);
        } else {
          pending.reject(new Error(msg.error as string));
        }
      }
    } else if (msgType === "event") {
      // Extension emitted an event — forward to gateway
      this.onEvent(msg.event as string, msg.payload);
    } else if (msgType === "error") {
      // Fatal error from host
      log.error("Extension host error", {
        extensionId: this.extensionId,
        error: msg.error,
      });
    }
  }

  private handleExit(exitCode: number | null): void {
    log.info("Extension host exited", {
      extensionId: this.extensionId,
      exitCode,
      killed: this.killed,
    });

    this.proc = null;

    // Reject all pending requests
    for (const [id, pending] of this.pendingRequests) {
      clearTimeout(pending.timer);
      pending.reject(new Error(`Extension host ${this.extensionId} exited with code ${exitCode}`));
      this.pendingRequests.delete(id);
    }

    // Auto-restart unless we were explicitly killed
    if (!this.killed && this.restartCount < MAX_RESTARTS) {
      this.restartCount++;
      log.info("Auto-restarting extension host", {
        extensionId: this.extensionId,
        attempt: this.restartCount,
        maxRestarts: MAX_RESTARTS,
        delayMs: RESTART_DELAY,
      });
      setTimeout(() => {
        this.spawn().catch((error) => {
          log.error("Failed to restart extension host", {
            extensionId: this.extensionId,
            error: String(error),
          });
        });
      }, RESTART_DELAY);
    } else if (!this.killed) {
      log.error("Extension host exceeded max restarts", {
        extensionId: this.extensionId,
        maxRestarts: MAX_RESTARTS,
      });
    }
  }
}
