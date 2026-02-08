/**
 * Database migration runner
 *
 * Reads numbered SQL files from the migrations/ directory and applies them
 * in order. Each file must have `-- Up` and `-- Down` sections.
 *
 * Ported from claudia-code/src/utils/migrate.ts
 */

import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Database } from "bun:sqlite";

interface Migration {
  id: number;
  name: string;
  filename: string;
  data: string;
  up: string;
  down: string;
}

type ParsedMigration = Partial<Migration> & Pick<Migration, "id" | "name" | "filename">;

interface MigrateOptions {
  force?: "last" | false;
  table?: string;
  migrationsPath?: string;
}

/**
 * Apply all pending migrations
 */
export function migrate(db: Database, options: MigrateOptions = {}): Database {
  const {
    force = false,
    table = "_migrations",
    migrationsPath,
  } = options;

  // Resolve migrations directory relative to gateway package root
  const location = migrationsPath || resolve(import.meta.dir, "../../migrations");

  // Get the list of migration files
  let parsedMigrations: ParsedMigration[];
  try {
    parsedMigrations = readdirSync(location)
      .map((x) => x.match(/^(\d+)[.-](.*?)\.sql$/))
      .filter((x): x is RegExpMatchArray => x !== null)
      .map((x) => ({
        id: Number(x[1]),
        name: x[2] ?? "",
        filename: x[0],
      }))
      .sort((a, b) => Math.sign(a.id - b.id));
  } catch {
    console.log(`[DB] No migrations directory found at ${location}`);
    return db;
  }

  if (!parsedMigrations.length) {
    console.log("[DB] No migration files found");
    return db;
  }

  // Read migration file contents
  for (const migration of parsedMigrations) {
    const filename = join(location, migration.filename);
    migration.data = readFileSync(filename, "utf-8");
  }

  // Parse Up and Down sections
  const migrationFiles: Migration[] = [];
  for (const migration of parsedMigrations) {
    if (!migration.data) {
      throw new Error(`Migration ${migration.filename} has no data`);
    }

    const parts = migration.data.split(/^\s*--\s+?down\b/im);
    const up = parts[0] ?? "";
    const down = parts[1];

    if (!down) {
      throw new Error(
        `The ${migration.filename} file does not contain '-- Down' separator.`,
      );
    }

    migrationFiles.push({
      id: migration.id,
      name: migration.name,
      filename: migration.filename,
      data: migration.data,
      up: up.replace(/^--.*$/gm, "").trim(),
      down: down.trim(),
    });
  }

  // Create migrations table if it doesn't exist
  db.exec(`CREATE TABLE IF NOT EXISTS "${table}" (
    id   INTEGER PRIMARY KEY,
    name TEXT    NOT NULL,
    up   TEXT    NOT NULL,
    down TEXT    NOT NULL,
    applied_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  // Get already applied migrations
  let dbMigrations = db
    .query(`SELECT id, name, up, down FROM "${table}" ORDER BY id ASC`)
    .all() as Migration[];

  // Undo migrations that exist only in the database but not in files
  const lastMigration = migrationFiles[migrationFiles.length - 1];
  const reversedDbMigrations = [...dbMigrations].sort((a, b) => Math.sign(b.id - a.id));

  for (const migration of reversedDbMigrations) {
    const isForceLastMigration =
      force === "last" && lastMigration && migration.id === lastMigration.id;
    const migrationNotInFiles = !migrationFiles.some((x) => x.id === migration.id);

    if (migrationNotInFiles || isForceLastMigration) {
      db.run("BEGIN");
      try {
        const downSql = isForceLastMigration && lastMigration
          ? lastMigration.down
          : migration.down;
        db.run(downSql);
        db.query(`DELETE FROM "${table}" WHERE id = ?`).run(migration.id);
        db.run("COMMIT");
        console.log(`[DB] ⬇️  Rolled back migration ${migration.id}: ${migration.name}`);
        dbMigrations = dbMigrations.filter((x) => x.id !== migration.id);
      } catch (err) {
        db.run("ROLLBACK");
        throw err;
      }
    } else {
      break;
    }
  }

  // Apply pending migrations
  const lastMigrationId = dbMigrations.length
    ? (dbMigrations[dbMigrations.length - 1]?.id ?? 0)
    : 0;

  for (const migration of migrationFiles) {
    if (migration.id > lastMigrationId) {
      db.run("BEGIN");
      try {
        db.run(migration.up);
        db.query(
          `INSERT INTO "${table}" (id, name, up, down, applied_at) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)`,
        ).run(migration.id, migration.name, migration.up, migration.down);
        db.run("COMMIT");
        console.log(`[DB] ⬆️  Applied migration ${migration.id}: ${migration.name}`);
      } catch (err) {
        db.run("ROLLBACK");
        throw err;
      }
    }
  }

  return db;
}

/**
 * Rollback migrations
 */
export function rollback(
  db: Database,
  options: { to?: number; table?: string } = {},
): Database {
  const { to, table = "_migrations" } = options;

  const dbMigrations = db
    .query(`SELECT id, name, down FROM "${table}" ORDER BY id DESC`)
    .all() as Migration[];

  if (!dbMigrations.length) {
    console.log("[DB] No migrations to rollback");
    return db;
  }

  let migrationsToRollback: Migration[];

  if (to !== undefined) {
    migrationsToRollback = dbMigrations.filter((m) => m.id > to);
    if (!migrationsToRollback.length) {
      console.log(`[DB] Already at migration ${to} or earlier`);
      return db;
    }
  } else {
    const lastMigration = dbMigrations[0];
    if (!lastMigration) {
      console.log("[DB] No migrations to rollback");
      return db;
    }
    migrationsToRollback = [lastMigration];
  }

  for (const migration of migrationsToRollback) {
    db.run("BEGIN");
    try {
      db.run(migration.down);
      db.query(`DELETE FROM "${table}" WHERE id = ?`).run(migration.id);
      db.run("COMMIT");
      console.log(`[DB] ⬇️  Rolled back migration ${migration.id}: ${migration.name}`);
    } catch (err) {
      db.run("ROLLBACK");
      throw err;
    }
  }

  return db;
}
