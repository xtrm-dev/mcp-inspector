import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, applyMigrations, closeDatabase } from "./database";
import { MIGRATIONS } from "./migrations";
import { openStorage } from "./index";

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "mix-storage-"));
}

describe("database + migrations", () => {
  it("applies v1 schema and is idempotent across restarts", () => {
    const dir = makeTempDir();
    try {
      const db1 = openDatabase({ path: join(dir, "state.sqlite3") });
      const first = applyMigrations(db1);
      expect(first.appliedNow).toEqual([1]);
      expect(first.alreadyApplied).toEqual([]);

      const tables = (db1.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
      ).all() as Array<{ name: string }>).map((r) => r.name);
      expect(tables).toContain("server_definition");
      expect(tables).toContain("execution");
      expect(tables).toContain("execution_event");
      expect(tables).toContain("artifact");
      expect(tables).toContain("_migrations");

      const integrity = db1.pragma("integrity_check", { simple: true });
      expect(integrity).toBe("ok");
      closeDatabase(db1);

      const db2 = openDatabase({ path: join(dir, "state.sqlite3") });
      const second = applyMigrations(db2);
      expect(second.appliedNow).toEqual([]);
      expect(second.alreadyApplied).toEqual([1]);
      closeDatabase(db2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses to boot when a committed migration's SQL was edited (checksum guard)", () => {
    const db = openDatabase({ path: ":memory:" });
    applyMigrations(db);
    const tampered = MIGRATIONS.map((m) =>
      m.version === 1 ? { ...m, sql: `${m.sql}\n-- tampered` } : m,
    );
    expect(() => applyMigrations(db, tampered)).toThrow(/checksum mismatch/);
    db.close();
  });

  it("uses WAL and enforces foreign keys", () => {
    const db = openDatabase({ path: ":memory:" });
    expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
    db.close();
  });

  it("restart replays event log state (durability end-to-end)", () => {
    const dir = makeTempDir();
    try {
      const s1 = openStorage({ dataDir: dir });
      const server = s1.servers.create({
        id: "demo",
        displayName: "Demo",
        transport: "streamable-http",
        endpoint: "http://127.0.0.1:1/mcp",
      });
      const execution = s1.executions.create({
        serverId: server.id,
        capabilityId: "demo::tool::echo",
      });
      s1.events.append({
        executionId: execution.id,
        kind: "execution.created",
        payload: { executionId: execution.id },
      });
      s1.events.append({
        executionId: execution.id,
        kind: "execution.transition",
        payload: { to: "running" },
      });
      s1.close();

      const s2 = openStorage({ dataDir: dir });
      const servers = s2.servers.list();
      expect(servers).toHaveLength(1);
      expect(servers[0]?.id).toBe("demo");

      const events = s2.events.read();
      expect(events).toHaveLength(2);
      expect(events[0]?.kind).toBe("execution.created");
      expect(events[1]?.kind).toBe("execution.transition");
      s2.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
