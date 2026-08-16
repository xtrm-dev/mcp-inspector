import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";
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
  // slow_echo — sleeps `delayMs` before returning `value`, so concurrent
  // callers actually observe parallelism (fast sync tools finish before
  // the second call would even be scheduled).
  mcp.registerTool(
    "slow_echo",
    {
      title: "Slow Echo",
      description: "Sleep for delayMs, then echo value",
      inputSchema: z.object({ value: z.number(), delayMs: z.number() }),
      outputSchema: z.object({ value: z.number() }),
    },
    async ({ value, delayMs }) => {
      await new Promise((r) => setTimeout(r, delayMs));
      return {
        content: [{ type: "text", text: JSON.stringify({ value }) }],
        structuredContent: { value },
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
    httpServer = createServer((req: IncomingMessage, res: ServerResponse) => {
      // node:http.IncomingMessage types `method`/`url` as `string | undefined`,
      // while @modelcontextprotocol/node's NodeIncomingMessageLike uses
      // optional-`?` under exactOptionalPropertyTypes (no `| undefined`).
      // Structurally identical at runtime; cast to satisfy tsc.
      void nodeHandler(req as unknown as Parameters<typeof nodeHandler>[0], res);
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
    const add = tools.find((t) => t.name === "add_numbers");
    expect(add?.title).toBe("Add Numbers");
    expect(tools.map((t) => t.name).sort()).toEqual(["add_numbers", "slow_echo"]);

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

  it("runs concurrent callTool() on one session in parallel, each result distinct", async () => {
    const adapter = createSdkAdapter();
    const descriptor: McpServerDescriptor = {
      id: "concurrent-single",
      displayName: "Concurrent Single",
      transport: "streamable-http",
      url: baseUrl,
      protocol: { policy: "modern" },
    };
    await adapter.connect(descriptor);

    const N = 10;
    const DELAY = 80;
    const start = performance.now();
    const results = await Promise.all(
      Array.from({ length: N }, (_, i) =>
        adapter.callTool({
          serverId: descriptor.id,
          name: "slow_echo",
          arguments: { value: i, delayMs: DELAY },
        }),
      ),
    );
    const elapsed = performance.now() - start;

    // Each call carries its own value back.
    expect(results.map((r) => r.value)).toEqual(
      Array.from({ length: N }, (_, i) => ({ value: i })),
    );
    // Parallel: total wall-clock << N * DELAY. Generous bound to avoid CI flakes.
    expect(elapsed).toBeLessThan(N * DELAY * 0.6);

    await adapter.disconnect(descriptor.id);
  }, 15_000);

  it("runs concurrent callTool() across multiple sessions independently", async () => {
    const adapter = createSdkAdapter();
    const sessions = ["srv-a", "srv-b", "srv-c"].map(
      (id): McpServerDescriptor => ({
        id,
        displayName: id,
        transport: "streamable-http",
        url: baseUrl,
        protocol: { policy: "modern" },
      }),
    );
    await Promise.all(sessions.map((s) => adapter.connect(s)));

    const DELAY = 60;
    const start = performance.now();
    const results = await Promise.all(
      sessions.map((s, i) =>
        adapter.callTool({
          serverId: s.id,
          name: "slow_echo",
          arguments: { value: 100 + i, delayMs: DELAY },
        }),
      ),
    );
    const elapsed = performance.now() - start;

    expect(results.map((r) => r.value)).toEqual([
      { value: 100 },
      { value: 101 },
      { value: 102 },
    ]);
    // Cross-session parallelism: still bounded by ~1 * DELAY, not N * DELAY.
    expect(elapsed).toBeLessThan(sessions.length * DELAY * 0.7);

    await Promise.all(sessions.map((s) => adapter.disconnect(s.id)));
  }, 15_000);

  it("aborts an in-flight callTool via AbortSignal", async () => {
    const adapter = createSdkAdapter();
    const descriptor: McpServerDescriptor = {
      id: "cancel-target",
      displayName: "Cancel",
      transport: "streamable-http",
      url: baseUrl,
      protocol: { policy: "modern" },
    };
    await adapter.connect(descriptor);

    // Long tool call. Abort well before completion.
    const controller = new AbortController();
    const start = performance.now();
    const inflight = adapter.callTool({
      serverId: descriptor.id,
      name: "slow_echo",
      arguments: { value: 42, delayMs: 10_000 },
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 100);
    await expect(inflight).rejects.toBeDefined();
    const elapsed = performance.now() - start;
    // Must reject well before the 10s tool wall-clock — proves the abort
    // propagated to the per-request stream instead of waiting on the reply.
    expect(elapsed).toBeLessThan(2_000);

    // Session survives an aborted call — the adapter can still run new tools.
    const { value } = await adapter.callTool({
      serverId: descriptor.id,
      name: "add_numbers",
      arguments: { a: 1, b: 2 },
    });
    expect(value).toEqual({ sum: 3 });

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
