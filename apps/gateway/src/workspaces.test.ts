import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSdkAdapter } from "@mcp-inspector-x/protocol";
import { openStorage, type Storage } from "@mcp-inspector-x/storage";
import { startDemoMcp, type DemoMcp } from "./demo-mcp";
import { buildGatewayApp } from "./routes";
import { createServerManager, type ServerManager } from "./servers";
import { createSecretsRegistry, type SecretsRegistry } from "./secrets";

describe("gateway workspace routes", () => {
  let demo: DemoMcp;
  let adapter: ReturnType<typeof createSdkAdapter>;
  let app: ReturnType<typeof buildGatewayApp>;
  let storage: Storage;
  let serverManager: ServerManager;
  let secrets: SecretsRegistry;
  let dataDir: string;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "mix-workspaces-"));
    storage = openStorage({ dataDir });
    demo = await startDemoMcp();
    adapter = createSdkAdapter();
    secrets = createSecretsRegistry({ storage });
    serverManager = createServerManager({ storage, adapter, secrets });

    const demoDef = storage.servers.upsertById({
      id: "demo",
      displayName: "Demo",
      transport: "streamable-http",
      endpoint: demo.url,
      protocolPolicy: "modern",
    });
    await serverManager.connect(demoDef);
    app = buildGatewayApp({ adapter, storage, serverManager, secrets });
  }, 15_000);

  afterAll(async () => {
    for (const b of serverManager?.bindings() ?? []) {
      await adapter?.disconnect(b.descriptor.id).catch(() => {});
    }
    await demo?.close();
    storage?.close();
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
  });

  it("GET /api/v1/workspaces returns [] when none exist", async () => {
    const r = await app.request("/api/v1/workspaces");
    expect(r.status).toBe(200);
    const body = (await r.json()) as { workspaces: unknown[] };
    expect(body.workspaces).toEqual([]);
  });

  it("full CRUD lifecycle: create, get, patch, delete", async () => {
    const created = await app.request("/api/v1/workspaces", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Workspace A", layoutJson: JSON.stringify({ view: "grid" }) }),
    });
    expect(created.status).toBe(201);
    const { workspace } = (await created.json()) as { workspace: { id: string; name: string } };
    expect(workspace.name).toBe("Workspace A");

    const fetched = await app.request(`/api/v1/workspaces/${workspace.id}`);
    const body = (await fetched.json()) as { workspace: { name: string }; nodes: unknown[] };
    expect(body.workspace.name).toBe("Workspace A");
    expect(body.nodes).toEqual([]);

    const patched = await app.request(`/api/v1/workspaces/${workspace.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Renamed" }),
    });
    const { workspace: p } = (await patched.json()) as { workspace: { name: string } };
    expect(p.name).toBe("Renamed");

    const del = await app.request(`/api/v1/workspaces/${workspace.id}`, { method: "DELETE" });
    expect(del.status).toBe(200);
    const gone = await app.request(`/api/v1/workspaces/${workspace.id}`);
    expect(gone.status).toBe(404);
  });

  it("node lifecycle: add, patch, reorder, delete", async () => {
    const wRes = await app.request("/api/v1/workspaces", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "wsp" }),
    });
    const { workspace } = (await wRes.json()) as { workspace: { id: string } };

    const nodeIds: string[] = [];
    for (const cap of ["demo::tool::x", "demo::tool::y", "demo::tool::z"]) {
      const r = await app.request(`/api/v1/workspaces/${workspace.id}/nodes`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ serverId: "demo", capabilityId: cap }),
      });
      const { node } = (await r.json()) as { node: { id: string } };
      nodeIds.push(node.id);
    }
    expect(nodeIds).toHaveLength(3);

    // Patch middle node with arguments and presentation.
    const patched = await app.request(
      `/api/v1/workspaces/${workspace.id}/nodes/${nodeIds[1]}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          argumentsJson: JSON.stringify({ a: 1 }),
          presentation: "expanded",
        }),
      },
    );
    const { node: pNode } = (await patched.json()) as {
      node: { argumentsJson: string; presentation: string };
    };
    expect(pNode.argumentsJson).toBe('{"a":1}');
    expect(pNode.presentation).toBe("expanded");

    // Reorder [z, x, y] and verify positions.
    const reordered = await app.request(
      `/api/v1/workspaces/${workspace.id}/nodes/reorder`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ orderedIds: [nodeIds[2], nodeIds[0], nodeIds[1]] }),
      },
    );
    const { nodes } = (await reordered.json()) as {
      nodes: Array<{ id: string; position: number }>;
    };
    expect(nodes.map((n) => n.id)).toEqual([nodeIds[2], nodeIds[0], nodeIds[1]]);
    expect(nodes.map((n) => n.position)).toEqual([0, 1, 2]);

    // Delete one node.
    const del = await app.request(
      `/api/v1/workspaces/${workspace.id}/nodes/${nodeIds[0]}`,
      { method: "DELETE" },
    );
    expect(del.status).toBe(200);
    const after = await app.request(`/api/v1/workspaces/${workspace.id}`);
    const afterBody = (await after.json()) as { nodes: Array<{ id: string }> };
    expect(afterBody.nodes.map((n) => n.id)).toEqual([nodeIds[2], nodeIds[1]]);

    await app.request(`/api/v1/workspaces/${workspace.id}`, { method: "DELETE" });
  });

  it("reorder rejects a node id that does not belong to the workspace", async () => {
    const wA = (await (
      await app.request("/api/v1/workspaces", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "A" }),
      })
    ).json()) as { workspace: { id: string } };
    const wB = (await (
      await app.request("/api/v1/workspaces", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "B" }),
      })
    ).json()) as { workspace: { id: string } };
    const nodeInA = (await (
      await app.request(`/api/v1/workspaces/${wA.workspace.id}/nodes`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ capabilityId: "demo::tool::x" }),
      })
    ).json()) as { node: { id: string } };

    // Try to reorder wB with a node id that lives in wA.
    const r = await app.request(`/api/v1/workspaces/${wB.workspace.id}/nodes/reorder`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ orderedIds: [nodeInA.node.id] }),
    });
    expect(r.status).toBe(400);

    await app.request(`/api/v1/workspaces/${wA.workspace.id}`, { method: "DELETE" });
    await app.request(`/api/v1/workspaces/${wB.workspace.id}`, { method: "DELETE" });
  });

  it("cross-workspace patch is rejected (a workspace cannot patch another workspace's node)", async () => {
    const wA = (await (
      await app.request("/api/v1/workspaces", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "A" }),
      })
    ).json()) as { workspace: { id: string } };
    const wB = (await (
      await app.request("/api/v1/workspaces", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "B" }),
      })
    ).json()) as { workspace: { id: string } };
    const nodeInA = (await (
      await app.request(`/api/v1/workspaces/${wA.workspace.id}/nodes`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ capabilityId: "demo::tool::x" }),
      })
    ).json()) as { node: { id: string } };

    const r = await app.request(
      `/api/v1/workspaces/${wB.workspace.id}/nodes/${nodeInA.node.id}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ presentation: "focus" }),
      },
    );
    expect(r.status).toBe(404);

    await app.request(`/api/v1/workspaces/${wA.workspace.id}`, { method: "DELETE" });
    await app.request(`/api/v1/workspaces/${wB.workspace.id}`, { method: "DELETE" });
  });

  it("POST /api/v1/workspaces rejects an invalid body", async () => {
    const r = await app.request("/api/v1/workspaces", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "" }),
    });
    expect(r.status).toBe(400);
  });
});
