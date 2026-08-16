import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { MODERN_PROTOCOL_VERSION } from "@mcp-inspector-x/protocol";

const app = new Hono();

app.get("/health", (c) =>
  c.json({
    status: "ok",
    service: "mcp-inspector-x-gateway",
    protocolTarget: MODERN_PROTOCOL_VERSION,
  }),
);

app.get("/api/config", (c) =>
  c.json({
    product: "MCP Inspector X",
    protocolTarget: MODERN_PROTOCOL_VERSION,
    capabilities: {
      liveMcpTransport: false,
      multiToolWorkspace: true,
      investigationPackets: true,
      sourceIntelligence: false,
    },
  }),
);

const port = Number(process.env.PORT ?? 6275);

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`MCP Inspector X gateway listening on http://127.0.0.1:${info.port}`);
});
