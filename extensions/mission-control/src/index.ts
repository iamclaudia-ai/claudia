/**
 * Mission Control Extension — Server-Side
 *
 * Provides health dashboards and log viewer for monitoring Claudia.
 * Discovery-based: other extensions expose health-check methods,
 * Mission Control renders them generically.
 */

import { z } from "zod";
import { readdirSync, statSync, readFileSync } from "node:fs";
import { join, basename } from "node:path";
import { homedir } from "node:os";
import type { ClaudiaExtension, ExtensionContext, HealthCheckResponse } from "@claudia/shared";

const LOGS_DIR = join(homedir(), ".claudia", "logs");

export function createMissionControlExtension(): ClaudiaExtension {
  let ctx: ExtensionContext | null = null;

  return {
    id: "mission-control",
    name: "Mission Control",
    methods: [
      {
        name: "mission-control.health-check",
        description: "Return standardized health-check payload for Mission Control extension",
        inputSchema: z.object({}),
      },
      {
        name: "mission-control.log-list",
        description: "List available log files in ~/.claudia/logs/",
        inputSchema: z.object({}),
      },
      {
        name: "mission-control.log-tail",
        description: "Read the last N lines of a log file",
        inputSchema: z.object({
          file: z.string().min(1),
          lines: z.number().int().min(1).max(1000).default(100),
          offset: z.number().int().min(0).default(0),
        }),
      },
    ],
    events: [],

    async start(context: ExtensionContext) {
      ctx = context;
      ctx.log.info("Mission Control extension started");
    },

    async stop() {
      ctx = null;
    },

    async handleMethod(method: string, params: Record<string, unknown>) {
      switch (method) {
        case "mission-control.health-check": {
          const response: HealthCheckResponse = {
            ok: true,
            status: "healthy",
            label: "Mission Control",
            metrics: [
              { label: "Server Extension", value: "loaded" },
              { label: "UI Route", value: "/mission-control" },
            ],
          };
          return response;
        }

        case "mission-control.log-list": {
          try {
            const files = readdirSync(LOGS_DIR)
              .filter((f) => f.endsWith(".log"))
              .map((f) => {
                const fullPath = join(LOGS_DIR, f);
                const stat = statSync(fullPath);
                return {
                  name: f,
                  size: stat.size,
                  modified: stat.mtime.toISOString(),
                };
              })
              .sort((a, b) => b.modified.localeCompare(a.modified));
            return { files };
          } catch {
            return { files: [] };
          }
        }

        case "mission-control.log-tail": {
          const fileName = params.file as string;
          const maxLines = (params.lines as number) || 100;
          const byteOffset = (params.offset as number) || 0;

          // Sanitize filename — only allow log files from the logs dir
          const sanitized = basename(fileName);
          if (!sanitized.endsWith(".log")) {
            throw new Error("Invalid log file name");
          }
          const filePath = join(LOGS_DIR, sanitized);

          try {
            const stat = statSync(filePath);
            const fileSize = stat.size;

            if (byteOffset >= fileSize) {
              // No new data since last read
              return { lines: [], offset: fileSize, fileSize };
            }

            // Read from offset to end of file
            const content = readFileSync(filePath, "utf-8");
            const newContent = byteOffset > 0 ? content.slice(byteOffset) : content;
            const allLines = newContent.split("\n").filter((l) => l.length > 0);

            // Return only the last N lines if reading from beginning
            const resultLines = byteOffset > 0 ? allLines : allLines.slice(-maxLines);

            return {
              lines: resultLines,
              offset: fileSize,
              fileSize,
            };
          } catch {
            throw new Error(`Log file not found: ${sanitized}`);
          }
        }

        default:
          throw new Error(`Unknown method: ${method}`);
      }
    },

    health() {
      return { ok: true };
    },
  };
}

export default createMissionControlExtension;
