import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createSdkAdapter,
  MODERN_PROTOCOL_VERSION,
  type McpServerDescriptor,
} from "@mcp-inspector-x/protocol";
import { openStorage, type Storage } from "@mcp-inspector-x/storage";
import { startDemoMcp, type DemoMcp } from "./demo-mcp";
import { buildGatewayApp, type ServerBinding } from "./routes";

describe("gateway HTTP routes (wired to the SDK adapter + demo MCP)", () => {
  let demo: DemoMcp;
  let adapter: ReturnType<typeof createSdkAdapter>;
  let app: ReturnType<typeof buildGatewayApp>;
  let storage: Storage;
  let dataDir: string;
  const descriptor: McpServerDescriptor = {
    id: "demo",
    displayName: "Demo",
    transport: "streamable-http",
    url: "",
    protocol: { policy: "modern" },
  };

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "mix-gateway-routes-"));
    storage = openStorage({ dataDir });
    demo = await startDemoMcp();
    descriptor.url = demo.url;
    adapter = createSdkAdapter();
    const negotiation = await adapter.connect(descriptor);
    const servers: ServerBinding[] = [{ descriptor, negotiation }];
    storage.servers.upsertById({
      id: descriptor.id,
      displayName: descriptor.displayName,
      transport: "streamable-http",
      endpoint: demo.url,
      protocolPolicy: "modern",
    });
    app = buildGatewayApp({ adapter, servers, storage });
  }, 15_000);

  afterAll(async () => {
    await adapter?.disconnect(descriptor.id).catch(() => {});
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

  it("GET /api/v1/health returns apiVersion=v1", async () => {
    const r = await app.request("/api/v1/health");
    const body = (await r.json()) as { apiVersion?: string; protocolTarget?: string };
    expect(body.apiVersion).toBe("v1");
    expect(body.protocolTarget).toBe(MODERN_PROTOCOL_VERSION);
  });

  it("GET /api/v1/config reports liveMcpTransport=true when a server is bound", async () => {
    const r = await app.request("/api/v1/config");
    const body = (await r.json()) as {
      apiVersion?: string;
      capabilities?: { liveMcpTransport?: boolean; durableExecutionLog?: boolean };
    };
    expect(body.apiVersion).toBe("v1");
    expect(body.capabilities?.liveMcpTransport).toBe(true);
    expect(body.capabilities?.durableExecutionLog).toBe(true);
  });

  // ---- Legacy routes are gone ----

  it("legacy /api/servers is 404 (deleted in slice 2)", async () => {
    const r = await app.request("/api/servers");
    expect(r.status).toBe(404);
  });

  it("legacy /api/config is 404 (moved to /api/v1/config)", async () => {
    const r = await app.request("/api/config");
    expect(r.status).toBe(404);
  });

  // ---- /api/v1/servers* ----

  it("GET /api/v1/servers reads from the durable catalog + includes negotiation", async () => {
    const r = await app.request("/api/v1/servers");
    const body = (await r.json()) as {
      servers: Array<{
        id: string;
        transport: string;
        endpoint: string | null;
        negotiation: { negotiatedEra?: string } | null;
      }>;
    };
    expect(body.servers).toHaveLength(1);
    expect(body.servers[0]?.id).toBe("demo");
    expect(body.servers[0]?.transport).toBe("streamable-http");
    expect(body.servers[0]?.endpoint).toBe(descriptor.url);
    expect(body.servers[0]?.negotiation?.negotiatedEra).toBe("modern");
  });

  it("GET /api/v1/servers/:id/tools returns the demo tool list", async () => {
    const r = await app.request("/api/v1/servers/demo/tools");
    const body = (await r.json()) as { tools: Array<{ name: string }> };
    expect(body.tools.map((t) => t.name).sort()).toEqual(["add_numbers", "slow_echo"]);
  });

  it("GET /api/v1/servers/unknown/tools → 404", async () => {
    const r = await app.request("/api/v1/servers/nope/tools");
    expect(r.status).toBe(404);
  });

  // ---- Tool call write-through ----

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
      evidence: { resultType?: string };
      evidenceRefs: Array<{ id: string; kind: string; artifactRef: string }>;
    };
    expect(body.value).toEqual({ sum: 15 });
    expect(body.evidence.resultType).toBe("complete");
    expect(body.evidenceRefs).toHaveLength(1);
    expect(body.evidenceRefs[0]?.kind).toBe("raw_response");

    // Durable side effects landed as expected.
    const record = storage.executions.get(body.executionId);
    expect(record?.status).toBe("complete");
    const rounds = storage.rounds.listForExecution(body.executionId);
    expect(rounds).toHaveLength(1);
    expect(rounds[0]?.roundIndex).toBe(0);
    expect(rounds[0]?.kind).toBe("initial");
    expect(rounds[0]?.errorJson).toBeNull();
    const evidence = storage.evidence.listForExecution(body.executionId);
    expect(evidence).toHaveLength(1);
    expect(evidence[0]?.kind).toBe("raw_response");
    const events = storage.events.read({ executionId: body.executionId });
    expect(events.map((e) => e.kind)).toEqual([
      "execution.created",
      "execution.complete",
    ]);
  });

  it("POST tool-call on an unknown server does NOT create an Execution", async () => {
    const before = storage.executions.list({ limit: 1000 }).length;
    const r = await app.request("/api/v1/servers/nope/tools/x/call", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ arguments: {} }),
    });
    expect(r.status).toBe(404);
    const after = storage.executions.list({ limit: 1000 }).length;
    expect(after).toBe(before);
  });

  // ---- Execution history read-through ----

  it("GET /api/v1/executions lists most-recent-first", async () => {
    // Ensure at least one execution exists (from the tool-call test above).
    const r = await app.request("/api/v1/executions?limit=5");
    const body = (await r.json()) as {
      executions: Array<{ id: string; status: string; startedAt: string }>;
    };
    expect(body.executions.length).toBeGreaterThan(0);
    // Ordered by startedAt DESC.
    for (let i = 1; i < body.executions.length; i++) {
      expect(body.executions[i - 1]!.startedAt >= body.executions[i]!.startedAt).toBe(true);
    }
  });

  it("GET /api/v1/executions/:id returns record + rounds + evidence", async () => {
    // Fresh call so we know it's there.
    const call = await app.request("/api/v1/servers/demo/tools/add_numbers/call", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ arguments: { a: 1, b: 2 } }),
    });
    const { executionId } = (await call.json()) as { executionId: string };
    const r = await app.request(`/api/v1/executions/${executionId}`);
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      execution: { id: string; status: string };
      rounds: Array<{ roundIndex: number }>;
      evidence: Array<{ kind: string }>;
    };
    expect(body.execution.id).toBe(executionId);
    expect(body.execution.status).toBe("complete");
    expect(body.rounds).toHaveLength(1);
    expect(body.evidence).toHaveLength(1);
  });

  it("GET /api/v1/executions/unknown → 404", async () => {
    const r = await app.request("/api/v1/executions/nope");
    expect(r.status).toBe(404);
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

  it("GET /api/v1/events streams a live execution.created event for a real tool call", async () => {
    const beforeSeq = storage.events.read({ limit: 1_000_000 }).length; // current tail as proxy
    // Open the SSE from the current tail and fire a call.
    const sinceSeq = storage.events
      .read({ limit: 1_000_000 })
      .reduce((max, e) => Math.max(max, e.seq), 0);

    const [ssePromise, callPromise] = [
      app.request("/api/v1/events", {
        headers: { "last-event-id": String(sinceSeq) },
      }),
      (async () => {
        // Small delay so the SSE handler has attached before the event fires.
        await new Promise((r) => setTimeout(r, 100));
        return app.request("/api/v1/servers/demo/tools/add_numbers/call", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ arguments: { a: 3, b: 4 } }),
        });
      })(),
    ];
    const sseRes = await ssePromise;
    void callPromise; // ensure call fires
    const reader = sseRes.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let saw = false;
    const start = Date.now();
    while (!saw && Date.now() - start < 5000) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      if (buffer.includes("event: execution.created")) saw = true;
    }
    await reader.cancel();
    await callPromise;
    expect(saw).toBe(true);
    expect(beforeSeq).toBeGreaterThanOrEqual(0); // sanity — unused var guard
  }, 10_000);
});
