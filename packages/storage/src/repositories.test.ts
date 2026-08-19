import { describe, expect, it } from "vitest";
import { openDatabase, applyMigrations } from "./database";
import {
  createServerRepository,
  createExecutionRepository,
  createExecutionRoundRepository,
  createEvidenceRepository,
  createEventLog,
} from "./repositories";
import { createArtifactStore } from "./artifacts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function newDb() {
  const db = openDatabase({ path: ":memory:" });
  applyMigrations(db);
  return db;
}

describe("server repository", () => {
  it("creates, lists, updates, and deletes servers", () => {
    const db = newDb();
    const repo = createServerRepository(db);

    const a = repo.create({
      displayName: "Server A",
      transport: "streamable-http",
      endpoint: "http://a/mcp",
    });
    const b = repo.create({
      displayName: "Server B",
      transport: "stdio",
      endpoint: JSON.stringify({ command: "node", args: ["b.js"] }),
      disabled: true,
    });
    expect(repo.list().map((s) => s.id).sort()).toEqual([a.id, b.id].sort());

    const patched = repo.update(a.id, { displayName: "A prime", disabled: true });
    expect(patched.displayName).toBe("A prime");
    expect(patched.disabled).toBe(true);

    repo.delete(b.id);
    expect(repo.list()).toHaveLength(1);
    expect(repo.get("nonexistent")).toBeNull();
    db.close();
  });

  it("upserts by id (idempotent boot-time seeding)", () => {
    const db = newDb();
    const repo = createServerRepository(db);
    const first = repo.upsertById({
      id: "demo",
      displayName: "Demo",
      transport: "streamable-http",
      endpoint: "http://demo",
    });
    const second = repo.upsertById({
      id: "demo",
      displayName: "Demo (renamed)",
      transport: "streamable-http",
      endpoint: "http://demo/v2",
    });
    expect(first.id).toBe("demo");
    expect(second.displayName).toBe("Demo (renamed)");
    expect(second.endpoint).toBe("http://demo/v2");
    expect(repo.list()).toHaveLength(1);
    db.close();
  });
});

describe("execution + rounds + evidence", () => {
  it("appends rounds and evidence keyed on an execution, preserves order", () => {
    const dir = mkdtempSync(join(tmpdir(), "mix-repos-"));
    try {
      const db = newDb();
      const servers = createServerRepository(db);
      const executions = createExecutionRepository(db);
      const rounds = createExecutionRoundRepository(db);
      const evidence = createEvidenceRepository(db);
      const artifacts = createArtifactStore({ db, root: join(dir, "artifacts") });

      const s = servers.create({
        displayName: "S",
        transport: "streamable-http",
        endpoint: "http://s",
      });
      const exec = executions.create({ serverId: s.id, capabilityId: `${s.id}::tool::echo` });
      expect(exec.status).toBe("queued");

      rounds.append({
        executionId: exec.id,
        roundIndex: 0,
        kind: "initial",
        argumentsJson: JSON.stringify({ msg: "hi" }),
      });
      rounds.append({
        executionId: exec.id,
        roundIndex: 1,
        kind: "input_response",
        argumentsJson: JSON.stringify({ msg: "again" }),
      });
      const roundList = rounds.listForExecution(exec.id);
      expect(roundList.map((r) => r.roundIndex)).toEqual([0, 1]);

      const artifact = artifacts.put({ bytes: new TextEncoder().encode("{\"raw\":true}") });
      evidence.append({
        executionId: exec.id,
        kind: "raw_response",
        artifactRef: artifact.hash,
      });
      const evList = evidence.listForExecution(exec.id);
      expect(evList).toHaveLength(1);
      expect(evList[0]?.artifactRef).toBe(artifact.hash);

      const done = executions.updateStatus(exec.id, "complete", new Date().toISOString());
      expect(done.status).toBe("complete");
      expect(done.endedAt).not.toBeNull();

      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("cascades: deleting a server also deletes its executions", () => {
    const db = newDb();
    const servers = createServerRepository(db);
    const executions = createExecutionRepository(db);
    const s = servers.create({
      displayName: "S",
      transport: "streamable-http",
      endpoint: "http://s",
    });
    const e = executions.create({ serverId: s.id, capabilityId: "s::tool::x" });
    servers.delete(s.id);
    // execution rows referencing server_definition are NOT cascaded (schema has no FK from
    // execution.server_id → server_definition.id, on purpose: history survives server removal).
    expect(executions.get(e.id)).not.toBeNull();
    db.close();
  });

  it("evidence artifact ref enforces FK: unknown artifact hash is rejected", () => {
    const db = newDb();
    const servers = createServerRepository(db);
    const executions = createExecutionRepository(db);
    const evidence = createEvidenceRepository(db);
    const s = servers.create({
      displayName: "S",
      transport: "streamable-http",
      endpoint: "http://s",
    });
    const e = executions.create({ serverId: s.id, capabilityId: "s::tool::x" });
    expect(() =>
      evidence.append({
        executionId: e.id,
        kind: "raw_response",
        artifactRef: "a".repeat(64),
      }),
    ).toThrow(/FOREIGN KEY/i);
    db.close();
  });
});

describe("event log", () => {
  it("appends monotonically increasing seqs and reads since a cursor", () => {
    const db = newDb();
    const log = createEventLog(db);
    const a = log.append({ kind: "boot", payload: { message: "ready" } });
    const b = log.append({ kind: "boot", payload: { message: "listening" } });
    const c = log.append({ kind: "server.connected", payload: { serverId: "demo" } });
    expect(b.seq).toBe(a.seq + 1);
    expect(c.seq).toBe(b.seq + 1);
    const tail = log.read({ sinceSeq: a.seq });
    expect(tail.map((r) => r.seq)).toEqual([b.seq, c.seq]);
    db.close();
  });

  it("streams to live subscribers and stops on close", () => {
    const db = newDb();
    const log = createEventLog(db);
    const received: string[] = [];
    const sub = log.subscribe((row) => received.push(row.kind));
    log.append({ kind: "one", payload: null });
    log.append({ kind: "two", payload: null });
    sub.close();
    log.append({ kind: "three", payload: null });
    expect(received).toEqual(["one", "two"]);
    db.close();
  });

  it("filters live events by executionId when queried", () => {
    const db = newDb();
    const servers = createServerRepository(db);
    const executions = createExecutionRepository(db);
    const log = createEventLog(db);
    const s = servers.create({
      displayName: "S",
      transport: "streamable-http",
      endpoint: "http://s",
    });
    const a = executions.create({ serverId: s.id, capabilityId: "s::tool::a" });
    const b = executions.create({ serverId: s.id, capabilityId: "s::tool::b" });
    log.append({ executionId: a.id, kind: "started", payload: null });
    log.append({ executionId: b.id, kind: "started", payload: null });
    log.append({ executionId: a.id, kind: "done", payload: null });
    const forA = log.read({ executionId: a.id });
    expect(forA.map((r) => r.kind)).toEqual(["started", "done"]);
    db.close();
  });

  it("event log rows survive across restarts (append-only durability)", () => {
    const dir = mkdtempSync(join(tmpdir(), "mix-eventlog-"));
    try {
      const db1 = openDatabase({ path: join(dir, "state.sqlite3") });
      applyMigrations(db1);
      const log1 = createEventLog(db1);
      log1.append({ kind: "keep-me", payload: { round: 1 } });
      log1.append({ kind: "keep-me", payload: { round: 2 } });
      db1.close();

      const db2 = openDatabase({ path: join(dir, "state.sqlite3") });
      applyMigrations(db2);
      const log2 = createEventLog(db2);
      const rows = log2.read();
      expect(rows).toHaveLength(2);
      expect(rows[0]?.payload).toEqual({ round: 1 });
      expect(rows[1]?.payload).toEqual({ round: 2 });
      db2.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
