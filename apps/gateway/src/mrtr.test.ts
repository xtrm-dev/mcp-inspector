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

// Phase G slice 1 (mcp-inspector-moc.3): MRTR round persistence — the
// interactive_greet demo tool (apps/gateway/src/demo-mcp.ts) round-trips
// input_required → input_response under ONE executionId via
// POST /api/v1/executions/:id/rounds.
describe("MRTR round persistence (interactive_greet)", () => {
  let demo: DemoMcp;
  let adapter: ReturnType<typeof createSdkAdapter>;
  let app: ReturnType<typeof buildGatewayApp>;
  let storage: Storage;
  let serverManager: ServerManager;
  let secrets: SecretsRegistry;
  let dataDir: string;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "mix-gateway-mrtr-"));
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

  it("round 1: initial call returns input_required with one inputRequest", async () => {
    const r = await app.request("/api/v1/servers/demo/tools/interactive_greet/call", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ arguments: {} }),
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      executionId: string;
      status: string;
      inputRequests: Record<string, unknown> | null;
    };
    expect(body.status).toBe("input_required");
    expect(body.inputRequests).toBeTruthy();
    expect(Object.keys(body.inputRequests ?? {})).toEqual(["name"]);

    const record = storage.executions.get(body.executionId);
    expect(record?.status).toBe("input_required");
    const rounds = storage.rounds.listForExecution(body.executionId);
    expect(rounds).toHaveLength(1);
    expect(rounds[0]?.kind).toBe("initial");
  });

  it("round 2: POST /rounds with inputResponses completes under the SAME executionId", async () => {
    const initial = (await (
      await app.request("/api/v1/servers/demo/tools/interactive_greet/call", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ arguments: {} }),
      })
    ).json()) as { executionId: string; status: string };
    expect(initial.status).toBe("input_required");

    const r = await app.request(`/api/v1/executions/${initial.executionId}/rounds`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ inputResponses: { name: { action: "accept", content: { name: "world" } } } }),
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      executionId: string;
      status: string;
      value: { greeting?: string };
    };
    expect(body.executionId).toBe(initial.executionId);
    expect(body.status).toBe("complete");
    expect(body.value?.greeting).toBe("Hello, world");

    // Repo-level assert: BOTH rounds persisted under the SAME executionId.
    const record = storage.executions.get(initial.executionId);
    expect(record?.status).toBe("complete");
    const rounds = storage.rounds.listForExecution(initial.executionId);
    expect(rounds).toHaveLength(2);
    expect(rounds[0]?.kind).toBe("initial");
    expect(rounds[1]?.kind).toBe("input_response");
    expect(new Set(rounds.map((r) => r.executionId))).toEqual(new Set([initial.executionId]));
  });

  it("400 on a follow-up to an execution whose latest round is NOT input_required", async () => {
    const complete = (await (
      await app.request("/api/v1/servers/demo/tools/add_numbers/call", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ arguments: { a: 1, b: 2 } }),
      })
    ).json()) as { executionId: string; status: string };
    expect(complete.status).toBe("complete");

    const r = await app.request(`/api/v1/executions/${complete.executionId}/rounds`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ inputResponses: { name: { action: "accept", content: { name: "world" } } } }),
    });
    expect(r.status).toBe(400);
  });

  it("404 for an unknown executionId", async () => {
    const r = await app.request("/api/v1/executions/does-not-exist/rounds", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ inputResponses: {} }),
    });
    expect(r.status).toBe(404);
  });
});
