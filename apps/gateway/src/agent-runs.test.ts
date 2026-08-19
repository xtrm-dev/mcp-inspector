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

describe("Agent Runs + capture sessions (Phase L slice 1)", () => {
  let demo: DemoMcp;
  let adapter: ReturnType<typeof createSdkAdapter>;
  let app: ReturnType<typeof buildGatewayApp>;
  let storage: Storage;
  let serverManager: ServerManager;
  let secrets: SecretsRegistry;
  let dataDir: string;
  let workspaceId: string;
  let toolNodeIds: string[] = [];

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "mix-agent-runs-"));
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

    const w = (await (
      await app.request("/api/v1/workspaces", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "run-target" }),
      })
    ).json()) as { workspace: { id: string } };
    workspaceId = w.workspace.id;
    for (const args of [{ a: 1, b: 2 }, { a: 3, b: 4 }]) {
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
  }, 20_000);

  afterAll(async () => {
    for (const b of serverManager?.bindings() ?? []) {
      await adapter?.disconnect(b.descriptor.id).catch(() => {});
    }
    await demo?.close();
    storage?.close();
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
  });

  it("GET /api/v1/config advertises agentRuns=true", async () => {
    const r = await app.request("/api/v1/config");
    const body = (await r.json()) as { capabilities?: { agentRuns?: boolean } };
    expect(body.capabilities?.agentRuns).toBe(true);
  });

  it("a workspace run auto-creates a CaptureSession + AgentRun and links every Execution", async () => {
    const r = await app.request(`/api/v1/workspaces/${workspaceId}/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    const body = (await r.json()) as {
      captureSessionId: string;
      agentRunId: string;
      nodes: Array<{ executionId?: string; ok: boolean }>;
    };
    expect(body.captureSessionId).toBeTruthy();
    expect(body.agentRunId).toBeTruthy();

    // Both Executions link back to the same AgentRun.
    const runExecutionIds = body.nodes.filter((n) => n.ok).map((n) => n.executionId!);
    expect(runExecutionIds.length).toBeGreaterThanOrEqual(2);
    for (const executionId of runExecutionIds) {
      const record = storage.executions.get(executionId);
      expect(record?.agentRunId).toBe(body.agentRunId);
      expect(record?.captureSessionId).toBe(body.captureSessionId);
    }
  }, 15_000);

  it("GET /api/v1/agent-runs lists agent runs DESC + /:id returns linked executions", async () => {
    const r = await app.request("/api/v1/agent-runs?limit=10");
    const list = (await r.json()) as {
      agentRuns: Array<{ id: string; correlationKind: string }>;
    };
    expect(list.agentRuns.length).toBeGreaterThanOrEqual(1);
    const inspectorRuns = list.agentRuns.filter(
      (a) => a.correlationKind === "inspector-run",
    );
    expect(inspectorRuns.length).toBeGreaterThanOrEqual(1);

    const first = inspectorRuns[0]!;
    const detail = await app.request(`/api/v1/agent-runs/${first.id}`);
    const body = (await detail.json()) as {
      agentRun: { id: string; captureSessionId: string; endedAt: string | null };
      executions: Array<{ id: string; agentRunId: string | null }>;
    };
    expect(body.agentRun.id).toBe(first.id);
    expect(body.agentRun.endedAt).not.toBeNull();
    expect(body.executions.length).toBeGreaterThan(0);
    for (const e of body.executions) expect(e.agentRunId).toBe(first.id);
  });

  it("GET /api/v1/capture-sessions/:id returns its agent runs", async () => {
    const list = (await (
      await app.request("/api/v1/capture-sessions?limit=10")
    ).json()) as { captureSessions: Array<{ id: string; kind: string }> };
    const workspaceCapture = list.captureSessions.find((s) => s.kind === "workspace-run");
    expect(workspaceCapture).toBeDefined();
    const detail = (await (
      await app.request(`/api/v1/capture-sessions/${workspaceCapture!.id}`)
    ).json()) as {
      captureSession: { kind: string };
      agentRuns: Array<{ correlationKind: string }>;
    };
    expect(detail.captureSession.kind).toBe("workspace-run");
    expect(detail.agentRuns.length).toBeGreaterThanOrEqual(1);
    expect(detail.agentRuns[0]?.correlationKind).toBe("inspector-run");
  });

  it("unknown agent_run/capture_session → 404", async () => {
    const a = await app.request("/api/v1/agent-runs/nope");
    expect(a.status).toBe(404);
    const b = await app.request("/api/v1/capture-sessions/nope");
    expect(b.status).toBe(404);
  });
});
