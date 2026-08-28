import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSdkAdapter } from "@mcp-inspector-x/protocol";
import { openStorage, type Storage } from "@mcp-inspector-x/storage";
import {
  getForbiddenTaskMethodsReceived,
  getTaskMethodsReceived,
  resetTaskMethodReceipts,
  startDemoMcp,
  type DemoMcp,
} from "./demo-mcp";
import { buildGatewayApp } from "./routes";
import { createServerManager, type ServerManager } from "./servers";
import { createSecretsRegistry, type SecretsRegistry } from "./secrets";

// R1 slice 2 (issue #60): the demo HTTP server now intercepts the
// Tasks-extension raw wire — `tasks/get` / `tasks/update` / `tasks/cancel`
// are answered directly by the wrap (McpServer refuses those method names
// under SDK #2598), and every received request is recorded so this suite
// can assert strict-server behavior: exact wire methods, taskId params,
// and that historical `tasks/list` / `tasks/result` are NEVER emitted by
// the seam. The seam under test lives at
// `packages/protocol/src/sdk-adapter.ts` (getTask / updateTask / cancelTask)
// and `apps/gateway/src/routes.ts` (task_working continuation branch).
describe("Tasks lifecycle persistence (long_running_task)", () => {
  let demo: DemoMcp;
  let adapter: ReturnType<typeof createSdkAdapter>;
  let app: ReturnType<typeof buildGatewayApp>;
  let storage: Storage;
  let serverManager: ServerManager;
  let secrets: SecretsRegistry;
  let dataDir: string;

  beforeAll(async () => {
    resetTaskMethodReceipts();
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

  // R1 slice 2: strict-server wire assertion. Verifies that the seam
  // actually spoke the Tasks-extension methods against the server, and
  // that the historical methods forbidden by the extension were never
  // emitted under any code path exercised above.
  it("strict-server: only tasks/get and tasks/cancel reached the wire; tasks/list and tasks/result never did", () => {
    const received = getTaskMethodsReceived();
    const methods = received.map((r) => r.method);
    // At minimum, the two poll+complete flow and the cancel flow contributed
    // one tasks/get and one tasks/cancel.
    expect(methods).toContain("tasks/get");
    expect(methods).toContain("tasks/cancel");
    // Every received Task method carried a taskId param.
    for (const r of received) {
      expect(typeof r.taskId).toBe("string");
      expect(r.taskId!.length).toBeGreaterThan(0);
    }
    // Historical methods must NEVER have been sent by the seam.
    expect(getForbiddenTaskMethodsReceived()).toHaveLength(0);
  });
});
