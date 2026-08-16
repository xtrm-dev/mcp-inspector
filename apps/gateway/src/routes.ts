import { Hono } from "hono";
import { cors } from "hono/cors";
import {
  MODERN_PROTOCOL_VERSION,
  type McpClientAdapter,
  type McpServerDescriptor,
  type ProtocolNegotiation,
} from "@mcp-inspector-x/protocol";

export interface ServerBinding {
  descriptor: McpServerDescriptor;
  negotiation: ProtocolNegotiation;
}

export interface GatewayDeps {
  adapter: McpClientAdapter;
  servers: ServerBinding[];
}

/**
 * Build the Hono app. Split from index.ts so routes can be exercised in
 * unit tests without spinning a real Node HTTP listener.
 */
export function buildGatewayApp(deps: GatewayDeps): Hono {
  const app = new Hono();

  // Web dev origin (:5174) and same-origin production. Adjust when adding a
  // hosted deploy; the current UI is dev-only.
  app.use("*", cors({ origin: (o) => o ?? "*" }));

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
        liveMcpTransport: deps.servers.length > 0,
        multiToolWorkspace: true,
        investigationPackets: true,
        sourceIntelligence: false,
      },
    }),
  );

  app.get("/api/servers", (c) =>
    c.json({
      servers: deps.servers.map((s) => ({
        id: s.descriptor.id,
        displayName: s.descriptor.displayName,
        transport: s.descriptor.transport,
        negotiation: s.negotiation,
      })),
    }),
  );

  app.get("/api/servers/:id/tools", async (c) => {
    const id = c.req.param("id");
    if (!deps.servers.some((s) => s.descriptor.id === id)) {
      return c.json({ error: `unknown server '${id}'` }, 404);
    }
    try {
      const tools = await deps.adapter.listTools(id);
      return c.json({ tools });
    } catch (err) {
      return c.json({ error: errMsg(err) }, 502);
    }
  });

  app.post("/api/servers/:id/tools/:name/call", async (c) => {
    const id = c.req.param("id");
    const name = c.req.param("name");
    if (!deps.servers.some((s) => s.descriptor.id === id)) {
      return c.json({ error: `unknown server '${id}'` }, 404);
    }
    let args: Record<string, unknown> = {};
    try {
      const body = await c.req.json().catch(() => ({}));
      if (body && typeof body === "object" && !Array.isArray(body)) {
        const bodyArgs = (body as { arguments?: unknown }).arguments;
        if (bodyArgs && typeof bodyArgs === "object" && !Array.isArray(bodyArgs)) {
          args = bodyArgs as Record<string, unknown>;
        }
      }
    } catch {
      // fallthrough — treat as empty args
    }
    try {
      const { value, evidence } = await deps.adapter.callTool({
        serverId: id,
        name,
        arguments: args as Parameters<McpClientAdapter["callTool"]>[0]["arguments"],
      });
      return c.json({ value, evidence });
    } catch (err) {
      return c.json({ error: errMsg(err) }, 502);
    }
  });

  return app;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
