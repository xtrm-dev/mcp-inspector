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

describe("Phase E slice 2B: cancel + retry + resource/prompt dispatch", () => {
  let demo: DemoMcp;
  let adapter: ReturnType<typeof createSdkAdapter>;
  let app: ReturnType<typeof buildGatewayApp>;
  let storage: Storage;
  let serverManager: ServerManager;
  let secrets: SecretsRegistry;
  let dataDir: string;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "mix-cancel-retry-"));
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
  }, 20_000);

  afterAll(async () => {
    for (const b of serverManager?.bindings() ?? []) {
      await adapter?.disconnect(b.descriptor.id).catch(() => {});
    }
    await demo?.close();
    storage?.close();
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
  });

  it("cancel: aborts an in-flight slow_echo call, records cancelled status + round provenance", async () => {
    const callPromise = app.request("/api/v1/servers/demo/tools/slow_echo/call", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ arguments: { value: 42, delayMs: 5_000 } }),
    });

    // Give the call time to create its Execution row and reach the adapter
    // before we cancel it — well under the 5s server-side delay.
    await new Promise((r) => setTimeout(r, 200));

    const rows = storage.executions.listForCapability("demo::tool::slow_echo", { limit: 1 });
    const executionId = rows[0]?.id;
    expect(executionId).toBeTruthy();

    const cancelResp = await app.request(`/api/v1/executions/${executionId}/cancel`, {
      method: "POST",
    });
    expect(cancelResp.status).toBe(200);
    const cancelBody = (await cancelResp.json()) as { executionId: string; cancelling: boolean };
    expect(cancelBody.cancelling).toBe(true);

    // The abort should reject the in-flight call promise well before the
    // server-side 5s delay elapses.
    const callResp = await callPromise;
    expect(callResp.status).toBe(502);
    const callBody = (await callResp.json()) as { executionId: string; error?: string };
    expect(callBody.error).toContain("cancelled");

    const record = storage.executions.get(executionId!);
    expect(record?.status).toBe("cancelled");

    const rounds = storage.rounds.listForExecution(executionId!);
    expect(rounds).toHaveLength(1);
    const provenance = JSON.parse(rounds[0]!.errorJson!) as { cancelled: boolean; cancelledBy: string };
    expect(provenance.cancelled).toBe(true);
    expect(provenance.cancelledBy).toBe("user");
  }, 15_000);

  it("cancel: unknown execution → 404; not-in-flight execution → 409", async () => {
    const missing = await app.request("/api/v1/executions/does-not-exist/cancel", { method: "POST" });
    expect(missing.status).toBe(404);

    // A completed call is no longer in flight.
    const done = (await (
      await app.request("/api/v1/servers/demo/tools/add_numbers/call", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ arguments: { a: 1, b: 2 } }),
      })
    ).json()) as { executionId: string };
    const r = await app.request(`/api/v1/executions/${done.executionId}/cancel`, { method: "POST" });
    expect(r.status).toBe(409);
  });

  it("retry: a failed execution (server disconnected) retried after reconnect succeeds with identical arguments", async () => {
    // Kill the SDK session directly (not via serverManager.disconnect) so
    // the route's serverManager.getBinding() pre-flight check still passes
    // and the failure actually happens inside executeTool/adapter.callTool —
    // exercising the same failure path a real transient disconnect would.
    const binding = serverManager.getBinding("demo")!;
    await adapter.disconnect("demo");

    const failResp = await app.request("/api/v1/servers/demo/tools/add_numbers/call", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ arguments: { a: 11, b: 31 } }),
    });
    expect(failResp.status).toBe(502);
    const failBody = (await failResp.json()) as { executionId: string };
    const failedRecord = storage.executions.get(failBody.executionId);
    expect(failedRecord?.status).toBe("failed");

    await adapter.connect(binding.descriptor);

    const retryResp = await app.request(`/api/v1/executions/${failBody.executionId}/retry`, {
      method: "POST",
    });
    expect(retryResp.status).toBe(200);
    const retryBody = (await retryResp.json()) as {
      executionId: string;
      retriedFrom: string;
      ok: boolean;
      value: unknown;
    };
    expect(retryBody.ok).toBe(true);
    expect(retryBody.executionId).not.toBe(failBody.executionId);
    expect(retryBody.retriedFrom).toBe(failBody.executionId);
    expect(retryBody.value).toEqual({ sum: 42 });

    // New Execution row, distinct from the source, linked via metadata.
    const retried = storage.executions.get(retryBody.executionId);
    expect(retried?.status).toBe("complete");
    expect(retried?.metadata).toEqual({ retriedFrom: failBody.executionId });

    // Identical arguments carried over from the source's last round.
    const sourceRounds = storage.rounds.listForExecution(failBody.executionId);
    const retriedRounds = storage.rounds.listForExecution(retryBody.executionId);
    expect(retriedRounds[0]!.argumentsJson).toBe(sourceRounds[0]!.argumentsJson);

    // Retry does not touch the source Execution's own history.
    expect(storage.executions.get(failBody.executionId)?.status).toBe("failed");
    expect(storage.rounds.listForExecution(failBody.executionId)).toHaveLength(1);
  }, 15_000);

  it("retry: unknown execution → 404", async () => {
    const r = await app.request("/api/v1/executions/does-not-exist/retry", { method: "POST" });
    expect(r.status).toBe(404);
  });

  it("runWorkspace dispatches a resource node and records the read as evidence", async () => {
    const w = (await (
      await app.request("/api/v1/workspaces", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "resource-dispatch" }),
      })
    ).json()) as { workspace: { id: string } };

    const node = (await (
      await app.request(`/api/v1/workspaces/${w.workspace.id}/nodes`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          serverId: "demo",
          capabilityId: "demo::resource::mix://demo/readme",
        }),
      })
    ).json()) as { node: { id: string } };

    const runResp = await app.request(`/api/v1/workspaces/${w.workspace.id}/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(runResp.status).toBe(200);
    const runBody = (await runResp.json()) as {
      nodes: Array<{ nodeId: string; ok: boolean; executionId?: string; skippedReason?: string }>;
    };
    const result = runBody.nodes.find((n) => n.nodeId === node.node.id);
    expect(result?.skippedReason).toBeUndefined();
    expect(result?.ok).toBe(true);
    expect(result?.executionId).toBeTruthy();

    const evidence = storage.evidence.listForExecution(result!.executionId!);
    expect(evidence).toHaveLength(1);
    expect(evidence[0]!.kind).toBe("raw_response");

    const record = storage.executions.get(result!.executionId!);
    expect(record?.capabilityId).toBe("demo::resource::mix://demo/readme");
    expect(record?.status).toBe("complete");
  }, 15_000);

  it("runWorkspace dispatches a prompt node and records the prompt-get as evidence", async () => {
    const w = (await (
      await app.request("/api/v1/workspaces", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "prompt-dispatch" }),
      })
    ).json()) as { workspace: { id: string } };

    const node = (await (
      await app.request(`/api/v1/workspaces/${w.workspace.id}/nodes`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          serverId: "demo",
          capabilityId: "demo::prompt::greeting",
          argumentsJson: JSON.stringify({ name: "world" }),
        }),
      })
    ).json()) as { node: { id: string } };

    const runResp = await app.request(`/api/v1/workspaces/${w.workspace.id}/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(runResp.status).toBe(200);
    const runBody = (await runResp.json()) as {
      nodes: Array<{ nodeId: string; ok: boolean; executionId?: string; skippedReason?: string }>;
    };
    const result = runBody.nodes.find((n) => n.nodeId === node.node.id);
    expect(result?.skippedReason).toBeUndefined();
    expect(result?.ok).toBe(true);
    expect(result?.executionId).toBeTruthy();

    const evidence = storage.evidence.listForExecution(result!.executionId!);
    expect(evidence).toHaveLength(1);
    expect(evidence[0]!.kind).toBe("raw_response");

    const rounds = storage.rounds.listForExecution(result!.executionId!);
    expect(rounds).toHaveLength(1);
    const resultJson = JSON.parse(rounds[0]!.resultInlineJson!) as { messages: unknown[] };
    expect(resultJson.messages.length).toBeGreaterThan(0);
  }, 15_000);
});
