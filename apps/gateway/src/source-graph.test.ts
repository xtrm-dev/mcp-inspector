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

// Stream E — new routes:
//   GET /api/v1/source/revisions/:id/graph
//   GET /api/v1/source/revisions/:id/code
// Covers nodes, static edges (from calls), runtime edges (from executions),
// bundled code payload (snippet + full symbol + full file + deps + dependents + trace).

describe("source graph + code viewer (Stream E)", () => {
  let demo: DemoMcp;
  let adapter: ReturnType<typeof createSdkAdapter>;
  let app: ReturnType<typeof buildGatewayApp>;
  let storage: Storage;
  let serverManager: ServerManager;
  let secrets: SecretsRegistry;
  let dataDir: string;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "mix-source-graph-"));
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

  async function registerRevision(revisionHash: string): Promise<string> {
    const r = await app.request("/api/v1/source/revisions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ repositoryRef: "xtrm-dev/mcp-inspector", revisionHash }),
    });
    const body = (await r.json()) as { sourceRevision: { id: string } };
    return body.sourceRevision.id;
  }

  async function indexMappings(revisionId: string, entries: unknown[]) {
    const r = await app.request(`/api/v1/source/revisions/${revisionId}/index`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ entries }),
    });
    expect(r.status).toBe(201);
  }

  it("graph route returns nodes + static edges + empty runtime edges before any execution", async () => {
    const revisionId = await registerRevision("aaaaaaa1111111111111111111111111111aaaa");
    await indexMappings(revisionId, [
      {
        capabilityId: "demo::tool::slow_echo",
        kind: "tool",
        handlerSymbol: "slowEcho",
        filePath: "src/handlers.ts",
        lineStart: 5,
        lineEnd: 20,
        snippet: "function slowEcho() {}",
        calls: ["src/util.ts#delay"],
        symbolText: "function slowEcho() { return delay(0) }",
        fileText: "// handlers.ts\nfunction slowEcho() { return delay(0) }\n",
      },
      {
        capabilityId: "demo::tool::helper",
        kind: "tool",
        handlerSymbol: "delay",
        filePath: "src/util.ts",
        lineStart: 1,
        lineEnd: 3,
        snippet: "function delay() {}",
      },
    ]);
    const r = await app.request(`/api/v1/source/revisions/${revisionId}/graph`);
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      nodes: Array<{ id: string; handlerSymbol: string }>;
      staticEdges: Array<{ fromId: string; toId: string }>;
      runtimeEdges: unknown[];
    };
    expect(body.nodes.map((n) => n.id).sort()).toEqual([
      "src/handlers.ts#slowEcho",
      "src/util.ts#delay",
    ]);
    expect(body.staticEdges).toEqual([
      { fromId: "src/handlers.ts#slowEcho", toId: "src/util.ts#delay", relation: "calls" },
    ]);
    expect(body.runtimeEdges).toEqual([]);
  });

  it("graph route surfaces a runtime edge once the capability has an execution", async () => {
    const revisionId = await registerRevision("bbbbbbb2222222222222222222222222222bbbb");
    await indexMappings(revisionId, [
      {
        capabilityId: "demo::tool::slow_echo",
        kind: "tool",
        handlerSymbol: "slowEcho",
        filePath: "src/handlers.ts",
        lineStart: 5,
        lineEnd: 20,
      },
    ]);
    // Real execution against the demo server.
    const call = await app.request("/api/v1/servers/demo/tools/slow_echo/call", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ arguments: { value: 1, delayMs: 0 } }),
    });
    expect(call.status).toBe(200);

    const r = await app.request(`/api/v1/source/revisions/${revisionId}/graph`);
    const body = (await r.json()) as {
      runtimeEdges: Array<{ symbolId: string; capabilityId: string; status: string }>;
    };
    expect(body.runtimeEdges.length).toBeGreaterThan(0);
    expect(body.runtimeEdges[0]?.symbolId).toBe("src/handlers.ts#slowEcho");
  });

  it("code route bundles snippet + full symbol + full file + deps + dependents + trace", async () => {
    const revisionId = await registerRevision("ccccccc3333333333333333333333333333cccc");
    await indexMappings(revisionId, [
      {
        capabilityId: "demo::tool::slow_echo",
        kind: "tool",
        handlerSymbol: "slowEcho",
        filePath: "src/handlers.ts",
        lineStart: 5,
        lineEnd: 20,
        snippet: "function slowEcho() {\n  return delay(0)\n}",
        calls: ["src/util.ts#delay"],
        symbolText: "function slowEcho() {\n  return delay(0)\n}",
        fileText: "// handlers.ts header\nfunction slowEcho() { return delay(0) }\n",
      },
      {
        capabilityId: "demo::tool::helper",
        kind: "tool",
        handlerSymbol: "delay",
        filePath: "src/util.ts",
        lineStart: 1,
        lineEnd: 3,
      },
      {
        capabilityId: "demo::tool::caller",
        kind: "tool",
        handlerSymbol: "caller",
        filePath: "src/api.ts",
        lineStart: 40,
        lineEnd: 55,
        calls: ["src/handlers.ts#slowEcho"],
      },
    ]);
    // Produce a runtime observation.
    await app.request("/api/v1/servers/demo/tools/slow_echo/call", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ arguments: { value: 7, delayMs: 0 } }),
    });

    const r = await app.request(
      `/api/v1/source/revisions/${revisionId}/code?filePath=${encodeURIComponent("src/handlers.ts")}&handlerSymbol=${encodeURIComponent("slowEcho")}`,
    );
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      snippet: { text: string } | null;
      symbolText: string | null;
      fileText: string | null;
      dependencies: Array<{ symbolId: string }>;
      dependents: Array<{ symbolId: string }>;
      trace: Array<{ executionId: string }>;
    };
    expect(body.snippet?.text).toContain("slowEcho");
    expect(body.symbolText).toContain("return delay(0)");
    expect(body.fileText).toContain("// handlers.ts header");
    expect(body.dependencies.map((d) => d.symbolId)).toEqual(["src/util.ts#delay"]);
    expect(body.dependents.map((d) => d.symbolId)).toEqual(["src/api.ts#caller"]);
    expect(body.trace.length).toBeGreaterThan(0);
  });

  it("code route rejects a request without filePath / handlerSymbol", async () => {
    const revisionId = await registerRevision("ddddddd4444444444444444444444444444dddd");
    const r = await app.request(`/api/v1/source/revisions/${revisionId}/code`);
    expect(r.status).toBe(400);
  });

  it("code route 404s when the symbol is not indexed at that revision", async () => {
    const revisionId = await registerRevision("eeeeeee5555555555555555555555555555eeee");
    const r = await app.request(
      `/api/v1/source/revisions/${revisionId}/code?filePath=src/nope.ts&handlerSymbol=none`,
    );
    expect(r.status).toBe(404);
  });
});
