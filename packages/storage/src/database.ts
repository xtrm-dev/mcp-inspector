import Database from "better-sqlite3";
import type { Database as SqliteDb } from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { MIGRATIONS, checksum, type AppliedMigration, type Migration } from "./migrations";

export interface OpenDbOptions {
  path: string;
  readonly?: boolean;
}

export interface MigrationReport {
  appliedNow: number[];
  alreadyApplied: number[];
}

export function openDatabase(options: OpenDbOptions): SqliteDb {
  if (options.path !== ":memory:") {
    mkdirSync(dirname(options.path), { recursive: true });
  }
  const db = new Database(options.path, { readonly: options.readonly ?? false });
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  return db;
}

export function applyMigrations(db: SqliteDb, migrations: readonly Migration[] = MIGRATIONS): MigrationReport {
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL,
      checksum TEXT NOT NULL
    );
  `);

  const existing = new Map<number, AppliedMigration>();
  for (const row of db.prepare("SELECT version, name, applied_at, checksum FROM _migrations").all() as AppliedMigration[]) {
    existing.set(row.version, row);
  }

  const alreadyApplied: number[] = [];
  const appliedNow: number[] = [];

  for (const m of [...migrations].sort((a, b) => a.version - b.version)) {
    const sum = checksum(m.sql);
    const prior = existing.get(m.version);
    if (prior) {
      if (prior.checksum !== sum) {
        throw new Error(
          `migration ${m.version} (${m.name}) checksum mismatch: db=${prior.checksum} src=${sum}`,
        );
      }
      alreadyApplied.push(m.version);
      continue;
    }
    const record = db.prepare(
      "INSERT INTO _migrations (version, name, applied_at, checksum) VALUES (?, ?, ?, ?)",
    );
    const tx = db.transaction((sql: string) => {
      db.exec(sql);
      record.run(m.version, m.name, new Date().toISOString(), sum);
    });
    tx(m.sql);
    appliedNow.push(m.version);
  }

  return { appliedNow, alreadyApplied };
}

export function closeDatabase(db: SqliteDb): void {
  db.close();
}

export type { SqliteDb };
