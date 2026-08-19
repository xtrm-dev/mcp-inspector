import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, applyMigrations } from "./database";
import {
  createWorkspaceRepository,
  createWorkspaceNodeRepository,
} from "./repositories";
import { openStorage } from "./index";

function newDb() {
  const db = openDatabase({ path: ":memory:" });
  applyMigrations(db);
  return db;
}

describe("workspace repository", () => {
  it("creates, updates, lists, deletes workspaces", () => {
    const db = newDb();
    const repo = createWorkspaceRepository(db);
    const w = repo.create({ name: "First workspace" });
    expect(w.id).toBeTruthy();
    expect(w.name).toBe("First workspace");
    expect(w.layoutJson).toBe("{}");

    const patched = repo.update(w.id, {
      name: "Renamed",
      layoutJson: JSON.stringify({ view: "grid" }),
    });
    expect(patched.name).toBe("Renamed");
    expect(patched.layoutJson).toBe('{"view":"grid"}');

    const list = repo.list();
    expect(list).toHaveLength(1);
    repo.delete(w.id);
    expect(repo.list()).toHaveLength(0);
    db.close();
  });

  it("orders list by updated_at DESC", () => {
    const db = newDb();
    const repo = createWorkspaceRepository(db);
    const a = repo.create({ name: "A" });
    // The next create will be strictly later in ISO time only if the clock
    // advances one millisecond. Force it by touching A after B is created.
    const b = repo.create({ name: "B" });
    repo.update(a.id, { name: "A (touched)" });
    const rows = repo.list();
    expect(rows[0]?.id).toBe(a.id);
    expect(rows[1]?.id).toBe(b.id);
    db.close();
  });
});

describe("workspace_node repository", () => {
  it("creates nodes, lists in position order, updates, deletes", () => {
    const db = newDb();
    const workspaces = createWorkspaceRepository(db);
    const nodes = createWorkspaceNodeRepository(db);
    const w = workspaces.create({ name: "wsp" });

    const n1 = nodes.create({
      workspaceId: w.id,
      serverId: "demo",
      capabilityId: "demo::tool::x",
      position: 1,
    });
    const n2 = nodes.create({ workspaceId: w.id, position: 0 });
    const n3 = nodes.create({ workspaceId: w.id, position: 2, presentation: "focus" });

    const list = nodes.listForWorkspace(w.id);
    expect(list.map((n) => n.id)).toEqual([n2.id, n1.id, n3.id]);

    const patched = nodes.update(n1.id, {
      argumentsJson: JSON.stringify({ a: 1 }),
      presentation: "expanded",
    });
    expect(patched.argumentsJson).toBe('{"a":1}');
    expect(patched.presentation).toBe("expanded");

    nodes.delete(n2.id);
    expect(nodes.listForWorkspace(w.id).map((n) => n.id)).toEqual([n1.id, n3.id]);
    db.close();
  });

  it("reorder assigns positions in a single transaction", () => {
    const db = newDb();
    const workspaces = createWorkspaceRepository(db);
    const nodes = createWorkspaceNodeRepository(db);
    const w = workspaces.create({ name: "wsp" });
    const a = nodes.create({ workspaceId: w.id });
    const b = nodes.create({ workspaceId: w.id });
    const c = nodes.create({ workspaceId: w.id });

    const reordered = nodes.reorder(w.id, [c.id, a.id, b.id]);
    expect(reordered.map((n) => n.id)).toEqual([c.id, a.id, b.id]);
    // Positions are 0,1,2 respectively.
    expect(reordered.map((n) => n.position)).toEqual([0, 1, 2]);
    db.close();
  });

  it("cascades: deleting a workspace deletes its nodes", () => {
    const db = newDb();
    const workspaces = createWorkspaceRepository(db);
    const nodes = createWorkspaceNodeRepository(db);
    const w = workspaces.create({ name: "wsp" });
    const n = nodes.create({ workspaceId: w.id });
    workspaces.delete(w.id);
    expect(nodes.get(n.id)).toBeNull();
    db.close();
  });

  it("workspaces + nodes survive across restarts", () => {
    const dir = mkdtempSync(join(tmpdir(), "mix-ws-"));
    try {
      const s1 = openStorage({ dataDir: dir });
      const w = s1.workspaces.create({ name: "persistent" });
      s1.workspaceNodes.create({ workspaceId: w.id, capabilityId: "s::tool::x" });
      s1.workspaceNodes.create({ workspaceId: w.id, capabilityId: "s::tool::y" });
      s1.close();

      const s2 = openStorage({ dataDir: dir });
      const list = s2.workspaces.list();
      expect(list).toHaveLength(1);
      expect(list[0]?.name).toBe("persistent");
      const restoredNodes = s2.workspaceNodes.listForWorkspace(list[0]!.id);
      expect(restoredNodes).toHaveLength(2);
      s2.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
