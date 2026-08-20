import { Hono } from "hono";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";
import {
  MODERN_PROTOCOL_VERSION,
  type McpClientAdapter,
  type McpServerDescriptor,
  type ProtocolNegotiation,
} from "@mcp-inspector-x/protocol";
import type { Storage, EventRow } from "@mcp-inspector-x/storage";

export interface ServerBinding {
  descriptor: McpServerDescriptor;
  negotiation: ProtocolNegotiation;
}

export interface GatewayDeps {
  adapter: McpClientAdapter;
  servers: ServerBinding[];
  storage: Storage;
}

/**
 * Build the Hono app. Split from index.ts so routes can be exercised in
 * unit tests without spinning a real Node HTTP listener.
 */
export function buildGatewayApp(deps: GatewayDeps): Hono {
  const app = new Hono();

  app.use("*", cors({ origin: (o) => o ?? "*" }));

  // ---- Legacy routes (kept for one PR while UI (#17) transitions to /api/v1) ----

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

  // ---- /api/v1/* — versioned surface backed by durable storage ----

  app.get("/api/v1/health", (c) =>
    c.json({
      status: "ok",
      service: "mcp-inspector-x-gateway",
      apiVersion: "v1",
      protocolTarget: MODERN_PROTOCOL_VERSION,
    }),
  );

  app.get("/api/v1/servers", (c) => {
    const rows = deps.storage.servers.list();
    return c.json({
      servers: rows.map((s) => ({
        id: s.id,
        displayName: s.displayName,
        transport: s.transport,
        endpoint: s.endpoint,
        protocolPolicy: s.protocolPolicy,
        disabled: s.disabled,
        createdAt: s.createdAt,
        updatedAt: s.updatedAt,
      })),
    });
  });

  // Resumable SSE stream of execution/evidence/lifecycle events.
  // Reconnecting clients pass Last-Event-ID (the last-seen seq); the server
  // replays any rows > sinceSeq from the durable log, then attaches to live.
  app.get("/api/v1/events", (c) => {
    const lastIdHeader = c.req.header("last-event-id");
    const sinceQuery = c.req.query("since");
    const sinceSeq = parseSince(lastIdHeader ?? sinceQuery);

    return streamSSE(c, async (stream) => {
      const backlog = deps.storage.events.read({ sinceSeq });
      for (const row of backlog) {
        await sendEvent(stream, row);
      }
      let latestSeq = backlog.length > 0 ? backlog[backlog.length - 1]!.seq : sinceSeq;

      const pending: EventRow[] = [];
      const sub = deps.storage.events.subscribe((row) => {
        if (row.seq <= latestSeq) return;
        pending.push(row);
      });

      try {
        while (!stream.aborted && !stream.closed) {
          while (pending.length > 0) {
            const row = pending.shift()!;
            if (row.seq <= latestSeq) continue;
            await sendEvent(stream, row);
            latestSeq = row.seq;
          }
          // Coarse-grained tick keeps back-pressure honest. Fine enough for a
          // control-plane event stream; not a data path.
          await stream.sleep(250);
        }
      } finally {
        sub.close();
      }
    });
  });

  return app;
}

async function sendEvent(
  stream: { writeSSE: (msg: { id?: string; event?: string; data: string }) => Promise<void> },
  row: EventRow,
): Promise<void> {
  await stream.writeSSE({
    id: String(row.seq),
    event: row.kind,
    data: JSON.stringify({
      seq: row.seq,
      kind: row.kind,
      executionId: row.executionId,
      recordedAt: row.recordedAt,
      payload: row.payload,
    }),
  });
}

function parseSince(value: string | undefined): number {
  if (!value) return 0;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
