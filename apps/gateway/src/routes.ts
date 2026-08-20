import { Hono } from "hono";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import {
  MODERN_PROTOCOL_VERSION,
  type JsonObject,
  type McpClientAdapter,
} from "@mcp-inspector-x/protocol";
import type { Storage, EventRow, UpsertServerInput } from "@mcp-inspector-x/storage";
import type { ServerManager } from "./servers";
import type { SecretsRegistry } from "./secrets";
import { compareExecutions } from "./compare";
import { buildPacket, renderPacketMarkdown } from "./packets";
import { runWorkspace, MAX_CONCURRENCY } from "./executor";
import { randomUUID } from "node:crypto";

export type { ServerBinding } from "./servers";

export interface GatewayDeps {
  adapter: McpClientAdapter;
  storage: Storage;
  serverManager: ServerManager;
  secrets: SecretsRegistry;
}

const TransportSchema = z.enum(["streamable-http", "stdio"]);
const PolicySchema = z.enum(["auto", "modern", "legacy"]);
// Stdio launch parameters — spawned by the privileged runner, never the
// gateway (ADR-0003). command is required for transport:"stdio"; the
// others default to the runner's own conventions (no args, inherited cwd,
// inherited + overlaid env).
const StdioArgsSchema = z.array(z.string()).optional();
const StdioCwdSchema = z.string().min(1).optional();
const StdioEnvSchema = z.record(z.string(), z.string()).optional();

const CreateServerSchema = z.object({
  id: z.string().min(1).max(128).optional(),
  displayName: z.string().min(1).max(200),
  transport: TransportSchema,
  endpoint: z.string().min(1).nullable().optional(),
  command: z.string().min(1).optional(),
  args: StdioArgsSchema,
  cwd: StdioCwdSchema,
  env: StdioEnvSchema,
  protocolPolicy: PolicySchema.optional(),
  disabled: z.boolean().optional(),
  credentialRefId: z.string().nullable().optional(),
  connectNow: z.boolean().optional(),
});

const PresentationSchema = z.enum(["collapsed", "expanded", "focus"]);

const CreateWorkspaceSchema = z.object({
  id: z.string().min(1).max(128).optional(),
  name: z.string().min(1).max(200),
  layoutJson: z.string().optional(),
});
const UpdateWorkspaceSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  layoutJson: z.string().optional(),
});
const CreateNodeSchema = z.object({
  id: z.string().min(1).max(128).optional(),
  serverId: z.string().nullable().optional(),
  capabilityId: z.string().nullable().optional(),
  argumentsJson: z.string().nullable().optional(),
  presentation: PresentationSchema.optional(),
  position: z.number().int().min(0).max(10_000).optional(),
});
const UpdateNodeSchema = z.object({
  serverId: z.string().nullable().optional(),
  capabilityId: z.string().nullable().optional(),
  argumentsJson: z.string().nullable().optional(),
  presentation: PresentationSchema.optional(),
  position: z.number().int().min(0).max(10_000).optional(),
});
const ReorderNodesSchema = z.object({
  orderedIds: z.array(z.string().min(1)).min(1),
});
const RunWorkspaceSchema = z.object({
  nodeIds: z.array(z.string().min(1)).min(1).max(500).optional(),
  concurrency: z.number().int().min(1).max(MAX_CONCURRENCY).optional(),
});
const CredentialProviderSchema = z.enum(["env", "os", "session"]);
const CreateCredentialSchema = z.object({
  id: z.string().min(1).max(128).optional(),
  provider: CredentialProviderSchema,
  key: z.string().min(1).max(200),
  scope: z.string().max(200).nullable().optional(),
  // Only meaningful for "os"/"session" — "env" always reads from the
  // process environment. Optional: a ref can be created empty and filled
  // in later (e.g. the OAuth flow populates it after the fact).
  value: z.string().min(1).max(65536).optional(),
});

const UpdateServerSchema = z.object({
  displayName: z.string().min(1).max(200).optional(),
  transport: TransportSchema.optional(),
  endpoint: z.string().min(1).nullable().optional(),
  command: z.string().min(1).optional(),
  args: StdioArgsSchema,
  cwd: StdioCwdSchema,
  env: StdioEnvSchema,
  protocolPolicy: PolicySchema.optional(),
  disabled: z.boolean().optional(),
  credentialRefId: z.string().nullable().optional(),
});

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
        liveMcpTransport: deps.serverManager.bindings().length > 0,
        multiToolWorkspace: true,
        investigationPackets: true,
        sourceIntelligence: false,
        durableExecutionLog: true,
        resumableSse: true,
        serverCatalogCrud: true,
        persistentWorkspaces: true,
        resources: true,
        prompts: true,
        executionHistory: true,
        executionComparison: true,
        investigationPacketsV2: true,
        credentialsV1: true,
        runSelected: true,
        runAll: true,
        agentRuns: true,
        traceIngestV1: true,
        sourceRevisionsV1: true,
      },
    }),
  );

  // ---- /api/v1/servers* — real catalog CRUD ----

  app.get("/api/v1/servers", (c) => {
    const rows = deps.storage.servers.list();
    const bindings = new Map(
      deps.serverManager.bindings().map((b) => [b.descriptor.id, b]),
    );
    return c.json({
      servers: rows.map((s) => {
        const binding = bindings.get(s.id);
        return {
          id: s.id,
          displayName: s.displayName,
          transport: s.transport,
          endpoint: s.endpoint,
          protocolPolicy: s.protocolPolicy,
          disabled: s.disabled,
          createdAt: s.createdAt,
          updatedAt: s.updatedAt,
          connected: binding !== undefined,
          negotiation: binding?.negotiation ?? null,
        };
      }),
    });
  });

  app.get("/api/v1/servers/:id", (c) => {
    const id = c.req.param("id");
    const row = deps.storage.servers.get(id);
    if (!row) return c.json({ error: `unknown server '${id}'` }, 404);
    const binding = deps.serverManager.getBinding(id);
    return c.json({
      server: {
        ...row,
        connected: binding !== undefined,
        negotiation: binding?.negotiation ?? null,
      },
    });
  });

  app.post("/api/v1/servers", async (c) => {
    const parse = CreateServerSchema.safeParse(await c.req.json().catch(() => null));
    if (!parse.success) {
      return c.json({ error: "invalid body", details: parse.error.issues }, 400);
    }
    const body = parse.data;
    const input: UpsertServerInput = {
      displayName: body.displayName,
      transport: body.transport,
      endpoint: body.endpoint ?? null,
      command: body.command ?? null,
      args: body.args ?? null,
      cwd: body.cwd ?? null,
      env: body.env ?? null,
      protocolPolicy: body.protocolPolicy ?? "auto",
      disabled: body.disabled ?? false,
      credentialRefId: body.credentialRefId ?? null,
    };
    if (body.id !== undefined) input.id = body.id;
    const created = body.id
      ? deps.storage.servers.upsertById({ ...input, id: body.id })
      : deps.storage.servers.create(input);
    deps.storage.events.append({
      kind: "server.created",
      payload: { serverId: created.id, transport: created.transport },
    });

    let negotiation: unknown = null;
    if (body.connectNow && !created.disabled) {
      try {
        const binding = await deps.serverManager.connect(created);
        negotiation = binding.negotiation;
      } catch (err) {
        return c.json(
          {
            server: created,
            connected: false,
            connectError: err instanceof Error ? err.message : String(err),
          },
          201,
        );
      }
    }
    return c.json({ server: created, connected: negotiation !== null, negotiation }, 201);
  });

  app.patch("/api/v1/servers/:id", async (c) => {
    const id = c.req.param("id");
    const existing = deps.storage.servers.get(id);
    if (!existing) return c.json({ error: `unknown server '${id}'` }, 404);

    const parse = UpdateServerSchema.safeParse(await c.req.json().catch(() => null));
    if (!parse.success) {
      return c.json({ error: "invalid body", details: parse.error.issues }, 400);
    }
    // Strip undefined keys so Partial<UpsertServerInput> honors exactOptionalPropertyTypes.
    const patch: Parameters<typeof deps.storage.servers.update>[1] = {};
    for (const [k, v] of Object.entries(parse.data)) {
      if (v !== undefined) (patch as Record<string, unknown>)[k] = v;
    }
    const updated = deps.storage.servers.update(id, patch);
    deps.storage.events.append({
      kind: "server.updated",
      payload: { serverId: id, changedKeys: Object.keys(parse.data) },
    });

    // If materially changed while connected, reconnect so the binding stays honest.
    const materialChange =
      parse.data.transport !== undefined ||
      parse.data.endpoint !== undefined ||
      parse.data.command !== undefined ||
      parse.data.args !== undefined ||
      parse.data.cwd !== undefined ||
      parse.data.env !== undefined ||
      parse.data.protocolPolicy !== undefined ||
      parse.data.disabled === true;
    if (materialChange) {
      await deps.serverManager.reconnectIfConnected(updated).catch(() => {});
    }
    return c.json({ server: updated });
  });

  app.delete("/api/v1/servers/:id", async (c) => {
    const id = c.req.param("id");
    const existing = deps.storage.servers.get(id);
    if (!existing) return c.json({ error: `unknown server '${id}'` }, 404);
    await deps.serverManager.disconnect(id);
    deps.storage.servers.delete(id);
    deps.storage.events.append({ kind: "server.deleted", payload: { serverId: id } });
    return c.json({ ok: true });
  });

  app.post("/api/v1/servers/:id/connect", async (c) => {
    const id = c.req.param("id");
    const row = deps.storage.servers.get(id);
    if (!row) return c.json({ error: `unknown server '${id}'` }, 404);
    if (deps.serverManager.getBinding(id)) {
      return c.json({ connected: true, negotiation: deps.serverManager.getBinding(id)!.negotiation });
    }
    try {
      const binding = await deps.serverManager.connect(row);
      return c.json({ connected: true, negotiation: binding.negotiation });
    } catch (err) {
      return c.json({ connected: false, error: err instanceof Error ? err.message : String(err) }, 502);
    }
  });

  app.post("/api/v1/servers/:id/disconnect", async (c) => {
    const id = c.req.param("id");
    const row = deps.storage.servers.get(id);
    if (!row) return c.json({ error: `unknown server '${id}'` }, 404);
    await deps.serverManager.disconnect(id);
    return c.json({ connected: false });
  });

  app.post("/api/v1/servers/:id/test-connection", async (c) => {
    const id = c.req.param("id");
    const row = deps.storage.servers.get(id);
    if (!row) return c.json({ error: `unknown server '${id}'` }, 404);
    const result = await deps.serverManager.testConnection(row);
    deps.storage.events.append({
      kind: "server.testConnection",
      payload: { serverId: id, ...result },
    });
    return c.json(result);
  });

  // ---- Tools + tool call (unchanged from slice 2) ----

  // ---- Capability listings: tools / resources / prompts ----

  app.get("/api/v1/servers/:id/resources", async (c) => {
    const id = c.req.param("id");
    if (!deps.serverManager.getBinding(id)) {
      return c.json({ error: `server '${id}' not connected` }, 409);
    }
    try {
      const [resources, templates] = await Promise.all([
        deps.adapter.listResources(id),
        deps.adapter.listResourceTemplates(id).catch(() => []),
      ]);
      return c.json({ resources, resourceTemplates: templates });
    } catch (err) {
      return c.json({ error: errMsg(err) }, 502);
    }
  });

  app.post("/api/v1/servers/:id/resources/read", async (c) => {
    const id = c.req.param("id");
    if (!deps.serverManager.getBinding(id)) {
      return c.json({ error: `server '${id}' not connected` }, 409);
    }
    const body = (await c.req.json().catch(() => null)) as { uri?: unknown } | null;
    if (!body || typeof body.uri !== "string" || body.uri.length === 0) {
      return c.json({ error: "'uri' (string) required" }, 400);
    }
    const capabilityId = `${id}::resource::${body.uri}`;
    const execution = deps.storage.executions.create({ serverId: id, capabilityId });
    deps.storage.events.append({
      executionId: execution.id,
      kind: "execution.created",
      payload: { serverId: id, capabilityId, kind: "resource.read", uri: body.uri },
    });
    const startedAt = new Date();
    try {
      const { contents, evidence } = await deps.adapter.readResource({
        serverId: id,
        uri: body.uri,
      });
      const endedAt = new Date();
      const resultJson = JSON.stringify({ contents });
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
      deps.storage.rounds.append({
        executionId: execution.id,
        roundIndex: 0,
        kind: "initial",
        argumentsJson: JSON.stringify({ uri: body.uri }),
        resultInlineJson: inlineResult,
        resultArtifact,
        durationMs: endedAt.getTime() - startedAt.getTime(),
        startedAt: startedAt.toISOString(),
        endedAt: endedAt.toISOString(),
      });
      deps.storage.executions.updateStatus(execution.id, "complete", endedAt.toISOString());
      deps.storage.events.append({
        executionId: execution.id,
        kind: "execution.complete",
        payload: { serverId: id, capabilityId, evidenceRefs: [evidenceRow.id] },
      });
      return c.json({ executionId: execution.id, contents, evidence });
    } catch (err) {
      const endedAt = new Date();
      const message = errMsg(err);
      deps.storage.executions.updateStatus(execution.id, "failed", endedAt.toISOString());
      deps.storage.events.append({
        executionId: execution.id,
        kind: "execution.failed",
        payload: { serverId: id, capabilityId, error: message },
      });
      return c.json({ executionId: execution.id, error: message }, 502);
    }
  });

  app.get("/api/v1/servers/:id/prompts", async (c) => {
    const id = c.req.param("id");
    if (!deps.serverManager.getBinding(id)) {
      return c.json({ error: `server '${id}' not connected` }, 409);
    }
    try {
      const prompts = await deps.adapter.listPrompts(id);
      return c.json({ prompts });
    } catch (err) {
      return c.json({ error: errMsg(err) }, 502);
    }
  });

  app.post("/api/v1/servers/:id/prompts/:name/get", async (c) => {
    const id = c.req.param("id");
    const name = c.req.param("name");
    if (!deps.serverManager.getBinding(id)) {
      return c.json({ error: `server '${id}' not connected` }, 409);
    }
    const body = (await c.req.json().catch(() => ({}))) as { arguments?: unknown };
    const args =
      body.arguments && typeof body.arguments === "object" && !Array.isArray(body.arguments)
        ? (body.arguments as Record<string, unknown>)
        : {};
    const capabilityId = `${id}::prompt::${name}`;
    const execution = deps.storage.executions.create({ serverId: id, capabilityId });
    deps.storage.events.append({
      executionId: execution.id,
      kind: "execution.created",
      payload: { serverId: id, capabilityId, kind: "prompt.get", name, arguments: args },
    });
    const startedAt = new Date();
    try {
      // Build the call args explicitly so exactOptionalPropertyTypes doesn't
      // reject a present-but-undefined `arguments`.
      const { messages, description, evidence } =
        Object.keys(args).length > 0
          ? await deps.adapter.getPrompt({ serverId: id, name, arguments: args as JsonObject })
          : await deps.adapter.getPrompt({ serverId: id, name });
      const endedAt = new Date();
      const resultJson = JSON.stringify({ messages, description });
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
      deps.storage.rounds.append({
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
      deps.storage.executions.updateStatus(execution.id, "complete", endedAt.toISOString());
      deps.storage.events.append({
        executionId: execution.id,
        kind: "execution.complete",
        payload: { serverId: id, capabilityId, evidenceRefs: [evidenceRow.id] },
      });
      const response: { executionId: string; messages: unknown; description?: string; evidence: unknown } = {
        executionId: execution.id,
        messages,
        evidence,
      };
      if (description !== undefined) response.description = description;
      return c.json(response);
    } catch (err) {
      const endedAt = new Date();
      const message = errMsg(err);
      deps.storage.executions.updateStatus(execution.id, "failed", endedAt.toISOString());
      deps.storage.events.append({
        executionId: execution.id,
        kind: "execution.failed",
        payload: { serverId: id, capabilityId, error: message },
      });
      return c.json({ executionId: execution.id, error: message }, 502);
    }
  });

  app.get("/api/v1/servers/:id/tools", async (c) => {
    const id = c.req.param("id");
    if (!deps.serverManager.getBinding(id)) {
      return c.json({ error: `server '${id}' not connected` }, 409);
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
    if (!deps.serverManager.getBinding(id)) {
      return c.json({ error: `server '${id}' not connected` }, 409);
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

  // ---- /api/v1/workspaces* — persistent workspace + nodes ----

  app.get("/api/v1/workspaces", (c) => {
    return c.json({ workspaces: deps.storage.workspaces.list() });
  });

  app.post("/api/v1/workspaces", async (c) => {
    const parse = CreateWorkspaceSchema.safeParse(await c.req.json().catch(() => null));
    if (!parse.success) {
      return c.json({ error: "invalid body", details: parse.error.issues }, 400);
    }
    const input: Parameters<typeof deps.storage.workspaces.create>[0] = {
      name: parse.data.name,
    };
    if (parse.data.id !== undefined) input.id = parse.data.id;
    if (parse.data.layoutJson !== undefined) input.layoutJson = parse.data.layoutJson;
    const created = deps.storage.workspaces.create(input);
    deps.storage.events.append({
      kind: "workspace.created",
      payload: { workspaceId: created.id },
    });
    return c.json({ workspace: created }, 201);
  });

  app.get("/api/v1/workspaces/:id", (c) => {
    const id = c.req.param("id");
    const ws = deps.storage.workspaces.get(id);
    if (!ws) return c.json({ error: `unknown workspace '${id}'` }, 404);
    const nodes = deps.storage.workspaceNodes.listForWorkspace(id);
    return c.json({ workspace: ws, nodes });
  });

  app.patch("/api/v1/workspaces/:id", async (c) => {
    const id = c.req.param("id");
    if (!deps.storage.workspaces.get(id)) return c.json({ error: `unknown workspace '${id}'` }, 404);
    const parse = UpdateWorkspaceSchema.safeParse(await c.req.json().catch(() => null));
    if (!parse.success) return c.json({ error: "invalid body", details: parse.error.issues }, 400);
    const patch: Parameters<typeof deps.storage.workspaces.update>[1] = {};
    if (parse.data.name !== undefined) patch.name = parse.data.name;
    if (parse.data.layoutJson !== undefined) patch.layoutJson = parse.data.layoutJson;
    const updated = deps.storage.workspaces.update(id, patch);
    deps.storage.events.append({
      kind: "workspace.updated",
      payload: { workspaceId: id, changedKeys: Object.keys(patch) },
    });
    return c.json({ workspace: updated });
  });

  app.delete("/api/v1/workspaces/:id", (c) => {
    const id = c.req.param("id");
    if (!deps.storage.workspaces.get(id)) return c.json({ error: `unknown workspace '${id}'` }, 404);
    deps.storage.workspaces.delete(id);
    deps.storage.events.append({ kind: "workspace.deleted", payload: { workspaceId: id } });
    return c.json({ ok: true });
  });

  app.post("/api/v1/workspaces/:id/nodes", async (c) => {
    const id = c.req.param("id");
    if (!deps.storage.workspaces.get(id)) return c.json({ error: `unknown workspace '${id}'` }, 404);
    const parse = CreateNodeSchema.safeParse(await c.req.json().catch(() => null));
    if (!parse.success) return c.json({ error: "invalid body", details: parse.error.issues }, 400);
    const input: Parameters<typeof deps.storage.workspaceNodes.create>[0] = {
      workspaceId: id,
    };
    for (const key of ["id", "serverId", "capabilityId", "argumentsJson", "presentation", "position"] as const) {
      const val = parse.data[key];
      if (val !== undefined) (input as unknown as Record<string, unknown>)[key] = val;
    }
    const node = deps.storage.workspaceNodes.create(input);
    deps.storage.events.append({
      kind: "workspace.node.added",
      payload: { workspaceId: id, nodeId: node.id },
    });
    return c.json({ node }, 201);
  });

  app.patch("/api/v1/workspaces/:id/nodes/:nodeId", async (c) => {
    const workspaceId = c.req.param("id");
    const nodeId = c.req.param("nodeId");
    const node = deps.storage.workspaceNodes.get(nodeId);
    if (!node || node.workspaceId !== workspaceId) {
      return c.json({ error: `unknown workspace_node '${nodeId}'` }, 404);
    }
    const parse = UpdateNodeSchema.safeParse(await c.req.json().catch(() => null));
    if (!parse.success) return c.json({ error: "invalid body", details: parse.error.issues }, 400);
    const patch: Parameters<typeof deps.storage.workspaceNodes.update>[1] = {};
    for (const [k, v] of Object.entries(parse.data)) {
      if (v !== undefined) (patch as Record<string, unknown>)[k] = v;
    }
    const updated = deps.storage.workspaceNodes.update(nodeId, patch);
    deps.storage.events.append({
      kind: "workspace.node.updated",
      payload: { workspaceId, nodeId, changedKeys: Object.keys(patch) },
    });
    return c.json({ node: updated });
  });

  app.delete("/api/v1/workspaces/:id/nodes/:nodeId", (c) => {
    const workspaceId = c.req.param("id");
    const nodeId = c.req.param("nodeId");
    const node = deps.storage.workspaceNodes.get(nodeId);
    if (!node || node.workspaceId !== workspaceId) {
      return c.json({ error: `unknown workspace_node '${nodeId}'` }, 404);
    }
    deps.storage.workspaceNodes.delete(nodeId);
    deps.storage.events.append({
      kind: "workspace.node.removed",
      payload: { workspaceId, nodeId },
    });
    return c.json({ ok: true });
  });

  app.post("/api/v1/workspaces/:id/run", async (c) => {
    const id = c.req.param("id");
    if (!deps.storage.workspaces.get(id)) return c.json({ error: `unknown workspace '${id}'` }, 404);
    const parse = RunWorkspaceSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parse.success) {
      return c.json({ error: "invalid body", details: parse.error.issues }, 400);
    }
    const runId = randomUUID();
    const runInput: Parameters<typeof runWorkspace>[1] = { workspaceId: id, runId };
    if (parse.data.nodeIds !== undefined) runInput.nodeIds = parse.data.nodeIds;
    if (parse.data.concurrency !== undefined) runInput.concurrency = parse.data.concurrency;
    const result = await runWorkspace(
      { adapter: deps.adapter, storage: deps.storage, serverManager: deps.serverManager },
      runInput,
    );
    return c.json(result);
  });

  app.post("/api/v1/workspaces/:id/nodes/reorder", async (c) => {
    const id = c.req.param("id");
    if (!deps.storage.workspaces.get(id)) return c.json({ error: `unknown workspace '${id}'` }, 404);
    const parse = ReorderNodesSchema.safeParse(await c.req.json().catch(() => null));
    if (!parse.success) return c.json({ error: "invalid body", details: parse.error.issues }, 400);
    // Guard: every id must belong to this workspace.
    const known = new Set(
      deps.storage.workspaceNodes.listForWorkspace(id).map((n) => n.id),
    );
    for (const nodeId of parse.data.orderedIds) {
      if (!known.has(nodeId)) {
        return c.json(
          { error: `node '${nodeId}' does not belong to workspace '${id}'` },
          400,
        );
      }
    }
    const nodes = deps.storage.workspaceNodes.reorder(id, parse.data.orderedIds);
    deps.storage.events.append({
      kind: "workspace.node.reordered",
      payload: { workspaceId: id, orderedIds: parse.data.orderedIds },
    });
    return c.json({ nodes });
  });

  app.get("/api/v1/executions", (c) => {
    const limit = clampLimit(c.req.query("limit"));
    const capabilityId = c.req.query("capabilityId");
    const rows = capabilityId
      ? deps.storage.executions.listForCapability(capabilityId, { limit })
      : deps.storage.executions.list({ limit });
    return c.json({ executions: rows });
  });

  app.get("/api/v1/capabilities/:capabilityId/executions", (c) => {
    const capabilityId = c.req.param("capabilityId");
    const limit = clampLimit(c.req.query("limit"));
    return c.json({
      capabilityId,
      executions: deps.storage.executions.listForCapability(capabilityId, { limit }),
    });
  });

  // ---- /api/v1/credentials — metadata only, secret value is NEVER returned ----

  app.get("/api/v1/credentials", (c) => {
    return c.json({ credentials: deps.storage.credentials.list() });
  });

  app.post("/api/v1/credentials", async (c) => {
    const parse = CreateCredentialSchema.safeParse(await c.req.json().catch(() => null));
    if (!parse.success) {
      return c.json({ error: "invalid body", details: parse.error.issues }, 400);
    }
    if (parse.data.provider === "env" && parse.data.value !== undefined) {
      return c.json({ error: "'env' credentials cannot take a 'value' — set the environment variable instead" }, 400);
    }
    const input: Parameters<typeof deps.storage.credentials.create>[0] = {
      provider: parse.data.provider,
      key: parse.data.key,
    };
    if (parse.data.id !== undefined) input.id = parse.data.id;
    if (parse.data.scope !== undefined) input.scope = parse.data.scope;
    const created = deps.storage.credentials.create(input);
    if (parse.data.value !== undefined) {
      try {
        await deps.secrets.put(created, parse.data.value);
      } catch (err) {
        deps.storage.credentials.delete(created.id);
        return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
      }
    }
    deps.storage.events.append({
      kind: "credential.created",
      payload: { credentialRefId: created.id, provider: created.provider, key: created.key },
    });
    return c.json({ credentialRef: created }, 201);
  });

  app.delete("/api/v1/credentials/:id", async (c) => {
    const id = c.req.param("id");
    const ref = deps.storage.credentials.get(id);
    if (!ref) return c.json({ error: `unknown credential '${id}'` }, 404);
    await deps.secrets.remove(ref).catch(() => {});
    deps.storage.credentials.delete(id);
    deps.storage.events.append({ kind: "credential.deleted", payload: { credentialRefId: id } });
    return c.json({ ok: true });
  });

  app.post("/api/v1/packets/build", async (c) => {
    const body = (await c.req.json().catch(() => null)) as {
      executionIds?: unknown;
      tier?: unknown;
      format?: unknown;
      packetId?: unknown;
      context?: unknown;
    } | null;
    if (
      !body ||
      !Array.isArray(body.executionIds) ||
      body.executionIds.length === 0 ||
      body.executionIds.some((id) => typeof id !== "string" || id.length === 0)
    ) {
      return c.json({ error: "'executionIds' (non-empty string[]) required" }, 400);
    }
    // Bounded default: never assemble more than 50 executions in one packet unless
    // the caller explicitly opts in. Prevents an accidental full-history export.
    if (body.executionIds.length > 50) {
      return c.json({ error: "packet exceeds bounded default of 50 executions" }, 400);
    }
    const tier =
      body.tier === "compact" || body.tier === "investigation" || body.tier === "exhaustive"
        ? body.tier
        : "investigation";
    const format = body.format === "markdown" ? "markdown" : "json";

    const packetInput: Parameters<typeof buildPacket>[0] = {
      storage: deps.storage,
      executionIds: body.executionIds as string[],
      tier,
      knownSecrets: deps.secrets.known(),
    };
    if (typeof body.packetId === "string") packetInput.packetId = body.packetId;
    const result = buildPacket(packetInput);
    if ("error" in result) return c.json(result, 404);

    if (format === "markdown") {
      return c.text(renderPacketMarkdown(result), 200, {
        "content-type": "text/markdown; charset=utf-8",
      });
    }
    return c.json({ packet: result });
  });

  // ---- Agent Runs + capture sessions (read-only in this slice) ----

  app.get("/api/v1/capture-sessions", (c) => {
    const limit = clampLimit(c.req.query("limit"));
    return c.json({ captureSessions: deps.storage.captureSessions.list({ limit }) });
  });

  app.get("/api/v1/capture-sessions/:id", (c) => {
    const id = c.req.param("id");
    const cs = deps.storage.captureSessions.get(id);
    if (!cs) return c.json({ error: `unknown capture_session '${id}'` }, 404);
    const runs = deps.storage.agentRuns.listForCaptureSession(id);
    return c.json({ captureSession: cs, agentRuns: runs });
  });

  // ---- Traces (Phase M slice 1: substrate + ingest, no correlation yet) ----

  // ---- Source revisions (Phase M slice 2: substrate only, indexer is slice 3+) ----

  app.post("/api/v1/source/revisions", async (c) => {
    const body = (await c.req.json().catch(() => null)) as {
      repositoryRef?: unknown;
      revisionHash?: unknown;
      branch?: unknown;
      shortSha?: unknown;
      metadata?: unknown;
    } | null;
    if (!body || typeof body.repositoryRef !== "string" || body.repositoryRef.length === 0) {
      return c.json({ error: "'repositoryRef' (string) required" }, 400);
    }
    if (typeof body.revisionHash !== "string" || body.revisionHash.length < 7) {
      // Enforce "never silently substitute repository main": callers must
      // provide an explicit revision hash. Empty / missing / <7 chars → 400.
      return c.json({ error: "'revisionHash' (string, min 7 chars) required" }, 400);
    }
    const input: Parameters<typeof deps.storage.sourceRevisions.register>[0] = {
      repositoryRef: body.repositoryRef,
      revisionHash: body.revisionHash,
    };
    if (typeof body.branch === "string") input.branch = body.branch;
    if (typeof body.shortSha === "string") input.shortSha = body.shortSha;
    if (body.metadata !== undefined) input.metadata = body.metadata;
    const rev = deps.storage.sourceRevisions.register(input);
    deps.storage.events.append({
      kind: "source.revision.registered",
      payload: {
        repositoryRef: rev.repositoryRef,
        revisionHash: rev.revisionHash,
        branch: rev.branch,
      },
    });
    return c.json({ sourceRevision: rev }, 201);
  });

  app.get("/api/v1/source/revisions", (c) => {
    const limit = clampLimit(c.req.query("limit"));
    const repositoryRef = c.req.query("repositoryRef");
    const rows = repositoryRef
      ? deps.storage.sourceRevisions.listForRepository(repositoryRef, { limit })
      : deps.storage.sourceRevisions.list({ limit });
    return c.json({ sourceRevisions: rows });
  });

  app.get("/api/v1/source/revisions/:id", (c) => {
    const id = c.req.param("id");
    const rev = deps.storage.sourceRevisions.get(id);
    if (!rev) return c.json({ error: `unknown source_revision '${id}'` }, 404);
    return c.json({ sourceRevision: rev });
  });

  app.post("/api/v1/traces", async (c) => {
    const body = (await c.req.json().catch(() => null)) as {
      traceId?: unknown;
      spans?: unknown;
      source?: unknown;
    } | null;
    if (!body || typeof body.traceId !== "string" || body.traceId.length === 0) {
      return c.json({ error: "'traceId' (string) required" }, 400);
    }
    if (!Array.isArray(body.spans)) {
      return c.json({ error: "'spans' (array) required" }, 400);
    }
    // Bounded upload: a runaway agent shouldn't be able to stuff MBs of spans
    // into a single trace record. 10k spans is generous for any realistic
    // agent hop-chain and prevents pathological memory use.
    if (body.spans.length > 10_000) {
      return c.json({ error: "trace exceeds bounded default of 10,000 spans" }, 400);
    }
    const putInput: Parameters<typeof deps.storage.traces.put>[0] = {
      traceId: body.traceId,
      spans: body.spans,
    };
    if (typeof body.source === "string") putInput.source = body.source;
    const record = deps.storage.traces.put(putInput);
    deps.storage.events.append({
      kind: "trace.ingested",
      payload: { traceId: record.traceId, spanCount: record.spanCount, source: record.source },
    });
    return c.json({ trace: record }, 201);
  });

  app.get("/api/v1/traces", (c) => {
    const limit = clampLimit(c.req.query("limit"));
    return c.json({ traces: deps.storage.traces.list({ limit }) });
  });

  app.get("/api/v1/traces/:traceId", (c) => {
    const traceId = c.req.param("traceId");
    const record = deps.storage.traces.get(traceId);
    if (!record) return c.json({ error: `unknown trace '${traceId}'` }, 404);
    return c.json({ trace: record });
  });

  app.get("/api/v1/agent-runs", (c) => {
    const limit = clampLimit(c.req.query("limit"));
    return c.json({ agentRuns: deps.storage.agentRuns.list({ limit }) });
  });

  app.get("/api/v1/agent-runs/:id", (c) => {
    const id = c.req.param("id");
    const run = deps.storage.agentRuns.get(id);
    if (!run) return c.json({ error: `unknown agent_run '${id}'` }, 404);
    const executions = deps.storage.executions.listForAgentRun(id);
    return c.json({ agentRun: run, executions });
  });

  app.post("/api/v1/executions/compare", async (c) => {
    const body = (await c.req.json().catch(() => null)) as {
      leftId?: unknown;
      rightId?: unknown;
    } | null;
    if (!body || typeof body.leftId !== "string" || typeof body.rightId !== "string") {
      return c.json({ error: "'leftId' and 'rightId' (strings) required" }, 400);
    }
    const result = compareExecutions(deps.storage, body.leftId, body.rightId);
    if ("error" in result) return c.json(result, 404);
    return c.json(result);
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
