#!/usr/bin/env bun
/**
 * Claudia CLI - Gateway client
 *
 * Usage:
 *   claudia "Hello, how are you?"
 *   claudia workspace list
 *   claudia session send_prompt --sessionId ses_123 --content "Hello"
 *   claudia voice speak --text "Hello"
 *   claudia methods
 */

const GATEWAY_URL = process.env.CLAUDIA_GATEWAY_URL || "ws://localhost:30086/ws";

interface Message {
  type: "req" | "res" | "event";
  id?: string;
  method?: string;
  params?: Record<string, unknown>;
  ok?: boolean;
  payload?: unknown;
  error?: string;
  event?: string;
}

export interface JsonSchema {
  $ref?: string;
  $defs?: Record<string, JsonSchema>;
  definitions?: Record<string, JsonSchema>;
  type?: string;
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean;
  anyOf?: JsonSchema[];
  allOf?: JsonSchema[];
  enum?: unknown[];
  items?: JsonSchema | JsonSchema[];
}

export interface MethodCatalogEntry {
  method: string;
  source: "gateway" | "extension";
  extensionId?: string;
  extensionName?: string;
  description?: string;
  inputSchema?: JsonSchema;
}

function generateId(): string {
  return Math.random().toString(36).slice(2, 10);
}

export function coerceValue(value: string): unknown {
  if (value === "true") return true;
  if (value === "false") return false;
  if (value === "null") return null;

  if (/^-?\d+(\.\d+)?$/.test(value)) {
    const num = Number(value);
    if (Number.isFinite(num)) return num;
  }

  if (
    (value.startsWith("{") && value.endsWith("}")) ||
    (value.startsWith("[") && value.endsWith("]"))
  ) {
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }

  return value;
}

export function parseCliParams(rawArgs: string[]): Record<string, unknown> {
  const params: Record<string, unknown> = {};

  for (let i = 0; i < rawArgs.length; i += 1) {
    const token = rawArgs[i];
    if (!token.startsWith("--")) {
      throw new Error(`Unexpected positional argument: ${token}. Use --name value.`);
    }

    const flag = token.slice(2);
    if (!flag) throw new Error("Invalid flag: --");

    const eqIdx = flag.indexOf("=");
    if (eqIdx >= 0) {
      const key = flag.slice(0, eqIdx);
      const raw = flag.slice(eqIdx + 1);
      params[key] = coerceValue(raw);
      continue;
    }

    const next = rawArgs[i + 1];
    if (!next || next.startsWith("--")) {
      params[flag] = true;
      continue;
    }

    params[flag] = coerceValue(next);
    i += 1;
  }

  return params;
}

export function resolveRef(root: JsonSchema, ref: string): JsonSchema | undefined {
  if (!ref.startsWith("#/")) return undefined;
  const segments = ref
    .slice(2)
    .split("/")
    .map((s) => s.replace(/~1/g, "/").replace(/~0/g, "~"));
  let current: unknown = root;
  for (const segment of segments) {
    if (
      !current ||
      typeof current !== "object" ||
      !(segment in (current as Record<string, unknown>))
    ) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current as JsonSchema;
}

export function resolveSchema(
  schema: JsonSchema | undefined,
  root: JsonSchema | undefined,
  depth = 0,
): JsonSchema | undefined {
  if (!schema) return undefined;
  if (!root) return schema;
  if (!schema.$ref || depth > 20) return schema;

  const referenced = resolveRef(root, schema.$ref);
  if (!referenced) return schema;

  const resolvedRef = resolveSchema(referenced, root, depth + 1) ?? referenced;
  const { $ref: _unusedRef, ...inlineOverrides } = schema;
  return { ...resolvedRef, ...inlineOverrides };
}

export function schemaType(schema?: JsonSchema, root?: JsonSchema): string {
  const resolved = resolveSchema(schema, root ?? schema) ?? schema;
  if (!resolved) return "unknown";
  if (resolved.type) return resolved.type;
  if (resolved.anyOf?.length) {
    return resolved.anyOf.map((s) => schemaType(s, root ?? resolved)).join("|");
  }
  if (resolved.allOf?.length) {
    return resolved.allOf.map((s) => schemaType(s, root ?? resolved)).join("&");
  }
  return "unknown";
}

export function matchesSchemaType(value: unknown, schema: JsonSchema, root: JsonSchema): boolean {
  const resolved = resolveSchema(schema, root) ?? schema;
  if (resolved.anyOf?.length) return resolved.anyOf.some((s) => matchesSchemaType(value, s, root));
  if (resolved.allOf?.length) return resolved.allOf.every((s) => matchesSchemaType(value, s, root));
  if (resolved.enum && !resolved.enum.includes(value)) return false;

  switch (resolved.type) {
    case undefined:
      return true;
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "boolean":
      return typeof value === "boolean";
    case "null":
      return value === null;
    case "array": {
      if (!Array.isArray(value)) return false;
      if (!resolved.items) return true;
      if (Array.isArray(resolved.items)) return true;
      return value.every((v) => matchesSchemaType(v, resolved.items as JsonSchema, root));
    }
    case "object":
      return value !== null && typeof value === "object" && !Array.isArray(value);
    default:
      return true;
  }
}

export function validateParamsAgainstSchema(
  method: string,
  params: Record<string, unknown>,
  schema?: JsonSchema,
): void {
  if (!schema) return;
  const root = schema;
  const resolvedSchema = resolveSchema(schema, root) ?? schema;
  if (resolvedSchema.type !== "object") return;

  const required = resolvedSchema.required ?? [];
  const missing = required.filter((k) => !(k in params));
  if (missing.length > 0) {
    throw new Error(`Missing required params for ${method}: ${missing.join(", ")}`);
  }

  const properties = resolvedSchema.properties ?? {};
  if (resolvedSchema.additionalProperties === false) {
    const allowed = new Set(Object.keys(properties));
    const unknown = Object.keys(params).filter((k) => !allowed.has(k));
    if (unknown.length > 0) {
      throw new Error(`Unknown params for ${method}: ${unknown.join(", ")}`);
    }
  }

  for (const [key, value] of Object.entries(params)) {
    const propSchema = properties[key];
    if (!propSchema) continue;
    if (!matchesSchemaType(value, propSchema, root)) {
      const expectedType = schemaType(propSchema, root);
      const actualType = value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
      throw new Error(
        `Invalid type for ${method}.${key}: expected ${expectedType}, got ${actualType}`,
      );
    }
  }
}

export function splitMethod(method: string): { namespace: string; action: string } | null {
  const idx = method.indexOf(".");
  if (idx <= 0 || idx >= method.length - 1) return null;
  return {
    namespace: method.slice(0, idx),
    action: method.slice(idx + 1),
  };
}

export function formatFlagPlaceholder(name: string, required: boolean): string {
  const token = name.toUpperCase();
  return required ? `<${token}>` : `[${token}]`;
}

export function formatMethodCommand(entry: MethodCatalogEntry): string {
  const split = splitMethod(entry.method);
  if (!split) return `claudia ${entry.method}`;

  const rootSchema = entry.inputSchema;
  const schema = resolveSchema(rootSchema, rootSchema) ?? rootSchema;
  if (!schema || schema.type !== "object") {
    return `claudia ${split.namespace} ${split.action}`;
  }

  const required = new Set(schema.required ?? []);
  const props = schema.properties ? Object.entries(schema.properties) : [];
  const flagParts = props.map(
    ([name]) => `--${name} ${formatFlagPlaceholder(name, required.has(name))}`,
  );

  const suffix = flagParts.length > 0 ? ` ${flagParts.join(" ")}` : "";
  return `claudia ${split.namespace} ${split.action}${suffix}`;
}

export function printMethodHelp(entry: MethodCatalogEntry): void {
  const split = splitMethod(entry.method);
  const command = split ? `claudia ${split.namespace} ${split.action}` : `claudia ${entry.method}`;

  console.log(`\n`);
  if (entry.description) console.log(`  ${entry.description}`);
  console.log(`  Usage: ${formatMethodCommand(entry)}`);

  const rootSchema = entry.inputSchema;
  const schema = resolveSchema(rootSchema, rootSchema) ?? rootSchema;
  if (!schema || schema.type !== "object") {
    console.log("  No input schema available.");
    return;
  }

  const required = new Set(schema.required ?? []);
  const props = schema.properties ? Object.entries(schema.properties) : [];
  if (props.length === 0) {
    console.log("  No parameters.");
    return;
  }

  console.log("  Parameters:");
  for (const [name, prop] of props) {
    const req = required.has(name) ? "required" : "optional";
    const resolvedProp = resolveSchema(prop, rootSchema) ?? prop;
    const type = schemaType(resolvedProp, rootSchema);
    const desc = resolvedProp.description ? ` - ${resolvedProp.description}` : "";
    const placeholder = formatFlagPlaceholder(name, required.has(name));
    console.log(`    --${name} ${placeholder} (${type}, ${req})${desc}`);
  }
}

export function exampleValueForSchema(
  schema: JsonSchema | undefined,
  root: JsonSchema | undefined,
): string {
  const resolved = resolveSchema(schema, root) ?? schema;
  if (!resolved) return '"value"';

  if (resolved.enum && resolved.enum.length > 0) {
    return JSON.stringify(resolved.enum[0]);
  }

  if (resolved.anyOf && resolved.anyOf.length > 0) {
    return exampleValueForSchema(resolved.anyOf[0], root);
  }
  if (resolved.allOf && resolved.allOf.length > 0) {
    return exampleValueForSchema(resolved.allOf[0], root);
  }

  switch (resolved.type) {
    case "string":
      return '"value"';
    case "number":
      return "1.23";
    case "integer":
      return "1";
    case "boolean":
      return "true";
    case "null":
      return "null";
    case "array":
      if (Array.isArray(resolved.items) || !resolved.items) return "'[]'";
      return `'[${exampleValueForSchema(resolved.items, root)}]'`;
    case "object":
      return "'{}'";
    default:
      return '"value"';
  }
}

export function printMethodExamples(entry: MethodCatalogEntry): void {
  const split = splitMethod(entry.method);
  const command = split ? `${split.namespace} ${split.action}` : entry.method;
  console.log(`\nclaudia ${command} examples`);

  const rootSchema = entry.inputSchema;
  const schema = resolveSchema(rootSchema, rootSchema) ?? rootSchema;
  if (!schema || schema.type !== "object") {
    console.log(`  claudia ${command}`);
    return;
  }

  const props = schema.properties ? Object.entries(schema.properties) : [];
  const required = new Set(schema.required ?? []);
  if (!split) {
    console.log(`  claudia ${entry.method}`);
    return;
  }

  const requiredFlags = props
    .filter(([name]) => required.has(name))
    .map(([name, prop]) => `--${name} ${exampleValueForSchema(prop, rootSchema)}`);

  const optionalFlags = props
    .filter(([name]) => !required.has(name))
    .map(([name, prop]) => `--${name} ${exampleValueForSchema(prop, rootSchema)}`);

  if (requiredFlags.length === 0 && optionalFlags.length === 0) {
    console.log(`  claudia ${split.namespace} ${split.action}`);
    return;
  }

  const requiredCmd =
    `claudia ${split.namespace} ${split.action} ${requiredFlags.join(" ")}`.trim();
  console.log(`  ${requiredCmd}`);

  if (optionalFlags.length > 0) {
    const mixed =
      `${requiredCmd} ${optionalFlags.slice(0, Math.min(2, optionalFlags.length)).join(" ")}`.trim();
    console.log(`  ${mixed}`);
  }
}

export function getNamespaces(methods: MethodCatalogEntry[]): string[] {
  const names = new Set<string>();
  for (const m of methods) {
    const split = splitMethod(m.method);
    names.add(split ? split.namespace : m.method);
  }
  return Array.from(names).sort();
}

export function printNamespaceHelp(namespace: string, methods: MethodCatalogEntry[]): void {
  const rows = methods
    .filter((m) => splitMethod(m.method)?.namespace === namespace)
    .sort((a, b) => a.method.localeCompare(b.method));

  if (rows.length === 0) {
    console.error(`Unknown namespace: ${namespace}`);
    return;
  }

  console.log(`\nNamespace: ${namespace}`);
  for (const entry of rows) {
    console.log(`  ${formatMethodCommand(entry)}`);
  }
}

export function printMethodList(methods: MethodCatalogEntry[], namespace?: string): void {
  const sorted = [...methods].sort((a, b) => a.method.localeCompare(b.method));
  const filtered = namespace
    ? sorted.filter((m) => splitMethod(m.method)?.namespace === namespace)
    : sorted;

  if (namespace && filtered.length === 0) {
    console.error(`Unknown namespace: ${namespace}`);
    return;
  }

  console.log("Available commands:\n");
  for (const entry of filtered) {
    console.log(`  ${formatMethodCommand(entry)}`);
  }
}

export function printCliHelp(methods: MethodCatalogEntry[]): void {
  console.log("Usage:\n");
  console.log("  claudia <namespace> <action> --param value");
  console.log("  claudia <namespace> <action> --help");
  console.log("  claudia <namespace> <action> --examples");
  console.log("  claudia <namespace> --help");
  console.log("  claudia methods [namespace]");

  console.log("\nNamespaces:\n");
  for (const ns of getNamespaces(methods)) {
    console.log(`  ${ns}`);
  }
}

async function fetchMethodCatalog(): Promise<MethodCatalogEntry[]> {
  const ws = new WebSocket(GATEWAY_URL);

  return new Promise((resolve, reject) => {
    const reqId = generateId();

    ws.onopen = () => {
      const msg: Message = { type: "req", id: reqId, method: "gateway.list_methods", params: {} };
      ws.send(JSON.stringify(msg));
    };

    ws.onmessage = (event) => {
      try {
        const msg: Message = JSON.parse(event.data as string);
        if (msg.type !== "res" || msg.id !== reqId) return;

        if (!msg.ok) {
          ws.close();
          reject(new Error(msg.error || "gateway.list_methods failed"));
          return;
        }

        const payload = (msg.payload || {}) as { methods?: MethodCatalogEntry[] };
        ws.close();
        resolve(payload.methods ?? []);
      } catch (err) {
        ws.close();
        reject(err);
      }
    };

    ws.onerror = (error) => {
      reject(error);
    };
  });
}

async function invokeMethod(method: string, params: Record<string, unknown>): Promise<void> {
  const ws = new WebSocket(GATEWAY_URL);

  return new Promise((resolve, reject) => {
    const reqId = generateId();
    const streamPrompt = method === "session.send_prompt";
    let gotFinalStreamEvent = false;
    let gotResponse = false;

    ws.onopen = () => {
      if (streamPrompt) {
        const subMsg: Message = {
          type: "req",
          id: generateId(),
          method: "subscribe",
          params: { events: ["stream.*"] },
        };
        ws.send(JSON.stringify(subMsg));
      }

      const req: Message = { type: "req", id: reqId, method, params };
      ws.send(JSON.stringify(req));
    };

    ws.onmessage = (event) => {
      const msg: Message = JSON.parse(event.data as string);

      if (msg.type === "res" && msg.id === reqId) {
        gotResponse = true;
        if (!msg.ok) {
          ws.close();
          reject(new Error(msg.error || `Request failed: ${method}`));
          return;
        }

        if (!streamPrompt) {
          if (msg.payload !== undefined) {
            console.log(JSON.stringify(msg.payload, null, 2));
          }
          ws.close();
          resolve();
        }
        return;
      }

      if (!streamPrompt || msg.type !== "event") return;

      const payload = (msg.payload || {}) as Record<string, unknown>;
      if (msg.event?.includes(".content_block_delta")) {
        const delta = payload.delta as { type?: string; text?: string } | undefined;
        if (delta?.type === "text_delta" && delta.text) {
          process.stdout.write(delta.text);
        }
      }

      if (msg.event?.includes(".message_stop")) {
        gotFinalStreamEvent = true;
        process.stdout.write("\n");
        ws.close();
        resolve();
      }
    };

    ws.onerror = (error) => {
      reject(error);
    };

    ws.onclose = () => {
      if (streamPrompt && gotResponse && !gotFinalStreamEvent) {
        resolve();
      }
    };
  });
}

async function speak(text: string): Promise<void> {
  const ws = new WebSocket(GATEWAY_URL);

  return new Promise((resolve, reject) => {
    ws.onopen = () => {
      ws.send(
        JSON.stringify({
          type: "req",
          id: generateId(),
          method: "subscribe",
          params: { events: ["voice.*"] },
        }),
      );

      ws.send(
        JSON.stringify({
          type: "req",
          id: generateId(),
          method: "voice.speak",
          params: { text },
        }),
      );
    };

    ws.onmessage = async (event) => {
      const msg: Message = JSON.parse(event.data as string);

      if (msg.type === "res" && !msg.ok) {
        ws.close();
        reject(new Error(msg.error));
        return;
      }

      if (msg.type !== "event") return;

      if (msg.event === "voice.audio") {
        const payload = msg.payload as { format: string; data: string };
        const audioBuffer = Buffer.from(payload.data, "base64");
        const ext = payload.format === "wav" ? "wav" : payload.format || "bin";
        const tempFile = `/tmp/claudia-speech-${Date.now()}.${ext}`;
        await Bun.write(tempFile, audioBuffer);

        const proc = Bun.spawn(["afplay", tempFile], { stdout: "ignore", stderr: "ignore" });
        await proc.exited;
        if (await Bun.file(tempFile).exists()) {
          Bun.spawn(["rm", tempFile]);
        }
      } else if (msg.event === "voice.done") {
        ws.close();
        resolve();
      } else if (msg.event === "voice.error") {
        const payload = msg.payload as { error: string };
        ws.close();
        reject(new Error(payload.error));
      }
    };

    ws.onerror = (error) => reject(error);
  });
}

async function promptCompat(args: string[]): Promise<void> {
  let prompt = args.join(" ");
  if (prompt.startsWith("-p ")) {
    prompt = prompt.slice(3);
  }

  if (!prompt) {
    const stdin = await Bun.stdin.text();
    prompt = stdin.trim();
  }

  if (!prompt) {
    console.error('Usage: claudia "your message here"');
    process.exit(1);
  }

  const ws = new WebSocket(GATEWAY_URL);
  let responseText = "";
  let isComplete = false;
  let sessionRecordId: string | null = null;
  const pendingMethods = new Map<string, string>();

  const sendRequest = (method: string, params?: Record<string, unknown>) => {
    const id = generateId();
    pendingMethods.set(id, method);
    const msg: Message = { type: "req", id, method, params };
    ws.send(JSON.stringify(msg));
  };

  ws.onopen = () => {
    sendRequest("subscribe", { events: ["stream.*"] });
    sendRequest("session.get_or_create_workspace", { cwd: process.cwd() });
  };

  ws.onmessage = (event) => {
    const msg: Message = JSON.parse(event.data as string);

    if (msg.type === "res" && msg.ok) {
      const method = msg.id ? pendingMethods.get(msg.id) : undefined;
      if (msg.id) pendingMethods.delete(msg.id);
      const payload = (msg.payload || {}) as Record<string, unknown>;

      if (method === "session.get_or_create_workspace") {
        // Workspace exists, now find sessions
        sendRequest("session.list_sessions", { cwd: process.cwd() });
        return;
      }

      if (method === "session.list_sessions") {
        const sessions = payload.sessions as { sessionId: string }[] | undefined;
        if (sessions && sessions.length > 0) {
          sessionRecordId = sessions[0].sessionId;
          console.error(`[session] Reusing ${sessionRecordId}`);
        } else {
          sendRequest("session.create_session", { cwd: process.cwd() });
          return;
        }
      }

      if (method === "session.create_session") {
        const sid = payload.sessionId as string | undefined;
        if (sid) {
          sessionRecordId = sid;
          console.error(`[session] Created ${sessionRecordId}`);
        }
      }

      if (
        (method === "session.list_sessions" || method === "session.create_session") &&
        sessionRecordId
      ) {
        sendRequest("session.send_prompt", {
          sessionId: sessionRecordId,
          content: prompt,
        });
      }
    }

    if (msg.type === "event") {
      const payload = msg.payload as Record<string, unknown>;
      if (msg.event?.includes(".content_block_delta")) {
        const delta = payload.delta as { type: string; text?: string } | undefined;
        if (delta?.type === "text_delta" && delta.text) {
          process.stdout.write(delta.text);
          responseText += delta.text;
        }
      } else if (msg.event?.includes(".message_stop")) {
        isComplete = true;
        if (responseText && !responseText.endsWith("\n")) console.log();
        ws.close();
      }
    } else if (msg.type === "res" && !msg.ok) {
      console.error("Error:", msg.error);
      ws.close();
      process.exit(1);
    }
  };

  ws.onerror = (error) => {
    console.error("WebSocket error:", error);
    process.exit(1);
  };

  ws.onclose = () => {
    if (!isComplete && !responseText) {
      console.error("Connection closed before response");
      process.exit(1);
    }
    process.exit(0);
  };

  process.on("SIGINT", () => {
    console.log("\nInterrupted");
    ws.close();
    process.exit(0);
  });
}

// ── Watchdog CLI ─────────────────────────────────────────

const WATCHDOG_URL = process.env.CLAUDIA_WATCHDOG_URL || "http://localhost:30085";

const WATCHDOG_METHODS: MethodCatalogEntry[] = [
  {
    method: "watchdog.status",
    source: "gateway",
    description: "Show watchdog and service health status",
  },
  {
    method: "watchdog.restart",
    source: "gateway",
    description: "Restart a managed service (gateway or runtime)",
    inputSchema: {
      type: "object",
      properties: {
        service: { type: "string", description: "Service to restart: gateway or runtime" },
      },
      required: ["service"],
    },
  },
  {
    method: "watchdog.logs",
    source: "gateway",
    description: "List available log files",
  },
  {
    method: "watchdog.log_tail",
    source: "gateway",
    description: "Tail a log file",
    inputSchema: {
      type: "object",
      properties: {
        file: { type: "string", description: "Log file name (e.g. gateway.log)" },
        lines: { type: "integer", description: "Number of lines to show (default: 50)" },
      },
      required: ["file"],
    },
  },
  {
    method: "watchdog.install",
    source: "gateway",
    description: "Install watchdog as a launchd service (start on login)",
  },
  {
    method: "watchdog.uninstall",
    source: "gateway",
    description: "Uninstall watchdog launchd service",
  },
];

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

async function watchdogCommand(args: string[]): Promise<void> {
  const sub = args[0];

  if (!sub || sub === "--help") {
    console.log("\nwatchdog commands:\n");
    console.log("  claudia watchdog status                  Show service health");
    console.log("  claudia watchdog restart <service>       Restart gateway or runtime");
    console.log("  claudia watchdog logs                    List available log files");
    console.log("  claudia watchdog logs <file> [lines]     Tail a log file");
    console.log("  claudia watchdog install                 Install as launchd service");
    console.log("  claudia watchdog uninstall               Uninstall launchd service");
    return;
  }

  if (sub === "status") {
    try {
      const res = await fetch(`${WATCHDOG_URL}/status`, { signal: AbortSignal.timeout(3000) });
      const data = (await res.json()) as Record<
        string,
        {
          name: string;
          tmuxAlive: boolean;
          healthy: boolean;
          consecutiveFailures: number;
          lastRestart: string | null;
        }
      >;
      console.log();
      for (const [id, s] of Object.entries(data)) {
        const dot = s.healthy
          ? "\x1b[32m●\x1b[0m"
          : s.tmuxAlive
            ? "\x1b[33m●\x1b[0m"
            : "\x1b[31m●\x1b[0m";
        const status = s.healthy ? "healthy" : s.tmuxAlive ? "unhealthy" : "down";
        const restart = s.lastRestart ? new Date(s.lastRestart).toLocaleTimeString() : "never";
        console.log(
          `  ${dot} ${s.name.padEnd(10)} ${status.padEnd(12)} failures: ${s.consecutiveFailures}  last restart: ${restart}`,
        );
      }
      console.log();
    } catch {
      console.error("Error: Could not connect to watchdog at", WATCHDOG_URL);
      console.error("Is the watchdog running? Start with: bun run watchdog");
      process.exit(1);
    }
    return;
  }

  if (sub === "restart") {
    const service = args[1];
    if (!service) {
      console.error("Usage: claudia watchdog restart <gateway|runtime>");
      process.exit(1);
    }
    try {
      const res = await fetch(`${WATCHDOG_URL}/restart/${service}`, {
        method: "POST",
        signal: AbortSignal.timeout(10000),
      });
      const data = (await res.json()) as { ok: boolean; message: string };
      console.log(data.ok ? `✓ ${data.message}` : `✗ ${data.message}`);
    } catch {
      console.error("Error: Could not connect to watchdog at", WATCHDOG_URL);
      process.exit(1);
    }
    return;
  }

  if (sub === "logs") {
    const file = args[1];

    if (!file) {
      // List log files
      try {
        const res = await fetch(`${WATCHDOG_URL}/api/logs`, { signal: AbortSignal.timeout(3000) });
        const data = (await res.json()) as {
          files: { name: string; size: number; modified: string }[];
        };
        console.log("\nAvailable log files:\n");
        for (const f of data.files) {
          const mod = new Date(f.modified).toLocaleString();
          console.log(`  ${f.name.padEnd(25)} ${formatBytes(f.size).padStart(8)}  ${mod}`);
        }
        console.log(`\nTail a file: claudia watchdog logs <filename> [lines]\n`);
      } catch {
        console.error("Error: Could not connect to watchdog at", WATCHDOG_URL);
        process.exit(1);
      }
      return;
    }

    // Tail a specific log file
    const lineCount = parseInt(args[2] || "50", 10);
    try {
      const res = await fetch(
        `${WATCHDOG_URL}/api/logs/${encodeURIComponent(file)}?lines=${lineCount}`,
        { signal: AbortSignal.timeout(5000) },
      );
      const data = (await res.json()) as { lines?: string[]; error?: string; fileSize?: number };
      if (data.error) {
        console.error(`Error: ${data.error}`);
        process.exit(1);
      }
      if (data.lines) {
        for (const line of data.lines) {
          // Colorize output
          if (line.includes("[ERROR]")) {
            console.log(`\x1b[31m${line}\x1b[0m`);
          } else if (line.includes("[WARN]")) {
            console.log(`\x1b[33m${line}\x1b[0m`);
          } else {
            console.log(line);
          }
        }
        if (data.fileSize) {
          console.log(
            `\n\x1b[90m--- ${data.lines.length} lines (${formatBytes(data.fileSize)} total) ---\x1b[0m`,
          );
        }
      }
    } catch {
      console.error("Error: Could not connect to watchdog at", WATCHDOG_URL);
      process.exit(1);
    }
    return;
  }

  if (sub === "install") {
    const plistName = "com.claudia.watchdog.plist";
    const plistSrc = `${import.meta.dir}/../../../scripts/${plistName}`;
    const plistDst = `${process.env.HOME}/Library/LaunchAgents/${plistName}`;

    try {
      const srcFile = Bun.file(plistSrc);
      if (!(await srcFile.exists())) {
        console.error(`Error: Plist not found at ${plistSrc}`);
        process.exit(1);
      }

      await Bun.write(plistDst, srcFile);
      console.log(`Copied plist to ${plistDst}`);

      const load = Bun.spawn(["launchctl", "load", plistDst], {
        stdout: "inherit",
        stderr: "inherit",
      });
      await load.exited;
      console.log("✓ Watchdog installed and loaded. It will start on login.");
    } catch (err) {
      console.error("Error:", err instanceof Error ? err.message : err);
      process.exit(1);
    }
    return;
  }

  if (sub === "uninstall") {
    const plistName = "com.claudia.watchdog.plist";
    const plistDst = `${process.env.HOME}/Library/LaunchAgents/${plistName}`;

    try {
      const unload = Bun.spawn(["launchctl", "unload", plistDst], {
        stdout: "inherit",
        stderr: "inherit",
      });
      await unload.exited;

      const file = Bun.file(plistDst);
      if (await file.exists()) {
        const { unlinkSync } = await import("node:fs");
        unlinkSync(plistDst);
      }
      console.log("✓ Watchdog uninstalled and unloaded.");
    } catch (err) {
      console.error("Error:", err instanceof Error ? err.message : err);
      process.exit(1);
    }
    return;
  }

  console.error(`Unknown watchdog command: ${sub}`);
  console.error("Run 'claudia watchdog --help' for usage.");
  process.exit(1);
}

// ── Main ─────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args[0] === "speak") {
    const text = args.slice(1).join(" ");
    if (!text) {
      console.error('Usage: claudia speak "text to speak"');
      process.exit(1);
    }
    await speak(text);
    return;
  }

  if (args[0] === "watchdog") {
    await watchdogCommand(args.slice(1));
    return;
  }

  const methods = [...(await fetchMethodCatalog()), ...WATCHDOG_METHODS];
  const methodMap = new Map(methods.map((m) => [m.method, m] as const));

  if (args.length === 0) {
    await promptCompat(args);
    return;
  }

  if (args[0] === "help" || args[0] === "--help") {
    printCliHelp(methods);
    return;
  }

  if (args[0] === "methods") {
    printMethodList(methods, args[1]);
    return;
  }

  if (args.length === 2 && args[1] === "--help") {
    printNamespaceHelp(args[0], methods);
    return;
  }

  let resolvedMethod: string | null = null;
  let paramArgs: string[] = [];

  if (args[0].includes(".") && methodMap.has(args[0])) {
    resolvedMethod = args[0];
    paramArgs = args.slice(1);
  } else if (args.length >= 2) {
    const candidate = `${args[0]}.${args[1]}`;
    if (methodMap.has(candidate)) {
      resolvedMethod = candidate;
      paramArgs = args.slice(2);
    }
  }

  if (!resolvedMethod) {
    await promptCompat(args);
    return;
  }

  const methodDef = methodMap.get(resolvedMethod)!;

  if (paramArgs.includes("--help")) {
    printMethodHelp(methodDef);
    return;
  }
  if (paramArgs.includes("--examples")) {
    printMethodExamples(methodDef);
    return;
  }

  const params = parseCliParams(paramArgs);
  validateParamsAgainstSchema(resolvedMethod, params, methodDef.inputSchema);
  await invokeMethod(resolvedMethod, params);
}

if (import.meta.main) {
  main().catch((err) => {
    console.error("Error:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
