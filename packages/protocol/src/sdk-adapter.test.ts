import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server as HttpServer } from "node:http";
import { z } from "zod";
import { McpServer, createMcpHandler, type McpHttpHandler } from "@modelcontextprotocol/server";
import { toNodeHandler } from "@modelcontextprotocol/node";

import { MODERN_PROTOCOL_VERSION, type McpServerDescriptor } from "./index";
import { createSdkAdapter } from "./sdk-adapter";

function buildTestMcp(): McpServer {
  const mcp = new McpServer(
    { name: "test-mcp", version: "0.0.1" },
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
    async ({ a, b }) => {
      const sum = a + b;
      return {
        content: [{ type: "text", text: JSON.stringify({ sum }) }],
        structuredContent: { sum },
      };
    },
  );
  return mcp;
}

describe("createSdkAdapter (streamable-http, modern era)", () => {
  let httpServer: HttpServer;
  let handler: McpHttpHandler;
  let baseUrl: string;

  beforeAll(async () => {
    handler = createMcpHandler(() => buildTestMcp());
    const nodeHandler = toNodeHandler(handler);
    httpServer = createServer((req, res) => {
      void nodeHandler(req, res);
    });
    await new Promise<void>((resolve, reject) => {
      httpServer.once("error", reject);
      httpServer.listen(0, "127.0.0.1", () => resolve());
    });
    const addr = httpServer.address();
    if (!addr || typeof addr === "string") throw new Error("no bound address");
    baseUrl = `http://127.0.0.1:${addr.port}/`;
  });

  afterAll(async () => {
    await handler?.close();
    await new Promise<void>((resolve) => httpServer?.close(() => resolve()));
  });

  it("negotiates modern era, lists a tool, calls it, returns evidence", async () => {
    const adapter = createSdkAdapter();
    const descriptor: McpServerDescriptor = {
      id: "test-server",
      displayName: "Test",
      transport: "streamable-http",
      url: baseUrl,
      protocol: { policy: "modern" },
    };

    const negotiation = await adapter.connect(descriptor);
    expect(negotiation.negotiatedEra).toBe("modern");
    expect(negotiation.selectedVersion).toBe(MODERN_PROTOCOL_VERSION);

    const tools = await adapter.listTools(descriptor.id);
    expect(tools).toHaveLength(1);
    expect(tools[0]?.name).toBe("add_numbers");
    expect(tools[0]?.title).toBe("Add Numbers");

    const { value, evidence } = await adapter.callTool({
      serverId: descriptor.id,
      name: "add_numbers",
      arguments: { a: 2, b: 3 },
    });
    expect(value).toEqual({ sum: 5 });
    expect(evidence.era).toBe("modern");
    expect(evidence.version).toBe(MODERN_PROTOCOL_VERSION);
    expect(evidence.resultType).toBe("complete");

    await adapter.disconnect(descriptor.id);
  }, 15_000);

  it("rejects a duplicate connect for the same serverId", async () => {
    const adapter = createSdkAdapter();
    const descriptor: McpServerDescriptor = {
      id: "dup",
      displayName: "Dup",
      transport: "streamable-http",
      url: baseUrl,
      protocol: { policy: "modern" },
    };
    await adapter.connect(descriptor);
    await expect(adapter.connect(descriptor)).rejects.toThrow(/already connected/);
    await adapter.disconnect(descriptor.id);
  }, 15_000);
});
