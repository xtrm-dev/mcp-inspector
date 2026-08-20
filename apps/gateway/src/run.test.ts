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

describe("workspace Run Selected / Run All", () => {
  let demo: DemoMcp;
  let adapter: ReturnType<typeof createSdkAdapter>;
  let app: ReturnType<typeof buildGatewayApp>;
  let storage: Storage;
  let serverManager: ServerManager;
  let secrets: SecretsRegistry;
  let dataDir: string;
  let workspaceId: string;
  let toolNodeIds: string[] = [];
  let promptNodeId: string;
  let unboundNodeId: string;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "mix-run-"));
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

    // Build a workspace with three tool nodes + one prompt node + one unbound.
    const w = (await (
      await app.request("/api/v1/workspaces", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "run-target" }),
      })
    ).json()) as { workspace: { id: string } };
    workspaceId = w.workspace.id;

    for (const args of [{ a: 1, b: 2 }, { a: 3, b: 4 }, { a: 5, b: 6 }]) {
      const r = await app.request(`/api/v1/workspaces/${workspaceId}/nodes`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          serverId: "demo",
          capabilityId: "demo::tool::add_numbers",
          argumentsJson: JSON.stringify(args),
        }),
      });
      const body = (await r.json()) as { node: { id: string } };
      toolNodeIds.push(body.node.id);
    }
    const p = await app.request(`/api/v1/workspaces/${workspaceId}/nodes`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        serverId: "demo",
        capabilityId: "demo::prompt::greeting",
        argumentsJson: JSON.stringify({ name: "world" }),
      }),
    });
    promptNodeId = ((await p.json()) as { node: { id: string } }).node.id;

    const u = await app.request(`/api/v1/workspaces/${workspaceId}/nodes`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    unboundNodeId = ((await u.json()) as { node: { id: string } }).node.id;
  }, 20_000);

  afterAll(async () => {
    for (const b of serverManager?.bindings() ?? []) {
      await adapter?.disconnect(b.descriptor.id).catch(() => {});
    }
    await demo?.close();
    storage?.close();
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
  });

  it("GET /api/v1/config advertises runAll + runSelected", async () => {
    const r = await app.request("/api/v1/config");
    const body = (await r.json()) as { capabilities?: { runAll?: boolean; runSelected?: boolean } };
    expect(body.capabilities?.runAll).toBe(true);
    expect(body.capabilities?.runSelected).toBe(true);
  });

  it("POST /run (no nodeIds) runs every workspace node with bounded concurrency", async () => {
    const r = await app.request(`/api/v1/workspaces/${workspaceId}/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      runId: string;
      concurrency: number;
      nodes: Array<{ nodeId: string; ok: boolean; skippedReason?: string; executionId?: string }>;
    };
    expect(body.runId).toBeTruthy();
    expect(body.concurrency).toBe(4);
    expect(body.nodes.length).toBe(5);
    // Three tool nodes complete OK with an Execution id.
    const toolResults = body.nodes.filter((n) => toolNodeIds.includes(n.nodeId));
    expect(toolResults.every((n) => n.ok && n.executionId)).toBe(true);
    // Prompt node dispatch lands with Phase E slice 2B.
    const promptResult = body.nodes.find((n) => n.nodeId === promptNodeId);
    expect(promptResult?.ok).toBe(true);
    expect(promptResult?.executionId).toBeTruthy();
    // Unbound node is explicitly skipped.
    const unbound = body.nodes.find((n) => n.nodeId === unboundNodeId);
    expect(unbound?.ok).toBe(false);
    expect(unbound?.skippedReason).toBe("unbound-capability");
  }, 20_000);

  it("POST /run with a subset of nodeIds runs only those nodes", async () => {
    const subset = toolNodeIds.slice(0, 2);
    const r = await app.request(`/api/v1/workspaces/${workspaceId}/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ nodeIds: subset }),
    });
    const body = (await r.json()) as {
      nodes: Array<{ nodeId: string; ok: boolean }>;
    };
    expect(body.nodes.map((n) => n.nodeId).sort()).toEqual(subset.sort());
  }, 15_000);

  it("bounded concurrency: > MAX_CONCURRENCY is a 400", async () => {
    const r = await app.request(`/api/v1/workspaces/${workspaceId}/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ concurrency: 999 }),
    });
    expect(r.status).toBe(400);
  });

  it("unknown workspace → 404", async () => {
    const r = await app.request("/api/v1/workspaces/nope/run", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(r.status).toBe(404);
  });

  it("emits workspace.run.started + workspace.run.finished events", async () => {
    const before = storage.events.read({ limit: 100000 }).length;
    await app.request(`/api/v1/workspaces/${workspaceId}/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ nodeIds: [toolNodeIds[0]!] }),
    });
    const after = storage.events.read({ limit: 100000, sinceSeq: 0 });
    const runEvents = after.slice(before).map((e) => e.kind);
    expect(runEvents).toContain("workspace.run.started");
    expect(runEvents).toContain("workspace.run.finished");
    expect(runEvents).toContain("workspace.run.node.started");
    expect(runEvents).toContain("workspace.run.node.complete");
  }, 15_000);

  it("failure isolation: one broken node does not fail siblings", async () => {
    // Create a node bound to a nonexistent tool so the SDK returns an error.
    const bad = (await (
      await app.request(`/api/v1/workspaces/${workspaceId}/nodes`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          serverId: "demo",
          capabilityId: "demo::tool::does_not_exist",
          argumentsJson: JSON.stringify({}),
        }),
      })
    ).json()) as { node: { id: string } };

    const r = await app.request(`/api/v1/workspaces/${workspaceId}/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ nodeIds: [bad.node.id, toolNodeIds[0]!] }),
    });
    const body = (await r.json()) as {
      nodes: Array<{ nodeId: string; ok: boolean; executionId?: string }>;
    };
    const goodResult = body.nodes.find((n) => n.nodeId === toolNodeIds[0]);
    const badResult = body.nodes.find((n) => n.nodeId === bad.node.id);
    expect(goodResult?.ok).toBe(true);
    expect(badResult?.ok).toBe(false);
    // Both still get an Execution row.
    expect(goodResult?.executionId).toBeTruthy();
    expect(badResult?.executionId).toBeTruthy();

    await app.request(`/api/v1/workspaces/${workspaceId}/nodes/${bad.node.id}`, {
      method: "DELETE",
    });
  }, 15_000);
});
