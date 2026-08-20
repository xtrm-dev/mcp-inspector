import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  startRunnerServer,
  generateAuthToken,
  connectRunnerClient,
  type RunnerServerHandle,
  type RunnerClient,
} from "@mcp-inspector-x/runner";
import { createSdkAdapter } from "@mcp-inspector-x/protocol";
import { openStorage, type Storage } from "@mcp-inspector-x/storage";
import { buildGatewayApp } from "./routes";
import { createServerManager, type ServerManager } from "./servers";
import { createSecretsRegistry, type SecretsRegistry } from "./secrets";

// Proves the whole chain end-to-end: the gateway never calls
// child_process.spawn (ADR-0003) — it asks the privileged runner to spawn
// the demo MCP over stdio, then speaks MCP JSON-RPC over the UDS the
// runner hands back.
const DEMO_STDIO_ENTRY = fileURLToPath(new URL("./demo-mcp-stdio.mjs", import.meta.url));

describe("MCP-over-stdio via the privileged runner (end-to-end)", () => {
  let runnerHandle: RunnerServerHandle;
  let runnerClient: RunnerClient;
  let adapter: ReturnType<typeof createSdkAdapter>;
  let app: ReturnType<typeof buildGatewayApp>;
  let storage: Storage;
  let serverManager: ServerManager;
  let secrets: SecretsRegistry;
  let dataDir: string;
  let runnerDir: string;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "mix-stdio-gateway-"));
    runnerDir = mkdtempSync(join(tmpdir(), "mix-stdio-runner-"));
    storage = openStorage({ dataDir });

    const token = generateAuthToken();
    runnerHandle = await startRunnerServer({
      socketPath: join(runnerDir, "runner.sock"),
      token,
    });
    runnerClient = await connectRunnerClient({ socketPath: runnerHandle.socketPath, token });

    adapter = createSdkAdapter();
    secrets = createSecretsRegistry({ storage });
    serverManager = createServerManager({ storage, adapter, secrets, runnerClient });
    app = buildGatewayApp({ adapter, storage, serverManager, secrets });
  }, 15_000);

  afterAll(async () => {
    for (const b of serverManager?.bindings() ?? []) {
      await serverManager.disconnect(b.descriptor.id).catch(() => {});
    }
    await runnerClient?.close().catch(() => {});
    await runnerHandle?.close().catch(() => {});
    storage?.close();
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
    if (runnerDir) rmSync(runnerDir, { recursive: true, force: true });
  });

  it("connect -> list tools -> call add_numbers(2,3) -> 5 -> disconnect leaves no child/socket", async () => {
    const def = storage.servers.upsertById({
      id: "demo-stdio",
      displayName: "Demo (stdio)",
      transport: "stdio",
      command: "node",
      args: [DEMO_STDIO_ENTRY],
      protocolPolicy: "auto",
    });

    const connectRes = await app.request(`/api/v1/servers/${def.id}/connect`, { method: "POST" });
    expect(connectRes.status).toBe(200);
    const connectBody = (await connectRes.json()) as { connected: boolean };
    expect(connectBody.connected).toBe(true);

    const binding = serverManager.getBinding(def.id);
    expect(binding?.runnerSessionId).toBeDefined();
    const pumpSocketPath = binding!.descriptor.socketPath!;
    expect(existsSync(pumpSocketPath)).toBe(true);

    const toolsRes = await app.request(`/api/v1/servers/${def.id}/tools`);
    expect(toolsRes.status).toBe(200);
    const toolsBody = (await toolsRes.json()) as { tools: Array<{ name: string }> };
    expect(toolsBody.tools.map((t) => t.name)).toContain("add_numbers");

    const callRes = await app.request(`/api/v1/servers/${def.id}/tools/add_numbers/call`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ arguments: { a: 2, b: 3 } }),
    });
    expect(callRes.status).toBe(200);
    const callBody = (await callRes.json()) as { value: { sum: number } };
    expect(callBody.value.sum).toBe(5);

    const disconnectRes = await app.request(`/api/v1/servers/${def.id}/disconnect`, {
      method: "POST",
    });
    expect(disconnectRes.status).toBe(200);
    expect(serverManager.getBinding(def.id)).toBeUndefined();

    // The pump socket is unlinked once closeStdioMcp tears the session
    // down — the strongest externally-observable proof the child is dead.
    expect(existsSync(pumpSocketPath)).toBe(false);
  }, 15_000);
});
