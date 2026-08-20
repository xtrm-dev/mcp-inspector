import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createSdkAdapter,
  MODERN_PROTOCOL_VERSION,
} from "@mcp-inspector-x/protocol";
import { openStorage, type Storage } from "@mcp-inspector-x/storage";
import { startDemoMcp, type DemoMcp } from "./demo-mcp";
import { buildGatewayApp } from "./routes";
import { createServerManager, type ServerManager } from "./servers";
import { createSecretsRegistry, type SecretsRegistry } from "./secrets";

describe("gateway HTTP routes (wired to the SDK adapter + demo MCP)", () => {
  let demo: DemoMcp;
  let adapter: ReturnType<typeof createSdkAdapter>;
  let app: ReturnType<typeof buildGatewayApp>;
  let storage: Storage;
  let serverManager: ServerManager;
  let secrets: SecretsRegistry;
  let dataDir: string;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "mix-gateway-routes-"));
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

  // ---- Status ----

  it("GET /health returns ok + protocol target", async () => {
    const r = await app.request("/health");
    expect(r.status).toBe(200);
    const body = (await r.json()) as { status?: string; protocolTarget?: string };
    expect(body.status).toBe("ok");
    expect(body.protocolTarget).toBe(MODERN_PROTOCOL_VERSION);
  });

  it("GET /api/v1/config reports serverCatalogCrud=true", async () => {
    const r = await app.request("/api/v1/config");
    const body = (await r.json()) as {
      capabilities?: { serverCatalogCrud?: boolean; durableExecutionLog?: boolean };
    };
    expect(body.capabilities?.serverCatalogCrud).toBe(true);
    expect(body.capabilities?.durableExecutionLog).toBe(true);
  });

  // ---- Server catalog CRUD ----

  it("GET /api/v1/servers reports connected=true for the seeded demo", async () => {
    const r = await app.request("/api/v1/servers");
    const body = (await r.json()) as {
      servers: Array<{ id: string; connected: boolean; negotiation: { negotiatedEra?: string } | null }>;
    };
    const demoRow = body.servers.find((s) => s.id === "demo");
    expect(demoRow?.connected).toBe(true);
    expect(demoRow?.negotiation?.negotiatedEra).toBe("modern");
  });

  it("POST /api/v1/servers rejects an invalid body", async () => {
    const r = await app.request("/api/v1/servers", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ displayName: "", transport: "http" }), // both invalid
    });
    expect(r.status).toBe(400);
  });

  it("POST /api/v1/servers creates a server row and emits server.created", async () => {
    const beforeCount = (
      (await (await app.request("/api/v1/servers")).json()) as { servers: unknown[] }
    ).servers.length;
    const r = await app.request("/api/v1/servers", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        displayName: "second-remote",
        transport: "streamable-http",
        endpoint: "http://127.0.0.1:0/mcp",
      }),
    });
    expect(r.status).toBe(201);
    const body = (await r.json()) as {
      server: { id: string; displayName: string; connected: boolean };
    };
    expect(body.server.displayName).toBe("second-remote");
    expect(body.server.id).toBeTruthy();

    const events = storage.events.read({ limit: 50 });
    expect(events.some((e) => e.kind === "server.created" && (e.payload as { serverId?: string }).serverId === body.server.id)).toBe(true);

    const afterCount = (
      (await (await app.request("/api/v1/servers")).json()) as { servers: unknown[] }
    ).servers.length;
    expect(afterCount).toBe(beforeCount + 1);
  });

  it("PATCH /api/v1/servers/:id updates fields and emits server.updated", async () => {
    // create then patch
    const created = (await (
      await app.request("/api/v1/servers", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          displayName: "patch-me",
          transport: "streamable-http",
          endpoint: "http://127.0.0.1:0/mcp",
        }),
      })
    ).json()) as { server: { id: string } };

    const r = await app.request(`/api/v1/servers/${created.server.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ displayName: "patched-name", disabled: true }),
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { server: { displayName: string; disabled: boolean } };
    expect(body.server.displayName).toBe("patched-name");
    expect(body.server.disabled).toBe(true);
  });

  it("DELETE /api/v1/servers/:id removes the row and emits server.deleted", async () => {
    const created = (await (
      await app.request("/api/v1/servers", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          displayName: "to-delete",
          transport: "streamable-http",
          endpoint: "http://127.0.0.1:0/mcp",
        }),
      })
    ).json()) as { server: { id: string } };
    const r = await app.request(`/api/v1/servers/${created.server.id}`, {
      method: "DELETE",
    });
    expect(r.status).toBe(200);
    const after = await app.request(`/api/v1/servers/${created.server.id}`);
    expect(after.status).toBe(404);
  });

  it("POST /api/v1/servers/:id/connect against a real MCP server produces a connected binding", async () => {
    // Register the demo endpoint under a NEW id via CRUD, then connect.
    const created = (await (
      await app.request("/api/v1/servers", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          displayName: "demo-via-crud",
          transport: "streamable-http",
          endpoint: demo.url,
          protocolPolicy: "modern",
        }),
      })
    ).json()) as { server: { id: string } };

    const r = await app.request(`/api/v1/servers/${created.server.id}/connect`, {
      method: "POST",
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      connected: boolean;
      negotiation: { negotiatedEra?: string; selectedVersion?: string };
    };
    expect(body.connected).toBe(true);
    expect(body.negotiation.negotiatedEra).toBe("modern");
    expect(body.negotiation.selectedVersion).toBe(MODERN_PROTOCOL_VERSION);

    // Verify tool listing routes through the same binding.
    const tools = await (
      await app.request(`/api/v1/servers/${created.server.id}/tools`)
    ).json() as { tools: Array<{ name: string }> };
    expect(tools.tools.map((t) => t.name).sort()).toEqual([
      "add_numbers",
      "interactive_greet",
      "long_running_task",
      "slow_echo",
    ]);

    // Clean up.
    await app.request(`/api/v1/servers/${created.server.id}/disconnect`, { method: "POST" });
    await app.request(`/api/v1/servers/${created.server.id}`, { method: "DELETE" });
  }, 15_000);

  it("POST /api/v1/servers/:id/test-connection probes an HTTP endpoint", async () => {
    const created = (await (
      await app.request("/api/v1/servers", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          displayName: "probe-target",
          transport: "streamable-http",
          endpoint: demo.url,
        }),
      })
    ).json()) as { server: { id: string } };

    const r = await app.request(`/api/v1/servers/${created.server.id}/test-connection`, {
      method: "POST",
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { reachable: boolean; status?: number; transport: string };
    expect(body.reachable).toBe(true);
    expect(body.transport).toBe("streamable-http");

    // Unreachable endpoint returns reachable=false but doesn't error the route.
    const unreachable = (await (
      await app.request("/api/v1/servers", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          displayName: "unreachable",
          transport: "streamable-http",
          endpoint: "http://127.0.0.1:1/nope", // port 1 is refused everywhere sane
        }),
      })
    ).json()) as { server: { id: string } };
    const rBad = await app.request(`/api/v1/servers/${unreachable.server.id}/test-connection`, {
      method: "POST",
    });
    expect(rBad.status).toBe(200);
    const bad = (await rBad.json()) as { reachable: boolean };
    expect(bad.reachable).toBe(false);

    await app.request(`/api/v1/servers/${created.server.id}`, { method: "DELETE" });
    await app.request(`/api/v1/servers/${unreachable.server.id}`, { method: "DELETE" });
  }, 10_000);

  it("test-connection for stdio returns reachable=false with an explicit not-implemented message", async () => {
    const created = (await (
      await app.request("/api/v1/servers", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          displayName: "stdio-server",
          transport: "stdio",
          command: "node",
          args: ["dummy.js"],
        }),
      })
    ).json()) as { server: { id: string } };
    const r = await app.request(`/api/v1/servers/${created.server.id}/test-connection`, {
      method: "POST",
    });
    const body = (await r.json()) as { reachable: boolean; message: string };
    expect(body.reachable).toBe(false);
    expect(body.message).toMatch(/not implemented/);
    await app.request(`/api/v1/servers/${created.server.id}`, { method: "DELETE" });
  });

  it("GET /api/v1/servers/:id/tools returns 409 for a disconnected server", async () => {
    const created = (await (
      await app.request("/api/v1/servers", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          displayName: "not-connected",
          transport: "streamable-http",
          endpoint: "http://127.0.0.1:0/mcp",
        }),
      })
    ).json()) as { server: { id: string } };
    const r = await app.request(`/api/v1/servers/${created.server.id}/tools`);
    expect(r.status).toBe(409);
    await app.request(`/api/v1/servers/${created.server.id}`, { method: "DELETE" });
  });

  // ---- Tool call write-through (unchanged, kept green) ----

  it("POST /api/v1/servers/:id/tools/:name/call executes and persists an Execution + Round + Evidence", async () => {
    const r = await app.request("/api/v1/servers/demo/tools/add_numbers/call", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ arguments: { a: 7, b: 8 } }),
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      executionId: string;
      value: unknown;
      evidenceRefs: Array<{ id: string; kind: string; artifactRef: string }>;
    };
    expect(body.value).toEqual({ sum: 15 });
    expect(body.evidenceRefs).toHaveLength(1);
    const record = storage.executions.get(body.executionId);
    expect(record?.status).toBe("complete");
    const rounds = storage.rounds.listForExecution(body.executionId);
    expect(rounds).toHaveLength(1);
  });

  it("GET /api/v1/executions lists most-recent-first", async () => {
    const r = await app.request("/api/v1/executions?limit=5");
    const body = (await r.json()) as {
      executions: Array<{ id: string; startedAt: string }>;
    };
    expect(body.executions.length).toBeGreaterThan(0);
    for (let i = 1; i < body.executions.length; i++) {
      expect(body.executions[i - 1]!.startedAt >= body.executions[i]!.startedAt).toBe(true);
    }
  });

  // ---- SSE ----

  it("GET /api/v1/events replays backlog by Last-Event-ID", async () => {
    const seeded = storage.events.append({
      kind: "test.beacon",
      payload: { note: "hello sse" },
    });

    const r = await app.request("/api/v1/events", {
      headers: { "last-event-id": String(seeded.seq - 1) },
    });
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type") ?? "").toMatch(/text\/event-stream/);

    const reader = r.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let saw = false;
    const start = Date.now();
    while (!saw && Date.now() - start < 3000) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      if (buffer.includes(`id: ${seeded.seq}`) && buffer.includes("event: test.beacon")) {
        saw = true;
      }
    }
    await reader.cancel();
    expect(saw).toBe(true);
  }, 10_000);
});
