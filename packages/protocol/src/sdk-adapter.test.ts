import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer, type Server as HttpServer } from "node:http";
import { z } from "zod";
import {
  McpServer,
  createMcpHandler,
  inputRequired,
  type McpHttpHandler,
} from "@modelcontextprotocol/server";
import {
  toNodeHandler,
  NodeStreamableHTTPServerTransport,
} from "@modelcontextprotocol/node";

import {
  MODERN_PROTOCOL_VERSION,
  TASKS_EXTENSION_KEY,
  type McpServerDescriptor,
} from "./index";
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
  // reflect_envelope — returns the request's `_meta` envelope as JSON so the
  // test can inspect what the client actually advertised on the wire.
  mcp.registerTool(
    "reflect_envelope",
    {
      title: "Reflect Envelope",
      description: "Echo the per-request _meta envelope back as JSON",
      inputSchema: z.object({}),
    },
    async (_args, ctx) => {
      const envelope = ctx.mcpReq.envelope ?? {};
      const json = JSON.stringify(envelope);
      return {
        content: [{ type: "text", text: json }],
        structuredContent: { envelope: JSON.parse(json) },
      };
    },
  );
  // ask_color — returns InputRequiredResult so the client must fulfil an
  // elicitation before the tool can complete. Used to exercise MRTR.
  mcp.registerTool(
    "ask_color",
    {
      title: "Ask Color",
      description: "Ask the user for their favorite color",
      inputSchema: z.object({}),
    },
    async () =>
      inputRequired({
        inputRequests: {
          color: inputRequired.elicit({
            message: "What is your favorite color?",
            requestedSchema: z.object({ color: z.string() }),
          }),
        },
        requestState: "state-token-abc",
      }),
  );
  return mcp;
}

describe("createSdkAdapter (streamable-http, legacy era)", () => {
  // Legacy 2025-era: use NodeStreamableHTTPServerTransport directly (no
  // createMcpHandler). McpServer defaults to legacy `SUPPORTED_PROTOCOL_VERSIONS`,
  // does the pre-2026 `initialize` handshake, and never installs the
  // `server/discover` handler.
  let httpServer: HttpServer;
  let mcp: McpServer;
  let transport: NodeStreamableHTTPServerTransport;
  let baseUrl: string;

  beforeAll(async () => {
    mcp = new McpServer({ name: "legacy-mcp", version: "0.0.1" });
    mcp.registerTool(
      "add_numbers",
      {
        title: "Add Numbers",
        inputSchema: z.object({ a: z.number(), b: z.number() }),
        outputSchema: z.object({ sum: z.number() }),
      },
      async ({ a, b }) => ({
        content: [{ type: "text", text: String(a + b) }],
        structuredContent: { sum: a + b },
      }),
    );
    transport = new NodeStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    await mcp.connect(transport);
    httpServer = createServer((req: IncomingMessage, res: ServerResponse) => {
      void transport.handleRequest(req, res);
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
    await mcp?.close();
    await new Promise<void>((resolve) => httpServer?.close(() => resolve()));
  });

  it("negotiates legacy era via initialize and executes a tool", async () => {
    const adapter = createSdkAdapter();
    const descriptor: McpServerDescriptor = {
      id: "legacy-server",
      displayName: "Legacy",
      transport: "streamable-http",
      url: baseUrl,
      protocol: { policy: "legacy" },
    };

    const negotiation = await adapter.connect(descriptor);
    expect(negotiation.negotiatedEra).toBe("legacy");
    expect(negotiation.selectedVersion).toBeDefined();
    // Legacy set must NOT include 2026-07-28.
    expect(negotiation.selectedVersion).not.toBe(MODERN_PROTOCOL_VERSION);

    const { value, evidence } = await adapter.callTool({
      serverId: descriptor.id,
      name: "add_numbers",
      arguments: { a: 4, b: 5 },
    });
    expect(value).toEqual({ sum: 9 });
    expect(evidence.era).toBe("legacy");
    expect(evidence.resultType).toBe("complete");

    await adapter.disconnect(descriptor.id);
  }, 15_000);

  it("policy='auto' against a legacy-only server falls back to legacy", async () => {
    const adapter = createSdkAdapter();
    const descriptor: McpServerDescriptor = {
      id: "auto-legacy",
      displayName: "Auto Legacy",
      transport: "streamable-http",
      url: baseUrl,
      protocol: { policy: "auto" },
    };

    const negotiation = await adapter.connect(descriptor);
    expect(negotiation.negotiatedEra).toBe("legacy");
    await adapter.disconnect(descriptor.id);
  }, 15_000);

  // R2 slice 2 (#61): pinned `policy: "modern"` against a legacy-only
  // server MUST fail cleanly and MUST NOT silently downgrade the pin
  // to legacy. Prevents a subtle regression class where `modern` pin
  // becomes advisory instead of prescriptive.
  it("R2: policy='modern' against a legacy-only server rejects without silent downgrade", async () => {
    const adapter = createSdkAdapter();
    const descriptor: McpServerDescriptor = {
      id: "modern-vs-legacy",
      displayName: "Modern-pin vs Legacy",
      transport: "streamable-http",
      url: baseUrl,
      protocol: { policy: "modern" },
    };

    let connectErr: unknown = null;
    let negotiation: Awaited<ReturnType<typeof adapter.connect>> | null = null;
    try {
      negotiation = await adapter.connect(descriptor);
    } catch (err) {
      connectErr = err;
    }
    // Either the SDK rejects the pin (throws) OR the negotiation
    // surfaces a non-modern era — the ONE thing that must never happen
    // is a silent `negotiation.negotiatedEra === "modern"` against a
    // legacy-only server, which would be a correctness regression.
    if (connectErr === null) {
      expect(negotiation).not.toBeNull();
      expect(negotiation?.negotiatedEra).not.toBe("modern");
      await adapter.disconnect(descriptor.id);
    } else {
      // Adapter/SDK cleanly rejects the modern pin — expected path.
      expect(connectErr).toBeTruthy();
    }
  }, 15_000);
});

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

  // R2 slice 1 (#61) — regression guard against SDK #2722: the SDK
  // probe MUST NOT silently downgrade a spec-conformant modern
  // `2026-07-28` server to legacy under `policy: "auto"`.
  it("R2: policy='auto' against a modern-only server classifies modern (SDK #2722 regression guard)", async () => {
    const adapter = createSdkAdapter();
    const descriptor: McpServerDescriptor = {
      id: "auto-modern",
      displayName: "Auto → Modern",
      transport: "streamable-http",
      url: baseUrl,
      protocol: { policy: "auto" },
    };

    const negotiation = await adapter.connect(descriptor);
    expect(negotiation.negotiatedEra).toBe("modern");
    expect(negotiation.selectedVersion).toBe(MODERN_PROTOCOL_VERSION);

    // A single tool call over the auto-classified session settles
    // end-to-end evidence — proves the classification did not merely
    // pass but is actually usable on the negotiated wire.
    const { evidence } = await adapter.callTool({
      serverId: descriptor.id,
      name: "add_numbers",
      arguments: { a: 2, b: 3 },
    });
    expect(evidence.era).toBe("modern");
    expect(evidence.version).toBe(MODERN_PROTOCOL_VERSION);

    await adapter.disconnect(descriptor.id);
  }, 15_000);

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
    expect(tools.map((t) => t.name).sort()).toEqual([
      "add_numbers",
      "ask_color",
      "reflect_envelope",
      "slow_echo",
    ]);

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

  it("surfaces InputRequiredResult in manual mode (MRTR)", async () => {
    const adapter = createSdkAdapter();
    const descriptor: McpServerDescriptor = {
      id: "mrtr",
      displayName: "MRTR",
      transport: "streamable-http",
      url: baseUrl,
      protocol: { policy: "modern" },
    };
    await adapter.connect(descriptor);

    const { value, evidence } = await adapter.callTool({
      serverId: descriptor.id,
      name: "ask_color",
      arguments: {},
    });

    expect(value).toBeNull();
    expect(evidence.resultType).toBe("input_required");
    expect(evidence.era).toBe("modern");
    const ext = evidence.extensions ?? {};
    expect(ext["requestState"]).toBe("state-token-abc");
    // inputRequests is a map keyed by our chosen slot ("color") and each
    // value carries {method:"elicitation/create", params:{...}} on the wire.
    const inputRequests = ext["inputRequests"] as
      | Record<string, { method?: string }>
      | undefined;
    expect(inputRequests?.["color"]?.method).toBe("elicitation/create");

    await adapter.disconnect(descriptor.id);
  }, 15_000);

  it("advertises the tasks extension in per-request clientCapabilities", async () => {
    const adapter = createSdkAdapter();
    const descriptor: McpServerDescriptor = {
      id: "tasks-cap",
      displayName: "Tasks Cap",
      transport: "streamable-http",
      url: baseUrl,
      protocol: { policy: "modern" },
    };
    await adapter.connect(descriptor);

    const { value } = await adapter.callTool({
      serverId: descriptor.id,
      name: "reflect_envelope",
      arguments: {},
    });

    // Server's structuredContent puts the request envelope under `envelope`.
    const envelope = (value as { envelope?: Record<string, unknown> })?.envelope ?? {};
    const caps = envelope["io.modelcontextprotocol/clientCapabilities"] as
      | { extensions?: Record<string, unknown> }
      | undefined;
    expect(caps).toBeDefined();
    expect(caps?.extensions?.[TASKS_EXTENSION_KEY]).toBeDefined();

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
