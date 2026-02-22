/**
 * Gateway built-in method definitions.
 *
 * Extracted from index.ts so that tooling (e.g. generate-api-reference)
 * can import them without triggering server startup side effects.
 */

import { z, type ZodTypeAny } from "zod";

export type GatewayMethodDefinition = {
  method: string;
  description: string;
  inputSchema: ZodTypeAny;
};

export const BUILTIN_METHODS: GatewayMethodDefinition[] = [
  {
    method: "gateway.list_methods",
    description: "List all gateway and extension methods with schemas",
    inputSchema: z.object({}),
  },
  {
    method: "gateway.list_extensions",
    description: "List loaded extensions and their methods",
    inputSchema: z.object({}),
  },
  {
    method: "gateway.subscribe",
    description: "Subscribe to events",
    inputSchema: z.object({
      events: z.array(z.string()).optional(),
      exclusive: z.boolean().optional().describe("Last subscriber wins — only one client receives"),
    }),
  },
  {
    method: "gateway.unsubscribe",
    description: "Unsubscribe from events",
    inputSchema: z.object({
      events: z.array(z.string()).optional(),
    }),
  },
  {
    method: "gateway.restart_extension",
    description: "Restart an extension host process (manual HMR for non-hot extensions)",
    inputSchema: z.object({
      extension: z.string().describe("Extension ID to restart (e.g. session, codex, voice)"),
    }),
  },
];

export const BUILTIN_METHODS_BY_NAME = new Map(BUILTIN_METHODS.map((m) => [m.method, m] as const));
