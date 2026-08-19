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

  // ---- Unversioned status ----

  app.get("/health", (c) =>
    c.json({
      status: "ok",
      service: "mcp-inspector-x-gateway",
      protocolTarget: MODERN_PROTOCOL_VERSION,
    }),
  );

  // ---- /api/v1/* — versioned surface backed by durable storage ----

  app.get("/api/v1/health", (c) =>
    c.json({
      status: "ok",
      service: "mcp-inspector-x-gateway",
      apiVersion: "v1",
      protocolTarget: MODERN_PROTOCOL_VERSION,
    }),
  );

  app.get("/api/v1/config", (c) =>
    c.json({
      product: "MCP Inspector X",
      apiVersion: "v1",
      protocolTarget: MODERN_PROTOCOL_VERSION,
      capabilities: {
        liveMcpTransport: deps.servers.length > 0,
        multiToolWorkspace: true,
        investigationPackets: true,
        sourceIntelligence: false,
        durableExecutionLog: true,
        resumableSse: true,
      },
    }),
  );

  app.get("/api/v1/servers", (c) => {
    const rows = deps.storage.servers.list();
    const bindingsById = new Map(deps.servers.map((b) => [b.descriptor.id, b]));
    return c.json({
      servers: rows.map((s) => {
        const binding = bindingsById.get(s.id);
        return {
          id: s.id,
          displayName: s.displayName,
          transport: s.transport,
          endpoint: s.endpoint,
          protocolPolicy: s.protocolPolicy,
          disabled: s.disabled,
          createdAt: s.createdAt,
          updatedAt: s.updatedAt,
          negotiation: binding?.negotiation ?? null,
        };
      }),
    });
  });

  app.get("/api/v1/servers/:id/tools", async (c) => {
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

  app.post("/api/v1/servers/:id/tools/:name/call", async (c) => {
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

    // Open an Execution before dispatch; write-through into storage so the
    // durable log observes every tool call (Phase A slice 2 acceptance).
    const capabilityId = `${id}::tool::${name}`;
    const execution = deps.storage.executions.create({ serverId: id, capabilityId });
    deps.storage.events.append({
      executionId: execution.id,
      kind: "execution.created",
      payload: { serverId: id, capabilityId, name, arguments: args },
    });

    const startedAt = new Date();
    try {
      const { value, evidence } = await deps.adapter.callTool({
        serverId: id,
        name,
        arguments: args as Parameters<McpClientAdapter["callTool"]>[0]["arguments"],
      });
      const endedAt = new Date();

      const resultJson = JSON.stringify(value ?? null);
      const inlineResult = resultJson.length <= INLINE_RESULT_LIMIT ? resultJson : null;
      let resultArtifact: string | null = null;
      if (inlineResult === null) {
        const rec = deps.storage.artifacts.put({
          bytes: new TextEncoder().encode(resultJson),
          mediaType: "application/json",
        });
        resultArtifact = rec.hash;
      }

      const evidenceBlob = deps.storage.artifacts.put({
        bytes: new TextEncoder().encode(JSON.stringify(evidence)),
        mediaType: "application/json",
      });
      const evidenceRow = deps.storage.evidence.append({
        executionId: execution.id,
        kind: "raw_response",
        artifactRef: evidenceBlob.hash,
      });

      const round = deps.storage.rounds.append({
        executionId: execution.id,
        roundIndex: 0,
        kind: "initial",
        argumentsJson: JSON.stringify(args),
        resultInlineJson: inlineResult,
        resultArtifact,
        durationMs: endedAt.getTime() - startedAt.getTime(),
        startedAt: startedAt.toISOString(),
        endedAt: endedAt.toISOString(),
      });
      const done = deps.storage.executions.updateStatus(
        execution.id,
        "complete",
        endedAt.toISOString(),
      );
      deps.storage.events.append({
        executionId: execution.id,
        kind: "execution.complete",
        payload: {
          serverId: id,
          capabilityId,
          durationMs: round.durationMs,
          evidenceRefs: [evidenceRow.id],
          resultInline: inlineResult !== null,
          resultArtifact,
        },
      });

      return c.json({
        executionId: done.id,
        value,
        evidence,
        evidenceRefs: [{ id: evidenceRow.id, kind: evidenceRow.kind, artifactRef: evidenceRow.artifactRef }],
      });
    } catch (err) {
      const endedAt = new Date();
      const message = errMsg(err);
      deps.storage.rounds.append({
        executionId: execution.id,
        roundIndex: 0,
        kind: "initial",
        argumentsJson: JSON.stringify(args),
        errorJson: JSON.stringify({ message }),
        durationMs: endedAt.getTime() - startedAt.getTime(),
        startedAt: startedAt.toISOString(),
        endedAt: endedAt.toISOString(),
      });
      deps.storage.executions.updateStatus(execution.id, "failed", endedAt.toISOString());
      deps.storage.events.append({
        executionId: execution.id,
        kind: "execution.failed",
        payload: { serverId: id, capabilityId, error: message },
      });
      return c.json({ executionId: execution.id, error: message }, 502);
    }
  });

  app.get("/api/v1/executions", (c) => {
    const limit = clampLimit(c.req.query("limit"));
    return c.json({ executions: deps.storage.executions.list({ limit }) });
  });

  app.get("/api/v1/executions/:id", (c) => {
    const id = c.req.param("id");
    const record = deps.storage.executions.get(id);
    if (!record) return c.json({ error: `unknown execution '${id}'` }, 404);
    const rounds = deps.storage.rounds.listForExecution(id);
    const evidence = deps.storage.evidence.listForExecution(id);
    return c.json({ execution: record, rounds, evidence });
  });

  // Resumable SSE stream of execution/evidence/lifecycle events.
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
          await stream.sleep(250);
        }
      } finally {
        sub.close();
      }
    });
  });

  return app;
}

// Inline-vs-artifact split: results ≤ 16KiB stringified stay in SQLite;
// anything larger is written to the artifact store and referenced by hash.
// Threshold tuned high enough that typical tool responses stay inline; low
// enough that a single row does not carry MB of payload.
const INLINE_RESULT_LIMIT = 16 * 1024;

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

function clampLimit(value: string | undefined): number {
  const n = value ? Number(value) : 100;
  if (!Number.isFinite(n) || n <= 0) return 100;
  return Math.min(1000, Math.floor(n));
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
