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

describe("trace <-> AgentRun / Execution correlation + timeline (Phase L slice 2)", () => {
  let demo: DemoMcp;
  let adapter: ReturnType<typeof createSdkAdapter>;
  let app: ReturnType<typeof buildGatewayApp>;
  let storage: Storage;
  let serverManager: ServerManager;
  let secrets: SecretsRegistry;
  let dataDir: string;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "mix-trace-correlation-"));
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

  it("ingest with source.executionId auto-links, GET /executions/:id/traces returns it", async () => {
    const execution = storage.executions.create({ serverId: "demo", capabilityId: "demo::tool::add_numbers" });
    const spans = [{ spanId: "s1", name: "root", startTimeUnixNano: "1000000" }];

    const post = await app.request("/api/v1/traces", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ traceId: "trace-exec-1", spans, source: { executionId: execution.id } }),
    });
    expect(post.status).toBe(201);

    const r = await app.request(`/api/v1/executions/${execution.id}/traces`);
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      traces: Array<{ trace: { traceId: string }; correlationKind: string; confidence: number }>;
      _note?: string;
    };
    expect(body._note).toBeUndefined();
    expect(body.traces).toHaveLength(1);
    expect(body.traces[0]?.trace.traceId).toBe("trace-exec-1");
    expect(body.traces[0]?.correlationKind).toBe("w3c-trace");
    expect(body.traces[0]?.confidence).toBe(1.0);
  });

  it("GET /executions/:id/traces returns empty + _note when nothing correlated", async () => {
    const execution = storage.executions.create({ serverId: "demo", capabilityId: "demo::tool::add_numbers" });
    const r = await app.request(`/api/v1/executions/${execution.id}/traces`);
    expect(r.status).toBe(200);
    const body = (await r.json()) as { traces: unknown[]; _note?: string };
    expect(body.traces).toHaveLength(0);
    expect(body._note).toBe("no correlated traces found for this execution");
  });

  it("ingest with source.agentRunId auto-links, GET /agent-runs/:id/timeline overlays executions + spans in time order", async () => {
    const captureSession = storage.captureSessions.create({ kind: "trace-ingest" });
    const agentRun = storage.agentRuns.create({
      captureSessionId: captureSession.id,
      correlationKind: "w3c-trace",
    });
    const exec1 = storage.executions.create({
      serverId: "demo",
      capabilityId: "demo::tool::add_numbers",
      agentRunId: agentRun.id,
    });

    // Span timestamps are OTLP-style nanosecond epoch strings; pick one well
    // before "now" so it sorts ahead of the execution in the overlay.
    const earlyNanos = String(BigInt(Date.now() - 60_000) * 1_000_000n);
    const spans = [{ spanId: "s1", name: "upstream-call", startTimeUnixNano: earlyNanos }];

    const post = await app.request("/api/v1/traces", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ traceId: "trace-run-1", spans, source: { agentRunId: agentRun.id } }),
    });
    expect(post.status).toBe(201);

    const r = await app.request(`/api/v1/agent-runs/${agentRun.id}/timeline`);
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      executions: Array<{ id: string }>;
      traces: Array<{ trace: { traceId: string }; spans: unknown[] }>;
      overlay: Array<{ at: string; kind: string; ref: { id: string } }>;
      _note?: string;
    };
    expect(body._note).toBeUndefined();
    expect(body.executions.map((e) => e.id)).toContain(exec1.id);
    expect(body.traces).toHaveLength(1);
    expect(body.traces[0]?.trace.traceId).toBe("trace-run-1");
    expect(body.traces[0]?.spans).toHaveLength(1);

    const spanEntry = body.overlay.find((o) => o.kind === "span" && o.ref.id === "s1");
    const execEntry = body.overlay.find((o) => o.kind === "execution" && o.ref.id === exec1.id);
    expect(spanEntry).toBeDefined();
    expect(execEntry).toBeDefined();
    // Overlay is time-ordered: the span timestamp is ~60s before "now",
    // well before the execution's own startedAt.
    expect(spanEntry!.at < execEntry!.at).toBe(true);
    const idx = body.overlay.map((o) => o.ref.id);
    expect(idx.indexOf("s1")).toBeLessThan(idx.indexOf(exec1.id));
  });

  it("GET /agent-runs/:id/timeline returns empty traces + _note when nothing correlated", async () => {
    const captureSession = storage.captureSessions.create({ kind: "trace-ingest" });
    const agentRun = storage.agentRuns.create({
      captureSessionId: captureSession.id,
      correlationKind: "w3c-trace",
    });
    const r = await app.request(`/api/v1/agent-runs/${agentRun.id}/timeline`);
    expect(r.status).toBe(200);
    const body = (await r.json()) as { traces: unknown[]; overlay: unknown[]; _note?: string };
    expect(body.traces).toHaveLength(0);
    expect(body._note).toBe("no correlated traces found for this agent_run");
  });

  it("traceparent header on a tool call stashes traceId on Execution metadata; a later trace ingest links it", async () => {
    const traceId = "4bf92f3577b34da6a3ce929d0e0e4736";
    const traceparent = `00-${traceId}-00f067aa0ba902b7-01`;

    const call = await app.request("/api/v1/servers/demo/tools/add_numbers/call", {
      method: "POST",
      headers: { "content-type": "application/json", traceparent },
      body: JSON.stringify({ arguments: { a: 1, b: 2 } }),
    });
    expect(call.status).toBe(200);
    const callBody = (await call.json()) as { executionId: string };

    const execBefore = await app.request(`/api/v1/executions/${callBody.executionId}`);
    const execBeforeBody = (await execBefore.json()) as { execution: { metadata: unknown } };
    expect(execBeforeBody.execution.metadata).toEqual({ traceId });

    // No source.executionId given — this exercises the late-link path via
    // the traceId stashed on the Execution at creation time.
    const post = await app.request("/api/v1/traces", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ traceId, spans: [{ spanId: "s1" }] }),
    });
    expect(post.status).toBe(201);

    const r = await app.request(`/api/v1/executions/${callBody.executionId}/traces`);
    const body = (await r.json()) as { traces: Array<{ trace: { traceId: string } }> };
    expect(body.traces).toHaveLength(1);
    expect(body.traces[0]?.trace.traceId).toBe(traceId);
  }, 15_000);

  it("malformed traceparent is silently ignored: 200 + no traceId stashed", async () => {
    const call = await app.request("/api/v1/servers/demo/tools/add_numbers/call", {
      method: "POST",
      headers: { "content-type": "application/json", traceparent: "not-a-real-traceparent" },
      body: JSON.stringify({ arguments: { a: 3, b: 4 } }),
    });
    expect(call.status).toBe(200);
    const callBody = (await call.json()) as { executionId: string };

    const r = await app.request(`/api/v1/executions/${callBody.executionId}`);
    const body = (await r.json()) as { execution: { metadata: unknown } };
    expect(body.execution.metadata).toBeNull();
  }, 15_000);
});
