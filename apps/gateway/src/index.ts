import { serve } from "@hono/node-server";
import {
  createSdkAdapter,
  type McpServerDescriptor,
  type ProtocolNegotiation,
} from "@mcp-inspector-x/protocol";
import { startDemoMcp, type DemoMcp } from "./demo-mcp";
import { buildGatewayApp, type ServerBinding } from "./routes";

async function main(): Promise<void> {
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
    throw err;
  }
  const servers: ServerBinding[] = [{ descriptor, negotiation }];

  const app = buildGatewayApp({ adapter, servers });
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
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

void main().catch((err) => {
  console.error("gateway boot failed:", err);
  process.exit(1);
});
