import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSdkAdapter } from "@mcp-inspector-x/protocol";
import { openStorage, type Storage } from "@mcp-inspector-x/storage";
import { buildGatewayApp } from "./routes";
import { createServerManager, type ServerManager } from "./servers";
import { createSecretsRegistry } from "./secrets";

describe("trace substrate + ingest (Phase M slice 1)", () => {
  let storage: Storage;
  let app: ReturnType<typeof buildGatewayApp>;
  let serverManager: ServerManager;
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "mix-traces-"));
    storage = openStorage({ dataDir: dir });
    const adapter = createSdkAdapter();
    const secrets = createSecretsRegistry({ storage });
    serverManager = createServerManager({ storage, adapter, secrets });
    app = buildGatewayApp({ adapter, storage, serverManager, secrets });
  });

  afterEach(() => {
    storage.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("/api/v1/config advertises traceIngestV1=true", async () => {
    const r = await app.request("/api/v1/config");
    const body = (await r.json()) as { capabilities?: { traceIngestV1?: boolean } };
    expect(body.capabilities?.traceIngestV1).toBe(true);
  });

  it("POST /api/v1/traces ingests a trace + emits trace.ingested", async () => {
    const spans = [
      { spanId: "s1", name: "root", startTimeUnixNano: "1", endTimeUnixNano: "2" },
      { spanId: "s2", name: "child", parentSpanId: "s1", startTimeUnixNano: "1", endTimeUnixNano: "2" },
    ];
    const r = await app.request("/api/v1/traces", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ traceId: "abc-123", spans, source: "vitest" }),
    });
    expect(r.status).toBe(201);
    const body = (await r.json()) as {
      trace: { traceId: string; spanCount: number; source: string | null };
    };
    expect(body.trace.traceId).toBe("abc-123");
    expect(body.trace.spanCount).toBe(2);
    expect(body.trace.source).toBe("vitest");

    const events = storage.events.read({ limit: 50 });
    expect(events.some((e) => e.kind === "trace.ingested")).toBe(true);
  });

  it("upsert-on-conflict: same traceId re-post replaces the row", async () => {
    for (const spans of [
      [{ spanId: "s1" }],
      [{ spanId: "s1" }, { spanId: "s2" }],
      [{ spanId: "s1" }, { spanId: "s2" }, { spanId: "s3" }],
    ]) {
      await app.request("/api/v1/traces", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ traceId: "abc-upsert", spans }),
      });
    }
    const r = await app.request("/api/v1/traces/abc-upsert");
    const body = (await r.json()) as { trace: { spanCount: number } };
    expect(body.trace.spanCount).toBe(3);
    const list = (await (await app.request("/api/v1/traces")).json()) as {
      traces: unknown[];
    };
    expect(list.traces).toHaveLength(1);
  });

  it("GET /api/v1/traces/unknown → 404", async () => {
    const r = await app.request("/api/v1/traces/nope");
    expect(r.status).toBe(404);
  });

  it("POST rejects missing traceId or spans", async () => {
    for (const body of [
      {},
      { traceId: "x" },
      { spans: [] },
      { traceId: "", spans: [] },
    ]) {
      const r = await app.request("/api/v1/traces", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      expect(r.status).toBe(400);
    }
  });

  it("bounded default: > 10,000 spans is a 400", async () => {
    const spans = Array(10_001).fill({ spanId: "x" });
    const r = await app.request("/api/v1/traces", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ traceId: "oversized", spans }),
    });
    expect(r.status).toBe(400);
  });
});
