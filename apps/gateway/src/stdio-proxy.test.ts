import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
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

// Proves ADR-0002's stdio-proxy end-to-end: an external agent spawns the
// PROXY (never the real MCP server directly). The proxy forwards stdio
// transparently to the real demo MCP child while T'ing every JSON-RPC
// message into a CaptureSession the gateway can read back. Mocked stdio
// would prove nothing here — this is the transparency proof, so every
// process in this file is real: a real proxy binary, a real demo MCP
// child, and a real external-agent-shaped client (@modelcontextprotocol/
// client's StdioClientTransport) that has no idea it isn't talking
// directly to the demo server.
const DEMO_STDIO_ENTRY = fileURLToPath(new URL("./demo-mcp-stdio.mjs", import.meta.url));
const STDIO_PROXY_ENTRY = fileURLToPath(
  new URL("../../../packages/runner/src/stdio-proxy.mjs", import.meta.url),
);

interface CapturedMessagesResponse {
  captureSession: { id: string; kind: string };
  messages: Array<{
    execution: { id: string; capabilityId: string; status: string };
    evidence: Array<{ kind: string; message: unknown }>;
  }>;
}

describe("stdio-proxy: transparent capture for external-agent MCP observation", () => {
  let runnerHandle: RunnerServerHandle;
  let runnerClient: RunnerClient;
  let storage: Storage;
  let serverManager: ServerManager;
  let secrets: SecretsRegistry;
  let app: ReturnType<typeof buildGatewayApp>;
  let dataDir: string;
  let runnerDir: string;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "mix-proxy-gateway-"));
    runnerDir = mkdtempSync(join(tmpdir(), "mix-proxy-runner-"));
    storage = openStorage({ dataDir });

    const token = generateAuthToken();
    runnerHandle = await startRunnerServer({
      socketPath: join(runnerDir, "runner.sock"),
      token,
    });
    runnerClient = await connectRunnerClient({ socketPath: runnerHandle.socketPath, token });

    const adapter = createSdkAdapter();
    secrets = createSecretsRegistry({ storage });
    serverManager = createServerManager({ storage, adapter, secrets, runnerClient });
    app = buildGatewayApp({ adapter, storage, serverManager, secrets, runnerClient });
  }, 15_000);

  afterAll(async () => {
    await runnerClient?.close().catch(() => {});
    await runnerHandle?.close().catch(() => {});
    storage?.close();
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
    if (runnerDir) rmSync(runnerDir, { recursive: true, force: true });
  });

  it("proxy -> demo MCP -> external client add_numbers(2,3) -> both directions land in the CaptureSession", async () => {
    const openRes = await app.request("/api/v1/capture-sessions/stdio-proxy/open", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ targetLabel: "demo-stdio-via-proxy" }),
    });
    expect(openRes.status).toBe(201);
    const openBody = (await openRes.json()) as {
      captureSession: { id: string; kind: string };
      socketPath: string;
    };
    expect(openBody.captureSession.kind).toBe("stdio-proxy");
    const captureSessionId = openBody.captureSession.id;

    // The external agent's-eye view: spawn the proxy binary as if it were
    // the MCP server. It has no idea the proxy exists, or that a capture
    // session is attached on the other end.
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [STDIO_PROXY_ENTRY, "--target", process.execPath, DEMO_STDIO_ENTRY, "--ingest", openBody.socketPath],
    });
    const client = new Client({ name: "synthetic-external-agent", version: "0.0.0" });
    await client.connect(transport);

    try {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name)).toContain("add_numbers");

      const result = (await client.callTool({
        name: "add_numbers",
        arguments: { a: 2, b: 3 },
      })) as { structuredContent?: { sum: number } };
      expect(result.structuredContent?.sum).toBe(5);
    } finally {
      await client.close();
    }

    // Give the ingest tap a beat to drain the last bytes through the
    // runner's UDS relay and land in storage.
    await waitFor(() => {
      const rows = storage.executions.listForCaptureSession(captureSessionId);
      return rows.some((r) => r.capabilityId === "tools/call");
    });

    const readRes = await app.request(
      `/api/v1/capture-sessions/${captureSessionId}/captured-messages`,
    );
    expect(readRes.status).toBe(200);
    const body = (await readRes.json()) as CapturedMessagesResponse;

    const callExec = body.messages.find((m) => m.execution.capabilityId === "tools/call");
    expect(callExec).toBeDefined();
    expect(callExec!.execution.status).toBe("complete");

    const requestEv = callExec!.evidence.find((e) => e.kind === "raw_request");
    const responseEv = callExec!.evidence.find((e) => e.kind === "raw_response");
    expect(requestEv).toBeDefined();
    expect(responseEv).toBeDefined();

    const requestMsg = requestEv!.message as { method: string; params: { name: string; arguments: { a: number; b: number } } };
    expect(requestMsg.method).toBe("tools/call");
    expect(requestMsg.params.name).toBe("add_numbers");
    expect(requestMsg.params.arguments).toEqual({ a: 2, b: 3 });

    const responseMsg = responseEv!.message as {
      result: { structuredContent: { sum: number } };
    };
    expect(responseMsg.result.structuredContent.sum).toBe(5);

    const closeRes = await app.request(`/api/v1/capture-sessions/${captureSessionId}/close`, {
      method: "POST",
    });
    expect(closeRes.status).toBe(200);
  }, 20_000);

  it("is byte-transparent: forwards stdin -> child stdout untouched, in order (no reordering)", async () => {
    // 'cat' is the simplest possible byte-transparency probe: whatever
    // goes in comes back out, unmodified, in the same order — proving the
    // proxy's pipe()-based forwarding never rewrites or reorders bytes
    // regardless of MCP framing.
    const proxy = spawn(process.execPath, [STDIO_PROXY_ENTRY, "--target", "cat"], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    const chunks: Buffer[] = [];
    proxy.stdout.on("data", (c: Buffer) => chunks.push(c));

    const inputs = ["first-chunk\n", "second-chunk\n", "third-chunk\n"];
    for (const input of inputs) {
      proxy.stdin.write(input);
    }
    proxy.stdin.end();

    await new Promise<void>((resolve) => proxy.once("close", () => resolve()));

    expect(Buffer.concat(chunks).toString("utf8")).toBe(inputs.join(""));
  }, 10_000);

  it("still forwards stdio when the ingest socket is unavailable, and logs a warning", async () => {
    const missingSocket = join(runnerDir, "does-not-exist.sock");
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [
        STDIO_PROXY_ENTRY,
        "--target",
        process.execPath,
        DEMO_STDIO_ENTRY,
        "--ingest",
        missingSocket,
      ],
      stderr: "pipe",
    });

    let stderrText = "";
    transport.stderr?.on("data", (c: Buffer) => {
      stderrText += c.toString("utf8");
    });

    const client = new Client({ name: "synthetic-external-agent", version: "0.0.0" });
    await client.connect(transport);
    try {
      const result = (await client.callTool({
        name: "add_numbers",
        arguments: { a: 10, b: 32 },
      })) as { structuredContent?: { sum: number } };
      expect(result.structuredContent?.sum).toBe(42);
    } finally {
      await client.close();
    }

    await waitFor(() => stderrText.includes("ingest socket unavailable"));
    expect(stderrText).toContain("ingest socket unavailable");
  }, 15_000);
});

async function waitFor(check: () => boolean, timeoutMs = 5_000): Promise<void> {
  const startedAt = Date.now();
  while (!check()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error("waitFor: condition never became true");
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
