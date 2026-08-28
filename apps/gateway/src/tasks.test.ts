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

// R1 slice 1 (issue #60): the previous incarnation of this suite drove
// the fake-tool polling path — the demo `long_running_task` tool was
// re-invoked on each poll with `{ taskId, cancel }` inside its ordinary
// arguments, matching the historical simulation that never spoke the
// Tasks-extension wire. R1 slice 1 replaces that domain-layer path with
// real `tasks/get` / `tasks/cancel` methods (routes.ts + sdk-adapter.ts).
//
// This suite stays skipped until slice 2 (issue #60 follow-up):
//   - upgrade `demo-mcp.ts` so `long_running_task` returns a real
//     `resultType: "task"` envelope on first call, and
//   - wrap the demo HTTP server so raw `tasks/get` / `tasks/cancel`
//     methods are answered directly (SDK #2598 makes McpServer reject
//     those method names via its historical-name registry).
// Slice 2 will also unskip this describe block and add strict-server
// assertions on the exact wire methods + `Mcp-Name: <taskId>` header.
describe.skip("Tasks lifecycle persistence (long_running_task) — pending slice-2 demo upgrade", () => {
  let demo: DemoMcp;
  let adapter: ReturnType<typeof createSdkAdapter>;
  let app: ReturnType<typeof buildGatewayApp>;
  let storage: Storage;
  let serverManager: ServerManager;
  let secrets: SecretsRegistry;
  let dataDir: string;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "mix-gateway-tasks-"));
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

  async function startTask(): Promise<{ executionId: string; taskId: string }> {
    const r = await app.request("/api/v1/servers/demo/tools/long_running_task/call", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ arguments: {} }),
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      executionId: string;
      status: string;
      value: { taskId?: string; status?: string };
    };
    expect(body.status).toBe("task_working");
    expect(body.value.status).toBe("working");
    expect(typeof body.value.taskId).toBe("string");
    return { executionId: body.executionId, taskId: body.value.taskId as string };
  }

  it("task create + advertise: initial call returns task_working with a taskId, one round", async () => {
    const { executionId } = await startTask();
    const record = storage.executions.get(executionId);
    expect(record?.status).toBe("task_working");
    const rounds = storage.rounds.listForExecution(executionId);
    expect(rounds).toHaveLength(1);
    expect(rounds[0]?.kind).toBe("initial");
  });

  it("poll to completion: two polls complete the task under the SAME executionId", async () => {
    const { executionId } = await startTask();

    const poll1 = await app.request(`/api/v1/executions/${executionId}/rounds`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ taskAction: "poll" }),
    });
    expect(poll1.status).toBe(200);
    const poll1Body = (await poll1.json()) as { executionId: string; status: string };
    expect(poll1Body.executionId).toBe(executionId);
    expect(poll1Body.status).toBe("task_working");

    const poll2 = await app.request(`/api/v1/executions/${executionId}/rounds`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ taskAction: "poll" }),
    });
    expect(poll2.status).toBe(200);
    const poll2Body = (await poll2.json()) as {
      executionId: string;
      status: string;
      value: { status?: string; result?: number };
    };
    expect(poll2Body.executionId).toBe(executionId);
    expect(poll2Body.status).toBe("complete");
    expect(poll2Body.value.status).toBe("completed");
    expect(poll2Body.value.result).toBe(42);

    const record = storage.executions.get(executionId);
    expect(record?.status).toBe("complete");
    const rounds = storage.rounds.listForExecution(executionId);
    expect(rounds).toHaveLength(3);
    expect(rounds.map((r) => r.kind)).toEqual(["initial", "task_update", "task_update"]);
    expect(new Set(rounds.map((r) => r.executionId))).toEqual(new Set([executionId]));
  });

  it("cancel mid-run: cancelling before completion marks the execution cancelled", async () => {
    const { executionId } = await startTask();

    const cancel = await app.request(`/api/v1/executions/${executionId}/rounds`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ taskAction: "cancel" }),
    });
    expect(cancel.status).toBe(200);
    const body = (await cancel.json()) as {
      status: string;
      value: { status?: string };
    };
    expect(body.status).toBe("cancelled");
    expect(body.value.status).toBe("cancelled");

    const record = storage.executions.get(executionId);
    expect(record?.status).toBe("cancelled");
    const rounds = storage.rounds.listForExecution(executionId);
    expect(rounds).toHaveLength(2);
    expect(rounds[1]?.kind).toBe("task_update");
  });

  it("resume shape is state-checked: a task_working execution rejects inputResponses, and an input_required execution rejects taskAction", async () => {
    const { executionId: taskExecId } = await startTask();
    const wrongForTask = await app.request(`/api/v1/executions/${taskExecId}/rounds`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ inputResponses: { name: "world" } }),
    });
    expect(wrongForTask.status).toBe(400);

    const greet = (await (
      await app.request("/api/v1/servers/demo/tools/interactive_greet/call", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ arguments: {} }),
      })
    ).json()) as { executionId: string; status: string };
    expect(greet.status).toBe("input_required");

    const wrongForMrtr = await app.request(`/api/v1/executions/${greet.executionId}/rounds`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ taskAction: "poll" }),
    });
    expect(wrongForMrtr.status).toBe(400);
  });
});
