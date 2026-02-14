#!/usr/bin/env bun

import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { createVoiceExtension } from "../extensions/voice/src/index";
import { createIMessageExtension } from "../extensions/imessage/src/index";
import { createChatExtension } from "../extensions/chat/src/index";
import { createMissionControlExtension } from "../extensions/mission-control/src/index";

type MethodDef = {
  method: string;
  description: string;
  inputSchema: z.ZodTypeAny;
  source: "gateway" | "runtime" | "extension";
};

const gatewayMethods: MethodDef[] = [
  {
    method: "workspace.list",
    description: "List all workspaces",
    inputSchema: z.object({}),
    source: "gateway",
  },
  {
    method: "workspace.get",
    description: "Get one workspace by id",
    inputSchema: z.object({ workspaceId: z.string().min(1) }),
    source: "gateway",
  },
  {
    method: "workspace.get-or-create",
    description: "Get or create a workspace for an explicit cwd",
    inputSchema: z.object({ cwd: z.string().min(1), name: z.string().optional() }),
    source: "gateway",
  },
  {
    method: "workspace.list-sessions",
    description: "List sessions for a specific workspace",
    inputSchema: z.object({ workspaceId: z.string().min(1) }),
    source: "gateway",
  },
  {
    method: "workspace.create-session",
    description: "Create a new session for a workspace with explicit runtime config",
    inputSchema: z.object({
      workspaceId: z.string().min(1),
      model: z.string().min(1),
      thinking: z.boolean(),
      effort: z.string().min(1),
      title: z.string().optional(),
      systemPrompt: z.string().optional(),
    }),
    source: "gateway",
  },
  {
    method: "session.info",
    description: "Get current runtime/session info",
    inputSchema: z.object({}),
    source: "gateway",
  },
  {
    method: "session.prompt",
    description: "Send prompt to explicit session with explicit runtime config",
    inputSchema: z.object({
      sessionId: z.string().min(1),
      content: z.union([z.string(), z.array(z.unknown())]),
      model: z.string().min(1),
      thinking: z.boolean(),
      effort: z.string().min(1),
      speakResponse: z.boolean().optional(),
      source: z.string().optional(),
    }),
    source: "gateway",
  },
  {
    method: "session.interrupt",
    description: "Interrupt a specific session",
    inputSchema: z.object({ sessionId: z.string().min(1) }),
    source: "gateway",
  },
  {
    method: "session.permission-mode",
    description: "Set permission mode for a session",
    inputSchema: z.object({
      sessionId: z.string().min(1),
      mode: z.enum(["bypassPermissions", "acceptEdits", "plan", "default", "delegate", "dontAsk"]),
    }),
    source: "gateway",
  },
  {
    method: "session.tool-result",
    description: "Send tool_result for interactive tools",
    inputSchema: z.object({
      sessionId: z.string().min(1),
      toolUseId: z.string().min(1),
      content: z.string(),
      isError: z.boolean().optional(),
    }),
    source: "gateway",
  },
  {
    method: "session.get",
    description: "Get one session record by id",
    inputSchema: z.object({ sessionId: z.string().min(1) }),
    source: "gateway",
  },
  {
    method: "session.history",
    description: "Get history for a specific session",
    inputSchema: z.object({
      sessionId: z.string().min(1),
      limit: z.number().int().positive().optional(),
      offset: z.number().int().min(0).optional(),
    }),
    source: "gateway",
  },
  {
    method: "session.switch",
    description: "Switch runtime to an explicit session id",
    inputSchema: z.object({ sessionId: z.string().min(1) }),
    source: "gateway",
  },
  {
    method: "session.reset",
    description: "Create a replacement session for a workspace",
    inputSchema: z.object({
      workspaceId: z.string().min(1),
      model: z.string().min(1),
      thinking: z.boolean(),
      effort: z.string().min(1),
      systemPrompt: z.string().optional(),
    }),
    source: "gateway",
  },
  {
    method: "extension.list",
    description: "List loaded extensions and their methods",
    inputSchema: z.object({}),
    source: "gateway",
  },
  {
    method: "method.list",
    description: "List gateway and extension methods with schemas",
    inputSchema: z.object({}),
    source: "gateway",
  },
  {
    method: "subscribe",
    description: "Subscribe to events",
    inputSchema: z.object({ events: z.array(z.string()).optional() }),
    source: "gateway",
  },
  {
    method: "unsubscribe",
    description: "Unsubscribe from events",
    inputSchema: z.object({ events: z.array(z.string()).optional() }),
    source: "gateway",
  },
  {
    method: "runtime.health-check",
    description: "Runtime health status",
    inputSchema: z.object({}),
    source: "gateway",
  },
  {
    method: "runtime.kill-session",
    description: "Kill a runtime Claude process",
    inputSchema: z.object({ sessionId: z.string().min(1) }),
    source: "gateway",
  },
];

const runtimeMethods: MethodDef[] = [
  {
    method: "session.create",
    description: "Create runtime session",
    inputSchema: z.object({
      cwd: z.string().min(1),
      model: z.string().optional(),
      systemPrompt: z.string().optional(),
      thinking: z.boolean().optional(),
      effort: z.enum(["low", "medium", "high", "max"]).optional(),
    }),
    source: "runtime",
  },
  {
    method: "session.resume",
    description: "Resume runtime session",
    inputSchema: z.object({
      sessionId: z.string().min(1),
      cwd: z.string().min(1),
      model: z.string().optional(),
      thinking: z.boolean().optional(),
      effort: z.enum(["low", "medium", "high", "max"]).optional(),
    }),
    source: "runtime",
  },
  {
    method: "session.prompt",
    description: "Prompt runtime session",
    inputSchema: z.object({
      sessionId: z.string().min(1),
      content: z.union([z.string(), z.array(z.unknown())]),
      cwd: z.string().optional(),
    }),
    source: "runtime",
  },
  {
    method: "session.interrupt",
    description: "Interrupt runtime session",
    inputSchema: z.object({ sessionId: z.string().min(1) }),
    source: "runtime",
  },
  {
    method: "session.permission-mode",
    description: "Set runtime permission mode",
    inputSchema: z.object({ sessionId: z.string().min(1), mode: z.string().min(1) }),
    source: "runtime",
  },
  {
    method: "session.tool-result",
    description: "Send runtime tool_result",
    inputSchema: z.object({
      sessionId: z.string().min(1),
      toolUseId: z.string().min(1),
      content: z.string(),
      isError: z.boolean().optional(),
    }),
    source: "runtime",
  },
  {
    method: "session.close",
    description: "Close runtime session",
    inputSchema: z.object({ sessionId: z.string().min(1) }),
    source: "runtime",
  },
  {
    method: "session.list",
    description: "List runtime sessions",
    inputSchema: z.object({}),
    source: "runtime",
  },
  {
    method: "subscribe",
    description: "Subscribe to runtime events",
    inputSchema: z.object({ events: z.array(z.string()).optional() }),
    source: "runtime",
  },
  {
    method: "unsubscribe",
    description: "Unsubscribe from runtime events",
    inputSchema: z.object({ events: z.array(z.string()).optional() }),
    source: "runtime",
  },
];

function requiredOptional(schema: z.ZodTypeAny): { required: string[]; optional: string[] } {
  const json = zodToJsonSchema(schema, "schema") as {
    definitions?: { schema?: { properties?: Record<string, unknown>; required?: string[] } };
  };
  const root = json.definitions?.schema;
  const props = Object.keys(root?.properties || {});
  const req = new Set(root?.required || []);
  return {
    required: props.filter((p) => req.has(p)),
    optional: props.filter((p) => !req.has(p)),
  };
}

function methodRows(methods: MethodDef[]): string {
  const sorted = [...methods].sort((a, b) => a.method.localeCompare(b.method));
  const rows = sorted.map((m) => {
    const io = requiredOptional(m.inputSchema);
    const required = io.required.length ? io.required.map((p) => `\`${p}\``).join(", ") : "none";
    const optional = io.optional.length ? io.optional.map((p) => `\`${p}\``).join(", ") : "none";
    return `| \`${m.method}\` | ${required} | ${optional} | ${m.description} |`;
  });
  return [
    "| Method | Required Params | Optional Params | Description |",
    "| --- | --- | --- | --- |",
    ...rows,
  ].join("\n");
}

function extensionMethods(): MethodDef[] {
  const exts = [
    createVoiceExtension(),
    createIMessageExtension(),
    createChatExtension(),
    createMissionControlExtension(),
  ];

  const out: MethodDef[] = [];
  for (const ext of exts) {
    for (const method of ext.methods) {
      out.push({
        method: method.name,
        description: method.description,
        inputSchema: method.inputSchema,
        source: "extension",
      });
    }
  }
  return out;
}

const now = new Date().toISOString().slice(0, 10);
const content = `# Claudia API Reference\n\nLast updated: ${now}\n\nThis file is generated by \`scripts/generate-api-reference.ts\`.\n\n## Gateway API (port 30086, \`/ws\`)\n\n${methodRows(gatewayMethods)}\n\n## Runtime API (port 30087, \`/ws\`)\n\n${methodRows(runtimeMethods)}\n\n## Extension API (via gateway)\n\n${methodRows(extensionMethods())}\n\n## Notes\n\n- Multi-word methods use kebab-case (for example \`workspace.get-or-create\`, \`session.tool-result\`).\n- Source of truth is the code and schemas; regenerate after API changes.\n`;

writeFileSync(join(process.cwd(), "docs", "API-REFERENCE.md"), content);
console.log("[docs] Wrote docs/API-REFERENCE.md");
