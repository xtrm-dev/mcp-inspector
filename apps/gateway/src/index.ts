import { serve } from "@hono/node-server";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  createSdkAdapter,
  type McpServerDescriptor,
  type ProtocolNegotiation,
} from "@mcp-inspector-x/protocol";
import { openStorage, type Storage } from "@mcp-inspector-x/storage";
import { startDemoMcp, type DemoMcp } from "./demo-mcp";
import { buildGatewayApp, type ServerBinding } from "./routes";

function defaultDataDir(): string {
  return process.env["MIX_DATA_DIR"] ?? join(homedir(), ".mcp-inspector-x");
}

async function main(): Promise<void> {
  const storage: Storage = openStorage({ dataDir: defaultDataDir() });
  storage.events.append({ kind: "gateway.boot", payload: { pid: process.pid } });

  const demo: DemoMcp = await startDemoMcp();
  const adapter = createSdkAdapter();

  const descriptor: McpServerDescriptor = {
    id: "demo",
    displayName: "Built-in demo",
    transport: "streamable-http",
    url: demo.url,
    protocol: { policy: "modern" },
  };
  let negotiation: ProtocolNegotiation;
  try {
    negotiation = await adapter.connect(descriptor);
  } catch (err) {
    await demo.close();
    storage.close();
    throw err;
  }
  const servers: ServerBinding[] = [{ descriptor, negotiation }];

  // Seed the demo server into the durable catalog (idempotent by id).
  storage.servers.upsertById({
    id: descriptor.id,
    displayName: descriptor.displayName,
    transport: "streamable-http",
    endpoint: demo.url,
    protocolPolicy: "modern",
  });
  storage.events.append({
    kind: "server.connected",
    payload: {
      serverId: descriptor.id,
      negotiatedEra: negotiation.negotiatedEra,
      selectedVersion: negotiation.selectedVersion,
    },
  });

  const app = buildGatewayApp({ adapter, servers, storage });
  const port = Number(process.env["PORT"] ?? 6275);
  const server = serve({ fetch: app.fetch, port }, (info) => {
    console.log(
      `MCP Inspector X gateway listening on http://127.0.0.1:${info.port}`,
    );
    console.log(
      `  demo MCP server at ${demo.url} (era=${negotiation.negotiatedEra} version=${negotiation.selectedVersion})`,
    );
  });

  const shutdown = async () => {
    console.log("shutting down…");
    server.close();
    await adapter.disconnect(descriptor.id).catch(() => {});
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
