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

describe("capability source mapping (Phase M slice 3)", () => {
  let demo: DemoMcp;
  let adapter: ReturnType<typeof createSdkAdapter>;
  let app: ReturnType<typeof buildGatewayApp>;
  let storage: Storage;
  let serverManager: ServerManager;
  let secrets: SecretsRegistry;
  let dataDir: string;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "mix-source-index-"));
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

  it("GET /api/v1/config advertises capabilitySourceMappingV1=true", async () => {
    const r = await app.request("/api/v1/config");
    const body = (await r.json()) as { capabilities?: { capabilitySourceMappingV1?: boolean } };
    expect(body.capabilities?.capabilitySourceMappingV1).toBe(true);
  });

  it("unknown mapping: execution has no sourceHint, and GET returns 404 (runs before any ingest)", async () => {
    const r = await app.request("/api/v1/servers/demo/tools/slow_echo/call", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ arguments: { value: 42, delayMs: 0 } }),
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { sourceHint?: unknown };
    expect(body.sourceHint).toBeUndefined();

    const revisionId = await registerRevision("5555555555555555555555555555555555eeee");
    const missing = await app.request(
      `/api/v1/source/revisions/${revisionId}/capabilities/${encodeURIComponent("demo::tool::slow_echo")}`,
    );
    expect(missing.status).toBe(404);
  });

  it("ingests 3 mappings for one revision, all retrievable individually", async () => {
    const revisionId = await registerRevision("1111111111111111111111111111111111aaaa");
    const entries = [
      {
        capabilityId: "demo::tool::add_numbers",
        kind: "tool",
        handlerSymbol: "addNumbersHandler",
        filePath: "apps/gateway/src/demo-mcp.ts",
        lineStart: 40,
        lineEnd: 55,
      },
      {
        capabilityId: "demo::tool::slow_echo",
        kind: "tool",
        handlerSymbol: "slowEchoHandler",
        filePath: "apps/gateway/src/demo-mcp.ts",
        lineStart: 60,
        lineEnd: 70,
      },
      {
        capabilityId: "demo::resource::config",
        kind: "resource",
        handlerSymbol: "configResourceHandler",
        filePath: "apps/gateway/src/demo-mcp.ts",
        lineStart: 80,
        lineEnd: 90,
      },
    ];

    const indexRes = await app.request(`/api/v1/source/revisions/${revisionId}/index`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ entries }),
    });
    expect(indexRes.status).toBe(201);
    const indexBody = (await indexRes.json()) as { indexed: Array<{ capabilityId: string }> };
    expect(indexBody.indexed).toHaveLength(3);

    for (const entry of entries) {
      const r = await app.request(
        `/api/v1/source/revisions/${revisionId}/capabilities/${encodeURIComponent(entry.capabilityId)}`,
      );
      expect(r.status).toBe(200);
      const body = (await r.json()) as {
        mapping: { capabilityId: string; handlerSymbol: string; filePath: string };
      };
      expect(body.mapping.capabilityId).toBe(entry.capabilityId);
      expect(body.mapping.handlerSymbol).toBe(entry.handlerSymbol);
      expect(body.mapping.filePath).toBe(entry.filePath);
    }
  });

  it("rejects an ingest batch for an unknown revision — 404, not a guess at 'main'", async () => {
    const r = await app.request("/api/v1/source/revisions/does-not-exist/index", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        entries: [
          {
            capabilityId: "x::tool::y",
            kind: "tool",
            handlerSymbol: "y",
            filePath: "x.ts",
            lineStart: 1,
            lineEnd: 2,
          },
        ],
      }),
    });
    expect(r.status).toBe(404);
  });

  it("rejects malformed entries with 400", async () => {
    const revisionId = await registerRevision("2222222222222222222222222222222222bbbb");
    const r = await app.request(`/api/v1/source/revisions/${revisionId}/index`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ entries: [{ capabilityId: "x::tool::y" }] }),
    });
    expect(r.status).toBe(400);
  });

  it("bounds a 200-line snippet to a 40-line window with real-line-number truncation markers", async () => {
    const revisionId = await registerRevision("3333333333333333333333333333333333cccc");
    const lineStart = 10;
    const lineCount = 200;
    const snippetLines = Array.from({ length: lineCount }, (_, i) => `line ${lineStart + i}`);
    const snippet = snippetLines.join("\n");
    const capabilityId = "demo::tool::big_handler";

    await app.request(`/api/v1/source/revisions/${revisionId}/index`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        entries: [
          {
            capabilityId,
            kind: "tool",
            handlerSymbol: "bigHandler",
            filePath: "apps/gateway/src/big.ts",
            lineStart,
            lineEnd: lineStart + lineCount - 1,
            snippet,
          },
        ],
      }),
    });

    const r = await app.request(
      `/api/v1/source/revisions/${revisionId}/capabilities/${encodeURIComponent(capabilityId)}`,
    );
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      mapping: { lineStart: number; lineEnd: number };
      snippet: { text: string; lineStart: number; lineEnd: number; truncated: boolean } | null;
    };

    // The full symbol span is preserved on the mapping itself.
    expect(body.mapping.lineStart).toBe(lineStart);
    expect(body.mapping.lineEnd).toBe(lineStart + lineCount - 1);

    expect(body.snippet).not.toBeNull();
    const snippetOut = body.snippet!;
    expect(snippetOut.truncated).toBe(true);
    expect(snippetOut.lineStart).toBe(lineStart);
    expect(snippetOut.lineEnd).toBe(lineStart + lineCount - 1);

    const outLines = snippetOut.text.split("\n");
    expect(outLines.length).toBeLessThanOrEqual(40);
    // Real line numbers, not a re-based 1..N: first line is the real
    // starting line, and the surviving head/tail content still carries the
    // original "line N" markers from the source snippet.
    expect(outLines[0]).toBe(`line ${lineStart}`);
    expect(outLines[outLines.length - 1]).toBe(`line ${lineStart + lineCount - 1}`);
    const markerLine = outLines.find((l) => l.includes("omitted"));
    expect(markerLine).toBeDefined();
    expect(markerLine).toMatch(/L\d+-L\d+/);
  });

  it("execution sourceHint: calling add_numbers after indexing its mapping returns sourceHint", async () => {
    const revisionId = await registerRevision("4444444444444444444444444444444444dddd");
    await app.request(`/api/v1/source/revisions/${revisionId}/index`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        entries: [
          {
            capabilityId: "demo::tool::add_numbers",
            kind: "tool",
            handlerSymbol: "addNumbersHandler",
            filePath: "apps/gateway/src/demo-mcp.ts",
            lineStart: 40,
            lineEnd: 55,
          },
        ],
      }),
    });

    const r = await app.request("/api/v1/servers/demo/tools/add_numbers/call", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ arguments: { a: 2, b: 3 } }),
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      sourceHint?: { revisionId: string; filePath: string; symbol: string; lineStart: number; lineEnd: number };
    };
    expect(body.sourceHint).toBeDefined();
    expect(body.sourceHint?.revisionId).toBe(revisionId);
    expect(body.sourceHint?.filePath).toBe("apps/gateway/src/demo-mcp.ts");
    expect(body.sourceHint?.symbol).toBe("addNumbersHandler");
    expect(body.sourceHint?.lineStart).toBe(40);
    expect(body.sourceHint?.lineEnd).toBe(55);
  });
});
