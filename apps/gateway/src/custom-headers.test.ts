import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server as HttpServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  McpServer,
  createMcpHandler,
  type McpHttpHandler,
} from "@modelcontextprotocol/server";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { z } from "zod";
import {
  createSdkAdapter,
  MODERN_PROTOCOL_VERSION,
} from "@mcp-inspector-x/protocol";
import { openStorage, type Storage } from "@mcp-inspector-x/storage";
import { buildGatewayApp } from "./routes";
import { createServerManager, type ServerManager } from "./servers";
import { createSecretsRegistry, type SecretsRegistry } from "./secrets";

// Header-gated demo MCP — proves headerCredentials → descriptor.customHeaders
// → StreamableHTTPClientTransport requestInit.headers actually flows through
// to the wire. Rejects with 401 unless X-Api-Key matches.
const REQUIRED_API_KEY = "sk_test_headers_e2e_2026";

function buildGatedServer(): McpServer {
  const mcp = new McpServer(
    { name: "mcp-inspector-x-hdrs-test", version: "0.0.1" },
    { supportedProtocolVersions: [MODERN_PROTOCOL_VERSION] },
  );
  mcp.registerTool(
    "add_numbers",
    {
      title: "Add Numbers",
      description: "Return the sum of a and b",
      inputSchema: z.object({ a: z.number(), b: z.number() }),
      outputSchema: z.object({ sum: z.number() }),
    },
    async ({ a, b }) => ({
      content: [{ type: "text" as const, text: JSON.stringify({ sum: a + b }) }],
      structuredContent: { sum: a + b },
    }),
  );
  return mcp;
}

async function startGatedMcp(): Promise<{ url: string; close: () => Promise<void> }> {
  const handler: McpHttpHandler = createMcpHandler(() => buildGatedServer());
  const nodeHandler = toNodeHandler(handler);
  const server: HttpServer = createServer((req, res) => {
    const supplied = req.headers["x-api-key"];
    if (supplied !== REQUIRED_API_KEY) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "missing or invalid X-Api-Key" }));
      return;
    }
    void nodeHandler(req as unknown as Parameters<typeof nodeHandler>[0], res);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("gated-mcp: no bound address");
  return {
    url: `http://127.0.0.1:${addr.port}/`,
    async close() {
      await handler.close();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}

describe("custom-header credentials (streamable-http)", () => {
  let gated: Awaited<ReturnType<typeof startGatedMcp>>;
  let adapter: ReturnType<typeof createSdkAdapter>;
  let app: ReturnType<typeof buildGatewayApp>;
  let storage: Storage;
  let serverManager: ServerManager;
  let secrets: SecretsRegistry;
  let dataDir: string;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "mix-gateway-hdrs-"));
    storage = openStorage({ dataDir });
    gated = await startGatedMcp();
    adapter = createSdkAdapter();
    // The env-provider credential resolves at connect time by reading
    // process.env[key]; we set the value here so the test does not depend
    // on external environment.
    process.env["MIX_HDRS_TEST_API_KEY"] = REQUIRED_API_KEY;
    secrets = createSecretsRegistry({ storage });
    serverManager = createServerManager({ storage, adapter, secrets });
    app = buildGatewayApp({ adapter, storage, serverManager, secrets });
  }, 15_000);

  afterAll(async () => {
    for (const b of serverManager?.bindings() ?? []) {
      await serverManager.disconnect(b.descriptor.id).catch(() => {});
    }
    await gated?.close();
    storage?.close();
    delete process.env["MIX_HDRS_TEST_API_KEY"];
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
  }, 15_000);

  it("connects and calls a tool when headerCredentials populate X-Api-Key correctly", async () => {
    // 1. Register the env-backed credential ref.
    const credRes = await app.request("/api/v1/credentials", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: "env", key: "MIX_HDRS_TEST_API_KEY" }),
    });
    expect(credRes.status).toBe(201);
    const cred = (await credRes.json()) as { credentialRef: { id: string } };

    // 2. Add the gated server with headerCredentials mapping X-Api-Key → ref.
    const addRes = await app.request("/api/v1/servers", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        displayName: "hdrs-test",
        transport: "streamable-http",
        endpoint: gated.url,
        headerCredentials: { "X-Api-Key": cred.credentialRef.id },
        connectNow: true,
      }),
    });
    expect(addRes.status).toBe(201);
    const added = (await addRes.json()) as { server: { id: string }; connected: boolean };
    expect(added.connected).toBe(true);

    // 3. Call the tool through the connected binding — proves the header
    //    reached the wire and the SDK negotiated modern era.
    const callRes = await app.request(
      `/api/v1/servers/${added.server.id}/tools/add_numbers/call`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ arguments: { a: 6, b: 9 } }),
      },
    );
    expect(callRes.status).toBe(200);
    const call = (await callRes.json()) as { value: { sum: number }; status: string };
    expect(call.status).toBe("complete");
    expect(call.value.sum).toBe(15);
  });

  it("fails connect with a clear error when no headerCredentials are supplied for a gated server", async () => {
    const res = await app.request("/api/v1/servers", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        displayName: "hdrs-test-no-key",
        transport: "streamable-http",
        endpoint: gated.url,
        connectNow: true,
      }),
    });
    // Server row still persists (createServer succeeds), but the connectNow
    // attempt records connected:false with the transport 401 in connectError.
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      connected: boolean;
      connectError: string | null;
    };
    expect(body.connected).toBe(false);
    expect(body.connectError).toMatch(/401|unauthor/i);
  });

  it("rejects invalid header names at the API boundary (Zod)", async () => {
    const res = await app.request("/api/v1/servers", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        displayName: "hdrs-bad-name",
        transport: "streamable-http",
        endpoint: gated.url,
        headerCredentials: { "not a header\n": "irrelevant" },
      }),
    });
    expect(res.status).toBe(400);
  });
});
