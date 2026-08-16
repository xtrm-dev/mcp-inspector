import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createSdkAdapter,
  MODERN_PROTOCOL_VERSION,
  type McpServerDescriptor,
} from "@mcp-inspector-x/protocol";
import { startDemoMcp, type DemoMcp } from "./demo-mcp";
import { buildGatewayApp, type ServerBinding } from "./routes";

describe("gateway HTTP routes (wired to the SDK adapter + demo MCP)", () => {
  let demo: DemoMcp;
  let adapter: ReturnType<typeof createSdkAdapter>;
  let app: ReturnType<typeof buildGatewayApp>;
  const descriptor: McpServerDescriptor = {
    id: "demo",
    displayName: "Demo",
    transport: "streamable-http",
    url: "",
    protocol: { policy: "modern" },
  };

  beforeAll(async () => {
    demo = await startDemoMcp();
    descriptor.url = demo.url;
    adapter = createSdkAdapter();
    const negotiation = await adapter.connect(descriptor);
    const servers: ServerBinding[] = [{ descriptor, negotiation }];
    app = buildGatewayApp({ adapter, servers });
  }, 15_000);

  afterAll(async () => {
    await adapter?.disconnect(descriptor.id).catch(() => {});
    await demo?.close();
  });

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
});
