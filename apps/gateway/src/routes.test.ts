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

  // ---- Legacy /api/* routes ----

  it("GET /health returns ok + protocol target", async () => {
    const r = await app.request("/health");
    expect(r.status).toBe(200);
    const body = (await r.json()) as { status?: string; protocolTarget?: string };
    expect(body.status).toBe("ok");
    expect(body.protocolTarget).toBe(MODERN_PROTOCOL_VERSION);
  });

  it("GET /api/config reports liveMcpTransport=true when a server is bound", async () => {
    const r = await app.request("/api/config");
    const body = (await r.json()) as { capabilities?: { liveMcpTransport?: boolean } };
    expect(body.capabilities?.liveMcpTransport).toBe(true);
  });

  it("GET /api/servers lists the bound server and its negotiation", async () => {
    const r = await app.request("/api/servers");
    const body = (await r.json()) as {
      servers: Array<{ id: string; negotiation: { negotiatedEra?: string } }>;
    };
    expect(body.servers).toHaveLength(1);
    expect(body.servers[0]?.id).toBe("demo");
    expect(body.servers[0]?.negotiation.negotiatedEra).toBe("modern");
  });

  it("GET /api/servers/:id/tools returns the demo tool list", async () => {
    const r = await app.request("/api/servers/demo/tools");
    const body = (await r.json()) as { tools: Array<{ name: string }> };
    expect(body.tools.map((t) => t.name).sort()).toEqual(["add_numbers", "slow_echo"]);
  });

  it("GET /api/servers/unknown/tools → 404", async () => {
    const r = await app.request("/api/servers/nope/tools");
    expect(r.status).toBe(404);
  });

  it("POST /api/servers/:id/tools/:name/call executes a real tool", async () => {
    const r = await app.request("/api/servers/demo/tools/add_numbers/call", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ arguments: { a: 7, b: 8 } }),
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { value: unknown; evidence: { resultType?: string } };
    expect(body.value).toEqual({ sum: 15 });
    expect(body.evidence.resultType).toBe("complete");
  });

  // ---- /api/v1/* — versioned surface backed by storage ----

  it("GET /api/v1/health returns apiVersion=v1", async () => {
    const r = await app.request("/api/v1/health");
    const body = (await r.json()) as { apiVersion?: string; protocolTarget?: string };
    expect(body.apiVersion).toBe("v1");
    expect(body.protocolTarget).toBe(MODERN_PROTOCOL_VERSION);
  });

  it("GET /api/v1/servers reads from the durable catalog", async () => {
    const r = await app.request("/api/v1/servers");
    const body = (await r.json()) as {
      servers: Array<{ id: string; transport: string; endpoint: string | null }>;
    };
    expect(body.servers).toHaveLength(1);
    expect(body.servers[0]?.id).toBe("demo");
    expect(body.servers[0]?.transport).toBe("streamable-http");
    expect(body.servers[0]?.endpoint).toBe(descriptor.url);
  });

  it("GET /api/v1/events replays backlog by Last-Event-ID", async () => {
    // Seed a fresh event and confirm it comes back over SSE.
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
