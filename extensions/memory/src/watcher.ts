/**
 * Memory Extension — File Watcher
 *
 * Monitors a single base directory for JSONL file changes using chokidar.
 * On file add/change, incrementally ingests new content.
 *
 * Does NOT process existing files on startup — the extension start()
 * handles the initial scan before starting the watcher.
 */

import { watch, type FSWatcher } from "chokidar";
import { ingestFile } from "./ingest";

export interface WatcherConfig {
  /** Absolute path to the directory to watch */
  basePath: string;
  gapMinutes: number;
}

export class MemoryWatcher {
  private watcher: FSWatcher | null = null;
  private config: WatcherConfig;
  private log: (level: string, msg: string) => void;
  private ready = false;

  // Queue to serialize file processing
  private queue: string[] = [];
  private processing = false;

  constructor(config: WatcherConfig, log: (level: string, msg: string) => void) {
    this.config = config;
    this.log = log;
  }

  start(): void {
    if (this.watcher) return;

    this.log("INFO", `Starting file watcher on: ${this.config.basePath}`);

    this.watcher = watch(this.config.basePath, {
      persistent: true,
      ignoreInitial: true, // Don't process existing files — startup scan handles that
      awaitWriteFinish: {
        stabilityThreshold: 1000,
        pollInterval: 200,
      },
      // Only watch .jsonl files
      ignored: (path: string) => {
        // Allow directories (so we can recurse)
        if (!path.includes(".")) return false;
        return !path.endsWith(".jsonl");
      },
    });

    this.watcher.on("ready", () => {
      this.ready = true;
      this.log("INFO", "File watcher ready");
    });

    this.watcher.on("add", (path) => {
      if (!this.ready) return;
      this.log("INFO", `New file detected: ${path}`);
      this.enqueue(path);
    });

    this.watcher.on("change", (path) => {
      this.log("INFO", `File changed: ${path}`);
      this.enqueue(path);
    });

    this.watcher.on("error", (error) => {
      this.log("ERROR", `Watcher error: ${error instanceof Error ? error.message : String(error)}`);
    });
  }

  async stop(): Promise<void> {
    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
      this.ready = false;
    }
  }

  private enqueue(filePath: string): void {
    if (!this.queue.includes(filePath)) {
      this.queue.push(filePath);
    }
    this.processQueue();
  }

  private processQueue(): void {
    if (this.processing || this.queue.length === 0) return;

    this.processing = true;

    while (this.queue.length > 0) {
      const filePath = this.queue.shift();
      if (!filePath) continue;

      try {
        const result = ingestFile(filePath, this.config.basePath, this.config.gapMinutes);
        if (result.entriesInserted > 0) {
          this.log("INFO", `Ingested ${result.entriesInserted} entries from ${filePath}`);
        }
        if (result.errors.length > 0) {
          for (const err of result.errors) {
            this.log("ERROR", `Ingestion error: ${err}`);
          }
        }
      } catch (error) {
        this.log(
          "ERROR",
          `Failed to process ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    this.processing = false;
  }
}
