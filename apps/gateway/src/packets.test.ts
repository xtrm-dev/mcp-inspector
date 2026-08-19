import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSdkAdapter } from "@mcp-inspector-x/protocol";
import { openStorage, type Storage } from "@mcp-inspector-x/storage";
import { startDemoMcp, type DemoMcp } from "./demo-mcp";
import { buildGatewayApp } from "./routes";
import { createServerManager, type ServerManager } from "./servers";
import { buildPacket, renderPacketMarkdown } from "./packets";

describe("investigation packets wired to real evidence", () => {
  let demo: DemoMcp;
  let adapter: ReturnType<typeof createSdkAdapter>;
  let app: ReturnType<typeof buildGatewayApp>;
  let storage: Storage;
  let serverManager: ServerManager;
  let dataDir: string;
  let executionIds: string[] = [];

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "mix-packets-"));
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

    // Fire a couple of real tool calls so we have real executions to packet.
    for (const args of [{ a: 1, b: 2 }, { a: 10, b: 20 }]) {
      const r = await app.request("/api/v1/servers/demo/tools/add_numbers/call", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ arguments: args }),
      });
      const body = (await r.json()) as { executionId: string };
      executionIds.push(body.executionId);
    }
  }, 20_000);

  afterAll(async () => {
    for (const b of serverManager?.bindings() ?? []) {
      await adapter?.disconnect(b.descriptor.id).catch(() => {});
    }
    await demo?.close();
    storage?.close();
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
  });

  it("config advertises investigationPacketsV2=true", async () => {
    const r = await app.request("/api/v1/config");
    const body = (await r.json()) as { capabilities?: { investigationPacketsV2?: boolean } };
    expect(body.capabilities?.investigationPacketsV2).toBe(true);
  });

  it("POST /api/v1/packets/build (default) returns a JSON investigation-tier packet", async () => {
    const r = await app.request("/api/v1/packets/build", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ executionIds }),
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      packet: {
        packetId: string;
        tier: string;
        executions: Array<{
          executionId: string;
          capabilityId: string;
          status: string;
          argumentsJson: unknown;
          resultInline: unknown;
          evidence: Array<{ kind: string; artifactRef: string }>;
        }>;
        missing: Array<{ what: string }>;
      };
    };
    expect(body.packet.tier).toBe("investigation");
    expect(body.packet.executions).toHaveLength(2);
    for (const e of body.packet.executions) {
      expect(e.status).toBe("complete");
      expect(e.evidence).toHaveLength(1);
      expect(e.evidence[0]?.kind).toBe("raw_response");
    }
    // Missing evidence is explicit (not silently absent).
    const wants = new Set(body.packet.missing.map((m) => m.what));
    expect(wants.has("source-revision")).toBe(true);
    expect(wants.has("trace-context")).toBe(true);
  });

  it("compact tier strips result payload + evidence", async () => {
    const r = await app.request("/api/v1/packets/build", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ executionIds, tier: "compact" }),
    });
    const body = (await r.json()) as {
      packet: {
        tier: string;
        executions: Array<{ resultInline: unknown; resultArtifact: unknown; evidence?: unknown[] }>;
      };
    };
    expect(body.packet.tier).toBe("compact");
    for (const e of body.packet.executions) {
      expect(e.resultInline).toBeNull();
      expect(e.resultArtifact).toBeNull();
      expect(e.evidence).toBeUndefined();
    }
  });

  it("exhaustive tier includes every round and every evidence ref", async () => {
    const r = await app.request("/api/v1/packets/build", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ executionIds, tier: "exhaustive" }),
    });
    const body = (await r.json()) as {
      packet: {
        tier: string;
        executions: Array<{
          rounds?: Array<{ roundIndex: number }>;
          evidence?: Array<{ kind: string }>;
        }>;
      };
    };
    expect(body.packet.tier).toBe("exhaustive");
    for (const e of body.packet.executions) {
      expect(e.rounds && e.rounds.length).toBeGreaterThanOrEqual(1);
      expect(e.evidence && e.evidence.length).toBeGreaterThanOrEqual(1);
    }
  });

  it("markdown format returns text/markdown with the expected sections", async () => {
    const r = await app.request("/api/v1/packets/build", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ executionIds, format: "markdown" }),
    });
    expect(r.headers.get("content-type") ?? "").toMatch(/text\/markdown/);
    const text = await r.text();
    expect(text).toContain("# MCP Inspector X Investigation Packet");
    expect(text).toContain("## Redactions");
    expect(text).toContain("## Missing evidence");
    expect(text).toContain("source-revision");
    expect(text).toContain("trace-context");
  });

  it("rejects an unknown execution id with 404", async () => {
    const r = await app.request("/api/v1/packets/build", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ executionIds: ["not-a-real-id"] }),
    });
    expect(r.status).toBe(404);
  });

  it("rejects an empty executionIds array with 400", async () => {
    const r = await app.request("/api/v1/packets/build", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ executionIds: [] }),
    });
    expect(r.status).toBe(400);
  });

  it("bounded default: > 50 executions in one packet is a 400", async () => {
    const r = await app.request("/api/v1/packets/build", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ executionIds: Array(51).fill("x") }),
    });
    expect(r.status).toBe(400);
  });

  // Pure builder covers redaction (sensitive-key policy from the investigation package).
  it("redacts sensitive arguments before export", () => {
    // Seed an execution with an authorization key in its arguments so we can
    // verify the redaction propagates through the packet builder.
    const executionRow = storage.executions.create({
      serverId: "demo",
      capabilityId: "demo::tool::add_numbers",
    });
    storage.rounds.append({
      executionId: executionRow.id,
      roundIndex: 0,
      kind: "initial",
      argumentsJson: JSON.stringify({ a: 1, authorization: "Bearer super-secret" }),
      resultInlineJson: null,
      resultArtifact: null,
      errorJson: null,
      durationMs: 1,
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
    });
    storage.executions.updateStatus(executionRow.id, "complete", new Date().toISOString());

    const packet = buildPacket({
      storage,
      executionIds: [executionRow.id],
      tier: "investigation",
    });
    if ("error" in packet) throw new Error(packet.error);
    const args = packet.executions[0]!.argumentsJson as Record<string, unknown>;
    expect(args["authorization"]).toBe("[REDACTED]");
    expect(packet.redactions.some((r) => r.path.includes("authorization"))).toBe(true);

    // Rendered markdown must not contain the raw secret either.
    const md = renderPacketMarkdown(packet);
    expect(md.includes("super-secret")).toBe(false);
    expect(md).toContain("[REDACTED]");
  });
});
