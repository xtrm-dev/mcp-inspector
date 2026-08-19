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

describe("resources + prompts (capability-oriented registry)", () => {
  let demo: DemoMcp;
  let adapter: ReturnType<typeof createSdkAdapter>;
  let app: ReturnType<typeof buildGatewayApp>;
  let storage: Storage;
  let serverManager: ServerManager;
  let secrets: SecretsRegistry;
  let dataDir: string;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "mix-capabilities-"));
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

  it("GET /api/v1/config advertises resources=true + prompts=true", async () => {
    const r = await app.request("/api/v1/config");
    const body = (await r.json()) as { capabilities?: { resources?: boolean; prompts?: boolean } };
    expect(body.capabilities?.resources).toBe(true);
    expect(body.capabilities?.prompts).toBe(true);
  });

  // ---- resources ----

  it("GET /api/v1/servers/:id/resources returns the demo README resource", async () => {
    const r = await app.request("/api/v1/servers/demo/resources");
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      resources: Array<{ uri: string; name?: string; mimeType?: string }>;
      resourceTemplates: unknown[];
    };
    const readme = body.resources.find((res) => res.uri === "mix://demo/readme");
    expect(readme).toBeDefined();
    expect(readme?.mimeType).toBe("text/markdown");
  });

  it("POST /api/v1/servers/:id/resources/read returns the resource contents and persists an Execution", async () => {
    const r = await app.request("/api/v1/servers/demo/resources/read", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ uri: "mix://demo/readme" }),
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      executionId: string;
      contents: Array<{ uri: string; text?: string; mimeType?: string }>;
    };
    expect(body.contents).toHaveLength(1);
    expect(body.contents[0]?.text).toContain("MCP Inspector X demo");
    expect(body.contents[0]?.mimeType).toBe("text/markdown");

    const record = storage.executions.get(body.executionId);
    expect(record?.status).toBe("complete");
    expect(record?.capabilityId).toBe("demo::resource::mix://demo/readme");
    const evidence = storage.evidence.listForExecution(body.executionId);
    expect(evidence).toHaveLength(1);
  });

  it("POST /api/v1/servers/:id/resources/read rejects a missing uri", async () => {
    const r = await app.request("/api/v1/servers/demo/resources/read", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(r.status).toBe(400);
  });

  it("GET /api/v1/servers/unknown/resources → 409 (not connected)", async () => {
    const r = await app.request("/api/v1/servers/nope/resources");
    expect(r.status).toBe(409);
  });

  // ---- prompts ----

  it("GET /api/v1/servers/:id/prompts returns the demo greeting prompt", async () => {
    const r = await app.request("/api/v1/servers/demo/prompts");
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      prompts: Array<{ name: string; title?: string; arguments?: Array<{ name: string }> }>;
    };
    const greeting = body.prompts.find((p) => p.name === "greeting");
    expect(greeting).toBeDefined();
    expect(greeting?.title).toBe("Greeting");
    expect(greeting?.arguments?.map((a) => a.name)).toContain("name");
  });

  it("POST /api/v1/servers/:id/prompts/:name/get returns messages and persists an Execution", async () => {
    const r = await app.request("/api/v1/servers/demo/prompts/greeting/get", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ arguments: { name: "World" } }),
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      executionId: string;
      messages: Array<{ role: string; content: unknown }>;
    };
    expect(body.messages.length).toBeGreaterThan(0);
    expect(body.messages[0]?.role).toBe("user");
    // The prompt body should mention "World".
    expect(JSON.stringify(body.messages)).toContain("World");

    const record = storage.executions.get(body.executionId);
    expect(record?.status).toBe("complete");
    expect(record?.capabilityId).toBe("demo::prompt::greeting");
  });

  it("prompts route uses execution/evidence infra (no fake Tool wrapper)", async () => {
    // Confirm capabilityId encodes the capability type as prompt, not tool.
    const before = storage.executions.list({ limit: 1000 }).length;
    await app.request("/api/v1/servers/demo/prompts/greeting/get", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ arguments: { name: "there" } }),
    });
    const after = storage.executions.list({ limit: 1000 });
    expect(after.length).toBe(before + 1);
    expect(after[0]?.capabilityId).toBe("demo::prompt::greeting");
  });
});
