import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSdkAdapter } from "@mcp-inspector-x/protocol";
import { openStorage, type Storage } from "@mcp-inspector-x/storage";
import { startDemoMcp, type DemoMcp } from "./demo-mcp";
import { buildGatewayApp } from "./routes";
import { createServerManager, type ServerManager } from "./servers";
import { diffJsonStrings } from "./compare";

describe("execution history + comparison", () => {
  let demo: DemoMcp;
  let adapter: ReturnType<typeof createSdkAdapter>;
  let app: ReturnType<typeof buildGatewayApp>;
  let storage: Storage;
  let serverManager: ServerManager;
  let dataDir: string;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "mix-history-"));
    storage = openStorage({ dataDir });
    demo = await startDemoMcp();
    adapter = createSdkAdapter();
    serverManager = createServerManager({ storage, adapter });
    const demoDef = storage.servers.upsertById({
      id: "demo",
      displayName: "Demo",
      transport: "streamable-http",
      endpoint: demo.url,
      protocolPolicy: "modern",
    });
    await serverManager.connect(demoDef);
    app = buildGatewayApp({ adapter, storage, serverManager });
  }, 15_000);

  afterAll(async () => {
    for (const b of serverManager?.bindings() ?? []) {
      await adapter?.disconnect(b.descriptor.id).catch(() => {});
    }
    await demo?.close();
    storage?.close();
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
  });

  it("GET /api/v1/config advertises executionHistory + executionComparison", async () => {
    const r = await app.request("/api/v1/config");
    const body = (await r.json()) as {
      capabilities?: { executionHistory?: boolean; executionComparison?: boolean };
    };
    expect(body.capabilities?.executionHistory).toBe(true);
    expect(body.capabilities?.executionComparison).toBe(true);
  });

  it("history for a capability lists all its executions DESC by startedAt", async () => {
    // Fire three add_numbers calls with different args.
    const ids: string[] = [];
    for (const args of [{ a: 1, b: 2 }, { a: 10, b: 20 }, { a: 100, b: 200 }]) {
      const r = await app.request("/api/v1/servers/demo/tools/add_numbers/call", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ arguments: args }),
      });
      const body = (await r.json()) as { executionId: string };
      ids.push(body.executionId);
    }
    const r = await app.request(
      `/api/v1/capabilities/${encodeURIComponent("demo::tool::add_numbers")}/executions?limit=10`,
    );
    const { executions } = (await r.json()) as {
      executions: Array<{ id: string; startedAt: string }>;
    };
    // All three we just created must be in there (may be interleaved with others).
    for (const id of ids) expect(executions.some((e) => e.id === id)).toBe(true);
    for (let i = 1; i < executions.length; i++) {
      expect(executions[i - 1]!.startedAt >= executions[i]!.startedAt).toBe(true);
    }
  }, 15_000);

  it("GET /api/v1/executions?capabilityId=… filters history to that capability", async () => {
    const r = await app.request(
      `/api/v1/executions?capabilityId=${encodeURIComponent("demo::tool::add_numbers")}&limit=100`,
    );
    const { executions } = (await r.json()) as {
      executions: Array<{ capabilityId: string }>;
    };
    for (const e of executions) expect(e.capabilityId).toBe("demo::tool::add_numbers");
  });

  it("POST /api/v1/executions/compare returns a structural diff", async () => {
    const one = (await (
      await app.request("/api/v1/servers/demo/tools/add_numbers/call", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ arguments: { a: 2, b: 3 } }),
      })
    ).json()) as { executionId: string };
    const two = (await (
      await app.request("/api/v1/servers/demo/tools/add_numbers/call", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ arguments: { a: 20, b: 30 } }),
      })
    ).json()) as { executionId: string };

    const r = await app.request("/api/v1/executions/compare", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ leftId: one.executionId, rightId: two.executionId }),
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      diff: {
        capabilityId: { equal: boolean };
        status: { equal: boolean; left: string; right: string };
        firstRoundArguments: { equal: boolean; changes: unknown[] };
        firstRoundResult: { equal: boolean; changes: unknown[] };
        firstRoundError: { equal: boolean };
      };
    };
    expect(body.diff.capabilityId.equal).toBe(true);
    expect(body.diff.status.left).toBe("complete");
    expect(body.diff.status.right).toBe("complete");
    expect(body.diff.status.equal).toBe(true);
    expect(body.diff.firstRoundArguments.equal).toBe(false);
    // Both a and b differ, so at least those two paths appear.
    expect(body.diff.firstRoundArguments.changes.length).toBeGreaterThanOrEqual(2);
    expect(body.diff.firstRoundResult.equal).toBe(false);
    expect(body.diff.firstRoundError.equal).toBe(true);
  }, 15_000);

  it("POST /api/v1/executions/compare rejects a missing id", async () => {
    const r = await app.request("/api/v1/executions/compare", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ leftId: "known-missing" }),
    });
    expect(r.status).toBe(400);
  });

  it("POST /api/v1/executions/compare returns 404 for an unknown id", async () => {
    const created = (await (
      await app.request("/api/v1/servers/demo/tools/add_numbers/call", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ arguments: { a: 1, b: 1 } }),
      })
    ).json()) as { executionId: string };
    const r = await app.request("/api/v1/executions/compare", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ leftId: created.executionId, rightId: "definitely-not-a-real-id" }),
    });
    expect(r.status).toBe(404);
  });
});

// Unit tests for the pure diff helper.
describe("diffJsonStrings (pure)", () => {
  it("returns equal=true for identical JSON", () => {
    expect(diffJsonStrings('{"a":1}', '{"a":1}')).toEqual({ equal: true, changes: [] });
  });

  it("detects added / removed / changed / type-changed", () => {
    const d = diffJsonStrings('{"a":1,"b":2,"c":3}', '{"a":1,"b":"two","d":4}');
    expect(d.equal).toBe(false);
    const kinds = d.changes.map((c) => `${c.path}:${c.kind}`).sort();
    expect(kinds).toEqual([
      "$.b:type-changed",
      "$.c:removed",
      "$.d:added",
    ]);
  });

  it("walks arrays", () => {
    const d = diffJsonStrings("[1,2,3]", "[1,9,3,4]");
    expect(d.equal).toBe(false);
    const kinds = d.changes.map((c) => `${c.path}:${c.kind}`);
    expect(kinds).toContain("$[1]:changed");
    expect(kinds).toContain("$[3]:added");
  });

  it("falls back to string equality on unparseable JSON, marking the reason", () => {
    const d = diffJsonStrings("not-json", "not-json");
    expect(d.equal).toBe(true);
    const d2 = diffJsonStrings("not-json", "also-not-json");
    expect(d2.equal).toBe(false);
    expect(d2.reason).toContain("unparseable");
  });

  it("treats null both sides as equal without changes", () => {
    expect(diffJsonStrings(null, null)).toEqual({ equal: true, changes: [] });
  });
});
