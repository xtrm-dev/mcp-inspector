import { serve } from "@hono/node-server";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  createSdkAdapter,
  type ProtocolNegotiation,
} from "@mcp-inspector-x/protocol";
import { openStorage, type Storage } from "@mcp-inspector-x/storage";
import { startDemoMcp, type DemoMcp } from "./demo-mcp";
import { buildGatewayApp } from "./routes";
import { createServerManager } from "./servers";
import { createSecretsRegistry } from "./secrets";

function defaultDataDir(): string {
  return process.env["MIX_DATA_DIR"] ?? join(homedir(), ".mcp-inspector-x");
}

async function main(): Promise<void> {
  const storage: Storage = openStorage({ dataDir: defaultDataDir() });
  storage.events.append({ kind: "gateway.boot", payload: { pid: process.pid } });

  const demo: DemoMcp = await startDemoMcp();
  const adapter = createSdkAdapter();
  const secrets = createSecretsRegistry({ storage });
  const serverManager = createServerManager({ storage, adapter, secrets });

  // Seed the built-in demo server into the durable catalog (idempotent by id).
  const demoDefinition = storage.servers.upsertById({
    id: "demo",
    displayName: "Built-in demo",
    transport: "streamable-http",
    endpoint: demo.url,
    protocolPolicy: "modern",
  });

  let negotiation: ProtocolNegotiation | undefined;
  try {
    const binding = await serverManager.connect(demoDefinition);
    negotiation = binding.negotiation;
  } catch (err) {
    await demo.close();
    storage.close();
    throw err;
  }

  const app = buildGatewayApp({ adapter, storage, serverManager, secrets });
  const port = Number(process.env["PORT"] ?? 6275);
  const server = serve({ fetch: app.fetch, port }, (info) => {
    console.log(
      `MCP Inspector X gateway listening on http://127.0.0.1:${info.port}`,
    );
    if (negotiation) {
      console.log(
        `  demo MCP server at ${demo.url} (era=${negotiation.negotiatedEra} version=${negotiation.selectedVersion})`,
      );
    }
  });

  const shutdown = async () => {
    console.log("shutting down…");
    server.close();
    for (const b of serverManager.bindings()) {
      await adapter.disconnect(b.descriptor.id).catch(() => {});
    }
    await demo.close().catch(() => {});
    storage.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

void main().catch((err) => {
  console.error("gateway boot failed:", err);
  process.exit(1);
});
