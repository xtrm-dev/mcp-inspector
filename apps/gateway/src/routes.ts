import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import {
  MODERN_PROTOCOL_VERSION,
  type JsonObject,
  type JsonValue,
  type McpClientAdapter,
  type ProtocolEvidence,
} from "@mcp-inspector-x/protocol";
import type {
  Storage,
  EventRow,
  EvidenceRef,
  ExecutionRecord,
  ExecutionRound,
  RoundKind,
  TraceLink,
  UpsertServerInput,
} from "@mcp-inspector-x/storage";
import { createRendererRegistry, renderInlineMaxBytes, type RendererKind, type RenderPageResult } from "@mcp-inspector-x/renderers";
import {
  isRequest,
  isResponse,
  isNotification,
  createLineDecoder,
  type RunnerClient,
  type CaptureEnvelope,
  type JsonRpcRequest,
} from "@mcp-inspector-x/runner";
import { connect as netConnect, type Socket } from "node:net";
import {
  parseSourceMappingEntry,
  trimSnippet,
  type SourceMappingEntry,
} from "@mcp-inspector-x/source-intelligence";
import type { ServerManager } from "./servers";
import type { SecretsRegistry } from "./secrets";
import { compareExecutions } from "./compare";
import { buildPacket, renderPacketMarkdown } from "./packets";
import {
  runWorkspace,
  MAX_CONCURRENCY,
  parseTraceparent,
  cancelExecution,
  isInFlight,
  registerInFlight,
  executeTool,
  executeResourceRead,
  executeGetPrompt,
  parseCapabilityId,
  parseArgs,
  type ExecuteResult,
  type ExecuteGetPromptInput,
} from "./executor";
import { randomUUID } from "node:crypto";

export type { ServerBinding } from "./servers";

export interface GatewayDeps {
  adapter: McpClientAdapter;
  storage: Storage;
  serverManager: ServerManager;
  secrets: SecretsRegistry;
  // Required to open stdio-proxy capture sessions (POST
  // /api/v1/capture-sessions/stdio-proxy/open) — the runner is the only
  // thing allowed to own the ingest UDS the proxy dials (ADR-0003-style
  // privilege separation). Omit it and that endpoint fails fast with a
  // clear 503, same convention as ServerManagerOptions.runnerClient.
  runnerClient?: RunnerClient;
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

// Header names are HTTP tokens — narrow enough to reject stray control
// characters, permissive enough to admit vendor-prefixed and lower/upper
// case forms (X-API-Key, x-mercury-api-key, Authorization, etc.).
const HeaderNameSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/, "invalid HTTP header name");
const HeaderCredentialsSchema = z
  .record(HeaderNameSchema, z.string().min(1).max(200))
  .nullable()
  .optional();

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
  headerCredentials: HeaderCredentialsSchema,
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
  // Session and OS providers accept an inline `value` on create so the SPA
  // "Add server" flow can register+seed a credential in one round trip.
  // `env` rejects it — the env-var name IS the reference; the value comes
  // from the gateway process environment (see secrets.ts `put`).
  value: z.string().min(1).max(4096).optional(),
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
  headerCredentials: HeaderCredentialsSchema,
});

/**
 * Build the Hono app. Split from index.ts so routes can be exercised in
 * unit tests without spinning a real Node HTTP listener.
 */
const rendererRegistry = createRendererRegistry();

export function buildGatewayApp(deps: GatewayDeps): Hono {
  const app = new Hono();

  app.use("*", cors({ origin: (o) => o ?? "*" }));

  // ---- stdio-proxy capture state (Phase L slice 3) ----
  // captureReaders: the gateway's own UDS connection into each open ingest
  // socket (one per capture session — see proxy-session-open below).
  // capturePending: per-session, un-answered JSON-RPC requests keyed by
  // id, so the matching response can be recorded alongside it as one
  // execution_round instead of two orphaned evidence rows.
  const captureReaders = new Map<string, Socket>();
  const capturePending = new Map<string, Map<JsonRpcRequest["id"], { request: JsonRpcRequest; ts: number }>>();

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
        capabilitySourceMappingV1: true,
        traceCorrelationV1: true,
      },
    }),
  );

  app.get("/api/v1/renderers", (c) => {
    return c.json({ renderers: rendererRegistry.available().map((kind) => rendererRegistry.describe(kind)) });
  });

  // ---- /api/v1/artifacts* — bounded page reads over spilled large payloads ----
  //
  // Only large (RENDER_INLINE_MAX_BYTES-exceeding) tool-call/resource-read
  // results are readable this way; artifacts written for other reasons
  // (evidence blobs, DB round.resultArtifact) 404 here just the same as a
  // missing hash — this endpoint doesn't distinguish, it just streams
  // whatever "\n"-delimited bytes are on disk for the hash.
  app.get("/api/v1/artifacts/:sha/page", async (c) => {
    const sha = c.req.param("sha");
    const record = deps.storage.artifacts.getRecord(sha);
    if (!record) {
      return c.json({ error: `artifact '${sha}' not found` }, 404);
    }
    const offset = parseSince(c.req.query("offset"));
    const limit = clampRenderPageLimit(c.req.query("limit"));
    let page: Awaited<ReturnType<typeof deps.storage.artifacts.getPage>>;
    try {
      page = await deps.storage.artifacts.getPage(sha, offset, limit);
    } catch (err) {
      return c.json({ error: errMsg(err) }, 500);
    }

    const kindParam = c.req.query("kind");
    const kind = isRendererKind(kindParam) ? kindParam : null;
    if (kind && record.mediaType === "application/x-ndjson" && page.lines.length > 0) {
      try {
        const items = page.lines.map((line) => JSON.parse(line) as unknown);
        const formatted = rendererRegistry.renderPage(items, { kind, offset: 0, limit: items.length });
        if (formatted.ok) {
          return c.json({
            artifactRef: sha,
            offset: page.offset,
            limit: page.limit,
            hasMore: page.hasMore,
            kind,
            lines: formatted.lines,
            ...(formatted.rows !== undefined ? { rows: formatted.rows } : {}),
            ...(formatted.columns !== undefined ? { columns: formatted.columns } : {}),
          });
        }
      } catch {
        // fall through to the raw-lines response below
      }
    }

    return c.json({
      artifactRef: sha,
      offset: page.offset,
      limit: page.limit,
      hasMore: page.hasMore,
      lines: page.lines,
    });
  });

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
      headerCredentials: body.headerCredentials ?? null,
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
      parse.data.credentialRefId !== undefined ||
      parse.data.headerCredentials !== undefined ||
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
      const surface = buildRenderSurface(contents, deps.storage.artifacts);
      const response: {
        executionId: string;
        evidence: unknown;
        suggestedRenderer: RendererKind;
        spilled: boolean;
        contents?: unknown;
        artifactRef?: string;
        preview?: RenderPageResult;
      } = {
        executionId: execution.id,
        evidence,
        suggestedRenderer: surface.kind,
        spilled: surface.spilled,
      };
      if (surface.spilled) {
        response.artifactRef = surface.artifactRef;
        response.preview = surface.preview;
      } else {
        response.contents = contents;
      }
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
      const response: {
        executionId: string;
        messages: unknown;
        description?: string;
        evidence: unknown;
        suggestedRenderer: ReturnType<typeof rendererRegistry.suggest>;
      } = {
        executionId: execution.id,
        messages,
        evidence,
        suggestedRenderer: rendererRegistry.suggest(messages),
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
    const parsedTp = parseTraceparent(c.req.header("traceparent"));
    const execution = deps.storage.executions.create({
      serverId: id,
      capabilityId,
      ...(parsedTp ? { traceId: parsedTp.traceId } : {}),
    });
    deps.storage.events.append({
      executionId: execution.id,
      kind: "execution.created",
      payload: { serverId: id, capabilityId, name, arguments: args },
    });

    const controller = new AbortController();
    const unregister = registerInFlight(execution.id, controller);
    const startedAt = new Date();
    try {
      const { value, evidence } = await deps.adapter.callTool({
        serverId: id,
        name,
        arguments: args as Parameters<McpClientAdapter["callTool"]>[0]["arguments"],
        signal: controller.signal,
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

      // Phase G: derive MRTR / Tasks status from the adapter's evidence.
      // Persist requestState/taskId into the round's inline JSON so
      // POST /executions/:id/rounds can recover them on the follow-up.
      const isInputRequired = (evidence as ProtocolEvidence).resultType === "input_required";
      const task = isInputRequired ? null : detectTaskShape(value as JsonValue);
      const resultPayload: JsonValue = isInputRequired
        ? {
            status: "input_required",
            requestState:
              ((evidence as ProtocolEvidence).extensions?.["requestState"] ?? null) as JsonValue,
            inputRequests:
              ((evidence as ProtocolEvidence).extensions?.["inputRequests"] ?? null) as JsonValue,
          }
        : ((value ?? null) as JsonValue);
      const resultPayloadJson = JSON.stringify(resultPayload);
      const inlineResultForRound =
        resultPayloadJson.length <= INLINE_RESULT_LIMIT ? resultPayloadJson : null;
      let resultArtifactForRound: string | null = null;
      if (inlineResultForRound === null) {
        const rec = deps.storage.artifacts.put({
          bytes: new TextEncoder().encode(resultPayloadJson),
          mediaType: "application/json",
        });
        resultArtifactForRound = rec.hash;
      }
      let nextStatus: string;
      let endedAtIso: string | null;
      let eventKind: string;
      if (isInputRequired) {
        nextStatus = "input_required";
        endedAtIso = null;
        eventKind = "execution.input_required";
      } else if (task?.status === "working") {
        nextStatus = "task_working";
        endedAtIso = null;
        eventKind = "execution.task_update";
      } else {
        nextStatus = "complete";
        endedAtIso = endedAt.toISOString();
        eventKind = "execution.complete";
      }
      const round = deps.storage.rounds.append({
        executionId: execution.id,
        roundIndex: 0,
        kind: "initial",
        argumentsJson: JSON.stringify(args),
        resultInlineJson: inlineResultForRound,
        resultArtifact: resultArtifactForRound,
        durationMs: endedAt.getTime() - startedAt.getTime(),
        startedAt: startedAt.toISOString(),
        endedAt: endedAtIso,
      });
      const done = deps.storage.executions.updateStatus(execution.id, nextStatus, endedAtIso);
      deps.storage.events.append({
        executionId: execution.id,
        kind: eventKind,
        payload: {
          serverId: id,
          capabilityId,
          status: nextStatus,
          durationMs: round.durationMs,
          evidenceRefs: [evidenceRow.id],
          resultInline: inlineResultForRound !== null,
          resultArtifact: resultArtifactForRound,
        },
      });

      const surface = buildRenderSurface(value, deps.storage.artifacts);
      const mapping = deps.storage.sourceMappings.findLatestForCapability(capabilityId);
      const sourceHint = mapping
        ? {
            revisionId: mapping.revisionId,
            filePath: mapping.filePath,
            symbol: mapping.handlerSymbol,
            lineStart: mapping.lineStart,
            lineEnd: mapping.lineEnd,
          }
        : null;
      const response: {
        executionId: string;
        status: string;
        evidence: unknown;
        evidenceRefs: Array<{ id: string; kind: string; artifactRef: string }>;
        suggestedRenderer: RendererKind;
        spilled: boolean;
        value?: unknown;
        artifactRef?: string;
        preview?: RenderPageResult;
        inputRequests?: unknown;
        requestState?: unknown;
        sourceHint?: {
          revisionId: string;
          filePath: string;
          symbol: string;
          lineStart: number;
          lineEnd: number;
        };
      } = {
        executionId: done.id,
        status: nextStatus,
        evidence,
        evidenceRefs: [{ id: evidenceRow.id, kind: evidenceRow.kind, artifactRef: evidenceRow.artifactRef }],
        suggestedRenderer: surface.kind,
        spilled: surface.spilled,
      };
      if (isInputRequired) {
        response.inputRequests = (evidence as ProtocolEvidence).extensions?.["inputRequests"] ?? null;
        response.requestState = (evidence as ProtocolEvidence).extensions?.["requestState"] ?? null;
      }
      if (surface.spilled) {
        response.artifactRef = surface.artifactRef;
        response.preview = surface.preview;
      } else {
        response.value = value;
      }
      if (sourceHint) response.sourceHint = sourceHint;
      return c.json(response);
    } catch (err) {
      const endedAt = new Date();
      const cancelled = controller.signal.aborted;
      const cancelledBy = cancelled
        ? typeof controller.signal.reason === "string"
          ? controller.signal.reason
          : "user"
        : null;
      const message = cancelled ? `cancelled by ${cancelledBy}` : errMsg(err);
      deps.storage.rounds.append({
        executionId: execution.id,
        roundIndex: 0,
        kind: "initial",
        argumentsJson: JSON.stringify(args),
        errorJson: cancelled
          ? JSON.stringify({ cancelled: true, cancelledBy })
          : JSON.stringify({ message }),
        durationMs: endedAt.getTime() - startedAt.getTime(),
        startedAt: startedAt.toISOString(),
        endedAt: endedAt.toISOString(),
      });
      deps.storage.executions.updateStatus(
        execution.id,
        cancelled ? "cancelled" : "failed",
        endedAt.toISOString(),
      );
      deps.storage.events.append({
        executionId: execution.id,
        kind: cancelled ? "execution.cancelled" : "execution.failed",
        payload: cancelled
          ? { serverId: id, capabilityId, cancelledBy }
          : { serverId: id, capabilityId, error: message },
      });
      return c.json({ executionId: execution.id, error: message }, 502);
    } finally {
      unregister();
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
    const input: Parameters<typeof deps.storage.credentials.create>[0] = {
      provider: parse.data.provider,
      key: parse.data.key,
    };
    if (parse.data.id !== undefined) input.id = parse.data.id;
    if (parse.data.scope !== undefined) input.scope = parse.data.scope;
    const created = deps.storage.credentials.create(input);
    if (parse.data.value !== undefined) {
      if (parse.data.provider === "env") {
        return c.json({
          error: "'env' credentials cannot carry an inline value — set the environment variable named by 'key' instead",
        }, 400);
      }
      try {
        await deps.secrets.put(created, parse.data.value);
      } catch (err) {
        return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
      }
    }
    deps.storage.events.append({
      kind: "credential.created",
      payload: { credentialRefId: created.id, provider: created.provider, key: created.key },
    });
    return c.json({ credentialRef: created }, 201);
  });

  app.delete("/api/v1/credentials/:id", (c) => {
    const id = c.req.param("id");
    if (!deps.storage.credentials.get(id)) return c.json({ error: `unknown credential '${id}'` }, 404);
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

  // ---- stdio-proxy capture (Phase L slice 3 — ADR-0002) ----
  //
  // Open: ask the runner for a fresh ingest UDS, create the durable
  // CaptureSession (kind='stdio-proxy'), and dial into the ingest socket
  // ourselves as a reader BEFORE returning the socket path — so whoever
  // launches the stdio-proxy binary next (with --ingest <socketPath>) can
  // never race ahead of us and have an early message dropped.
  app.post("/api/v1/capture-sessions/stdio-proxy/open", async (c) => {
    if (!deps.runnerClient) {
      return c.json(
        { error: "stdio-proxy capture requires a privileged runner (none configured on this gateway)" },
        503,
      );
    }
    const body = (await c.req.json().catch(() => null)) as { targetLabel?: unknown } | null;
    const targetLabel =
      typeof body?.targetLabel === "string" && body.targetLabel.length > 0
        ? body.targetLabel
        : "stdio-proxy";

    const attached = await deps.runnerClient.attachCaptureSession({});
    const cs = deps.storage.captureSessions.create({
      kind: "stdio-proxy",
      metadata: { runnerSessionId: attached.sessionId, targetLabel },
    });

    const reader = await connectCaptureReader(attached.socketPath);
    capturePending.set(cs.id, new Map());
    captureReaders.set(cs.id, reader);
    const pending = capturePending.get(cs.id)!;
    const decoder = createLineDecoder<CaptureEnvelope>();
    reader.on("data", (chunk) => {
      for (const envelope of decoder.push(chunk)) {
        if (envelope === null) continue;
        recordCapturedEnvelope(deps.storage, cs.id, targetLabel, pending, envelope);
      }
    });
    reader.on("close", () => {
      captureReaders.delete(cs.id);
      capturePending.delete(cs.id);
    });
    reader.on("error", () => {
      // best-effort tap; the proxy keeps forwarding stdio regardless
    });

    deps.storage.events.append({
      kind: "capture.stdio_proxy.opened",
      payload: { captureSessionId: cs.id, targetLabel },
    });
    return c.json({ captureSession: cs, socketPath: attached.socketPath }, 201);
  });

  app.post("/api/v1/capture-sessions/:id/close", (c) => {
    const id = c.req.param("id");
    const cs = deps.storage.captureSessions.get(id);
    if (!cs) return c.json({ error: `unknown capture_session '${id}'` }, 404);
    captureReaders.get(id)?.destroy();
    captureReaders.delete(id);
    capturePending.delete(id);
    const ended = deps.storage.captureSessions.end(id);
    deps.storage.events.append({ kind: "capture.session.closed", payload: { captureSessionId: id } });
    return c.json({ captureSession: ended });
  });

  // Read endpoint: every JSON-RPC message captured for this session,
  // resolved from evidence back into the actual message content — what
  // the E2E test (and any future UI) asserts against.
  app.get("/api/v1/capture-sessions/:id/captured-messages", (c) => {
    const id = c.req.param("id");
    const cs = deps.storage.captureSessions.get(id);
    if (!cs) return c.json({ error: `unknown capture_session '${id}'` }, 404);
    const executions = deps.storage.executions.listForCaptureSession(id);
    const items = executions.map((execution) => {
      const rounds = deps.storage.rounds.listForExecution(execution.id);
      const evidence = deps.storage.evidence.listForExecution(execution.id).map((ev) => ({
        id: ev.id,
        kind: ev.kind,
        recordedAt: ev.recordedAt,
        message: JSON.parse(new TextDecoder().decode(deps.storage.artifacts.getBytes(ev.artifactRef))) as unknown,
      }));
      return { execution, rounds, evidence };
    });
    return c.json({ captureSession: cs, messages: items });
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

  // Phase M slice 3: capability -> handler symbol map (ingest contract only —
  // no repo checkout / symbol resolution here, see source-intelligence pkg).
  app.post("/api/v1/source/revisions/:id/index", async (c) => {
    const revisionId = c.req.param("id");
    const revision = deps.storage.sourceRevisions.get(revisionId);
    if (!revision) return c.json({ error: `unknown source_revision '${revisionId}'` }, 404);

    const body = (await c.req.json().catch(() => null)) as { entries?: unknown } | null;
    if (!body || !Array.isArray(body.entries) || body.entries.length === 0) {
      return c.json({ error: "'entries' (non-empty array) required" }, 400);
    }
    if (body.entries.length > 1_000) {
      return c.json({ error: "batch exceeds bounded default of 1,000 entries" }, 400);
    }

    const entries: SourceMappingEntry[] = [];
    for (let i = 0; i < body.entries.length; i++) {
      const parsed = parseSourceMappingEntry(body.entries[i], i);
      if (!parsed.ok) {
        return c.json({ error: parsed.error.message, index: parsed.error.index }, 400);
      }
      entries.push(parsed.entry);
    }

    const indexed = deps.storage.sourceMappings.indexBatch(revisionId, entries);
    deps.storage.events.append({
      kind: "source.capability.indexed",
      payload: {
        revisionId,
        count: indexed.length,
        capabilityIds: indexed.map((m) => m.capabilityId),
      },
    });
    return c.json({ indexed }, 201);
  });

  app.get("/api/v1/source/revisions/:id/capabilities/:capabilityId", (c) => {
    const revisionId = c.req.param("id");
    const capabilityId = c.req.param("capabilityId");
    const revision = deps.storage.sourceRevisions.get(revisionId);
    if (!revision) return c.json({ error: `unknown source_revision '${revisionId}'` }, 404);

    const mapping = deps.storage.sourceMappings.get(revisionId, capabilityId);
    if (!mapping) {
      return c.json(
        { error: `no source mapping for capability '${capabilityId}' at revision '${revisionId}'` },
        404,
      );
    }
    const snippet = mapping.snippet !== null ? trimSnippet(mapping.snippet, mapping.lineStart) : null;
    return c.json({ mapping, snippet });
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
    if (body.spans.length > 10_000) {
      return c.json({ error: "trace exceeds bounded default of 10,000 spans" }, 400);
    }
    const putInput: Parameters<typeof deps.storage.traces.put>[0] = {
      traceId: body.traceId,
      spans: body.spans,
    };
    // `source` is either the legacy free-text string (Phase M slice 1) or a
    // structured { executionId | agentRunId } that drives auto-linking
    // (Phase L slice 2). Either way it's preserved on the trace row.
    let linkExecutionId: string | undefined;
    let linkAgentRunId: string | undefined;
    if (typeof body.source === "string") {
      putInput.source = body.source;
    } else if (body.source && typeof body.source === "object" && !Array.isArray(body.source)) {
      const src = body.source as { executionId?: unknown; agentRunId?: unknown };
      if (typeof src.executionId === "string" && src.executionId.length > 0) {
        linkExecutionId = src.executionId;
      }
      if (typeof src.agentRunId === "string" && src.agentRunId.length > 0) {
        linkAgentRunId = src.agentRunId;
      }
      putInput.source = JSON.stringify(body.source);
    }
    const record = deps.storage.traces.put(putInput);

    if (linkExecutionId) {
      deps.storage.traces.linkExecution({
        traceId: record.traceId,
        executionId: linkExecutionId,
        kind: "w3c-trace",
        confidence: 1.0,
      });
    }
    if (linkAgentRunId) {
      deps.storage.traces.linkAgentRun({
        traceId: record.traceId,
        agentRunId: linkAgentRunId,
        kind: "w3c-trace",
        confidence: 1.0,
      });
    }
    // Late-link: any Execution already stashed with this traceId from a
    // traceparent header seen before this trace was ingested.
    for (const exec of deps.storage.executions.listByTraceId(record.traceId)) {
      deps.storage.traces.linkExecution({
        traceId: record.traceId,
        executionId: exec.id,
        kind: "w3c-trace",
        confidence: 1.0,
      });
    }

    deps.storage.events.append({
      kind: "trace.ingested",
      payload: { traceId: record.traceId, spanCount: record.spanCount, source: record.source },
    });
    return c.json({ trace: record }, 201);
  });

  // ---- MRTR + Tasks follow-up rounds (Phase G) ----

  app.post("/api/v1/executions/:id/rounds", (c) => appendRound(c, deps));

  // ---- Cancel + retry (Phase E slice 2B) ----

  app.post("/api/v1/executions/:id/cancel", (c) => {
    const id = c.req.param("id");
    const record = deps.storage.executions.get(id);
    if (!record) return c.json({ error: `unknown execution '${id}'` }, 404);
    if (!isInFlight(id)) {
      return c.json({ error: `execution '${id}' is not in flight` }, 409);
    }
    cancelExecution(id, "user");
    return c.json({ executionId: id, cancelling: true });
  });

  app.post("/api/v1/executions/:id/retry", async (c) => {
    const id = c.req.param("id");
    const source = deps.storage.executions.get(id);
    if (!source) return c.json({ error: `unknown execution '${id}'` }, 404);
    if (!deps.serverManager.getBinding(source.serverId)) {
      return c.json({ error: `server '${source.serverId}' not connected` }, 409);
    }
    const rounds = deps.storage.rounds.listForExecution(id);
    const lastRound = rounds[rounds.length - 1];
    if (!lastRound) {
      return c.json({ error: `execution '${id}' has no rounds to retry` }, 409);
    }
    const parsed = parseCapabilityId(source.capabilityId);
    if (!parsed) {
      return c.json({ error: `execution '${id}' has an unparseable capabilityId` }, 409);
    }
    const args = parseArgs(lastRound.argumentsJson);
    const execDeps = { adapter: deps.adapter, storage: deps.storage, serverManager: deps.serverManager };
    const metadata = { retriedFrom: id };

    let result: ExecuteResult;
    if (parsed.type === "tool") {
      result = await executeTool(execDeps, {
        serverId: parsed.serverId,
        name: parsed.name,
        arguments: args,
        metadata,
      });
    } else if (parsed.type === "resource") {
      result = await executeResourceRead(execDeps, { serverId: parsed.serverId, uri: parsed.name, metadata });
    } else if (parsed.type === "prompt") {
      const promptInput: ExecuteGetPromptInput = { serverId: parsed.serverId, name: parsed.name, metadata };
      if (Object.keys(args).length > 0) promptInput.arguments = args;
      result = await executeGetPrompt(execDeps, promptInput);
    } else {
      return c.json({ error: `unsupported capability type '${parsed.type}' for retry` }, 400);
    }

    return c.json({
      executionId: result.executionId,
      retriedFrom: id,
      ok: result.ok,
      value: result.value,
      error: result.error,
    });
  });

  // ---- Trace correlation reads (Phase L slice 2) ----

  app.get("/api/v1/executions/:id/traces", (c) => {
    const id = c.req.param("id");
    const execution = deps.storage.executions.get(id);
    if (!execution) return c.json({ error: `unknown execution '${id}'` }, 404);
    const links = deps.storage.traces.listForExecution(id);
    return c.json({
      traces: links.map((l) => ({
        trace: l.trace,
        correlationKind: l.correlationKind,
        confidence: l.correlationConfidence,
      })),
      ...(links.length === 0 ? { _note: "no correlated traces found for this execution" } : {}),
    });
  });

  app.get("/api/v1/agent-runs/:id/timeline", (c) => {
    const id = c.req.param("id");
    const agentRun = deps.storage.agentRuns.get(id);
    if (!agentRun) return c.json({ error: `unknown agent_run '${id}'` }, 404);
    const executions = deps.storage.executions.listForAgentRun(id);
    const traceLinks = deps.storage.traces.listForAgentRun(id);
    const traces = traceLinks.map((l) => ({ trace: l.trace, spans: l.trace.spans }));
    const overlay = buildAgentRunOverlay(executions, traceLinks);
    return c.json({
      agentRun,
      executions,
      traces,
      overlay,
      ...(traceLinks.length === 0
        ? { _note: "no correlated traces found for this agent_run" }
        : {}),
    });
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

function connectCaptureReader(socketPath: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = netConnect(socketPath);
    const onErr = (err: Error) => {
      socket.off("connect", onOk);
      reject(err);
    };
    const onOk = () => {
      socket.off("error", onErr);
      resolve(socket);
    };
    socket.once("error", onErr);
    socket.once("connect", onOk);
  });
}

/**
 * Persist one tapped JSON-RPC message into the same execution_round +
 * evidence infrastructure every other capture path uses. Requests are
 * buffered (per capture session) until their matching response arrives so
 * the pair lands as a single execution/round with both raw_request and
 * raw_response evidence — the shape the packet builder and UI already know
 * how to read. Notifications (no id, no response ever coming) get their
 * own one-shot execution immediately.
 */
function recordCapturedEnvelope(
  storage: Storage,
  captureSessionId: string,
  targetLabel: string,
  pending: Map<JsonRpcRequest["id"], { request: JsonRpcRequest; ts: number }>,
  envelope: CaptureEnvelope,
): void {
  const { message, ts } = envelope;

  if (isRequest(message)) {
    pending.set(message.id, { request: message, ts });
    return;
  }

  if (isResponse(message)) {
    // Per spec, an error response replying to an unparseable request may
    // carry id: null — there's nothing to pair it with in `pending`.
    const entry = message.id !== null ? pending.get(message.id) : undefined;
    if (entry && message.id !== null) pending.delete(message.id);
    const startedAtMs = entry?.ts ?? ts;
    const isError = "error" in message;

    const execution = storage.executions.create({
      serverId: targetLabel,
      capabilityId: entry ? entry.request.method : `response:${String(message.id)}`,
      captureSessionId,
      status: isError ? "error" : "complete",
    });

    const round = storage.rounds.append({
      executionId: execution.id,
      roundIndex: 0,
      kind: "initial",
      argumentsJson: entry ? JSON.stringify(entry.request.params ?? null) : null,
      resultInlineJson: isError ? null : JSON.stringify(message.result ?? null),
      errorJson: isError ? JSON.stringify(message.error) : null,
      durationMs: ts - startedAtMs,
      startedAt: new Date(startedAtMs).toISOString(),
      endedAt: new Date(ts).toISOString(),
    });

    if (entry) {
      const reqBlob = storage.artifacts.put({
        bytes: new TextEncoder().encode(JSON.stringify(entry.request)),
        mediaType: "application/json",
      });
      storage.evidence.append({
        executionId: execution.id,
        roundId: round.id,
        kind: "raw_request",
        artifactRef: reqBlob.hash,
      });
    }
    const respBlob = storage.artifacts.put({
      bytes: new TextEncoder().encode(JSON.stringify(message)),
      mediaType: "application/json",
    });
    storage.evidence.append({
      executionId: execution.id,
      roundId: round.id,
      kind: "raw_response",
      artifactRef: respBlob.hash,
    });
    storage.executions.updateStatus(execution.id, isError ? "error" : "complete", round.endedAt);
    return;
  }

  if (isNotification(message)) {
    const nowIso = new Date(ts).toISOString();
    const execution = storage.executions.create({
      serverId: targetLabel,
      capabilityId: message.method,
      captureSessionId,
      status: "complete",
    });
    const blob = storage.artifacts.put({
      bytes: new TextEncoder().encode(JSON.stringify(message)),
      mediaType: "application/json",
    });
    storage.evidence.append({ executionId: execution.id, kind: "notification", artifactRef: blob.hash });
    storage.executions.updateStatus(execution.id, "complete", nowIso);
  }
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

// ---- Large-payload rendering (ADR-0003 / Phase F slice 2) ----

const RENDER_PAGE_DEFAULT_LIMIT = 50;
const RENDER_PAGE_MAX_LIMIT = 1000;
// First-N rows/lines shown inline alongside artifactRef when a result spills.
const RENDER_PREVIEW_LIMIT = 20;

function clampRenderPageLimit(value: string | undefined): number {
  const n = value ? Number(value) : RENDER_PAGE_DEFAULT_LIMIT;
  if (!Number.isFinite(n) || n <= 0) return RENDER_PAGE_DEFAULT_LIMIT;
  return Math.min(RENDER_PAGE_MAX_LIMIT, Math.floor(n));
}

const RENDERER_KINDS = new Set(rendererRegistry.available());
function isRendererKind(value: string | undefined): value is RendererKind {
  return value !== undefined && RENDERER_KINDS.has(value as RendererKind);
}

export type RenderSurface =
  | { spilled: false; kind: RendererKind; value: unknown }
  | { spilled: true; kind: RendererKind; artifactRef: string; preview: RenderPageResult };

/**
 * Decides whether a tool-call/resource-read result is small enough to
 * inline or must spill to the artifact store. Spill happens BEFORE the
 * caller does anything renderer-facing with `value` — the only render call
 * made here is a bounded renderPage() over the first RENDER_PREVIEW_LIMIT
 * items, never a full render() of a payload that's already over threshold.
 *
 * When spilling, an array is stored as NDJSON (one element per line) so
 * GET /api/v1/artifacts/:sha/page can stream bounded windows without
 * parsing the whole thing; a non-array value falls back to pretty JSON
 * (still line-oriented, but pageable as raw lines only — no row cursor).
 */
export function buildRenderSurface(value: unknown, artifacts: Storage["artifacts"]): RenderSurface {
  const resultJson = JSON.stringify(value ?? null);
  const kind = rendererRegistry.suggest(value);
  const byteLen = Buffer.byteLength(resultJson, "utf8");
  if (byteLen <= renderInlineMaxBytes()) {
    return { spilled: false, kind, value };
  }
  const bytes = Array.isArray(value)
    ? new TextEncoder().encode(value.map((item) => JSON.stringify(item) ?? "null").join("\n"))
    : new TextEncoder().encode(JSON.stringify(value, null, 2) ?? "null");
  const mediaType = Array.isArray(value) ? "application/x-ndjson" : "application/json";
  const rec = artifacts.put({ bytes, mediaType });
  const preview = rendererRegistry.renderPage(value, { kind, offset: 0, limit: RENDER_PREVIEW_LIMIT });
  return { spilled: true, kind, artifactRef: rec.hash, preview };
}

// ---- Agent-run timeline overlay (Phase L slice 2) ----

type OverlayEntry =
  | { at: string; kind: "execution"; ref: { id: string; status: string; capabilityId: string; serverId: string } }
  | { at: string; kind: "span"; ref: { id: string; traceId: string; name?: string } };

interface SpanLike {
  spanId?: string;
  name?: string;
  startTimeUnixNano?: string | number;
}

function asSpanLike(value: unknown): SpanLike {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as SpanLike;
  }
  return {};
}

function spanStartIso(span: SpanLike, fallbackIso: string): string {
  const raw = span.startTimeUnixNano;
  if (raw === undefined) return fallbackIso;
  try {
    const nanos = typeof raw === "number" ? BigInt(Math.trunc(raw)) : BigInt(raw);
    const millis = Number(nanos / 1_000_000n);
    if (!Number.isFinite(millis)) return fallbackIso;
    return new Date(millis).toISOString();
  } catch {
    return fallbackIso;
  }
}

function buildAgentRunOverlay(executions: ExecutionRecord[], traceLinks: TraceLink[]): OverlayEntry[] {
  const overlay: OverlayEntry[] = [];
  for (const exec of executions) {
    overlay.push({
      at: exec.startedAt,
      kind: "execution",
      ref: { id: exec.id, status: exec.status, capabilityId: exec.capabilityId, serverId: exec.serverId },
    });
  }
  for (const { trace } of traceLinks) {
    const spans = Array.isArray(trace.spans) ? trace.spans : [];
    spans.forEach((raw, idx) => {
      const span = asSpanLike(raw);
      const ref: { id: string; traceId: string; name?: string } = {
        id: span.spanId ?? `${trace.traceId}:${idx}`,
        traceId: trace.traceId,
      };
      if (span.name !== undefined) ref.name = span.name;
      overlay.push({ at: spanStartIso(span, trace.ingestedAt), kind: "span", ref });
    });
  }
  overlay.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  return overlay;
}

// ---- MRTR + Tasks follow-up round handling (Phase G) ----

const RoundsBodySchema = z.object({
  inputResponses: z.record(z.string(), z.unknown()).optional(),
  taskAction: z.enum(["poll", "cancel"]).optional(),
});

interface RoundOutcomeInput {
  executionId: string;
  roundIndex: number;
  kind: RoundKind;
  argumentsJson: string;
  startedAt: Date;
  serverId: string;
  capabilityId: string;
  value: JsonValue;
  evidence: ProtocolEvidence;
}

interface RoundFailureInput {
  executionId: string;
  roundIndex: number;
  kind: RoundKind;
  argumentsJson: string;
  startedAt: Date;
  serverId: string;
  capabilityId: string;
  error: unknown;
}

function detectTaskShape(value: JsonValue): { taskId: string; status: string } | null {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const v = value as Record<string, JsonValue>;
    const taskId = v["taskId"];
    const status = v["status"];
    if (typeof taskId === "string" && typeof status === "string") return { taskId, status };
  }
  return null;
}

function recordRoundOutcome(
  deps: GatewayDeps,
  input: RoundOutcomeInput,
): { round: ExecutionRound; execution: ExecutionRecord; evidenceRow: EvidenceRef } {
  const endedAt = new Date();
  const isInputRequired = input.evidence.resultType === "input_required";
  const task = isInputRequired ? null : detectTaskShape(input.value);

  const resultPayload: JsonValue = isInputRequired
    ? {
        status: "input_required",
        requestState: (input.evidence.extensions?.["requestState"] ?? null) as JsonValue,
        inputRequests: (input.evidence.extensions?.["inputRequests"] ?? null) as JsonValue,
      }
    : ((input.value ?? null) as JsonValue);
  const resultJson = JSON.stringify(resultPayload);
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
    bytes: new TextEncoder().encode(JSON.stringify(input.evidence)),
    mediaType: "application/json",
  });
  const evidenceRow = deps.storage.evidence.append({
    executionId: input.executionId,
    kind: "raw_response",
    artifactRef: evidenceBlob.hash,
  });

  let status: string;
  let endedAtIso: string | null;
  let eventKind: string;
  if (isInputRequired) {
    status = "input_required";
    endedAtIso = null;
    eventKind = "execution.input_required";
  } else if (task?.status === "working") {
    status = "task_working";
    endedAtIso = null;
    eventKind = "execution.task_update";
  } else if (task?.status === "cancelled") {
    status = "cancelled";
    endedAtIso = endedAt.toISOString();
    eventKind = "execution.task_update";
  } else {
    status = "complete";
    endedAtIso = endedAt.toISOString();
    eventKind = "execution.complete";
  }

  const round = deps.storage.rounds.append({
    executionId: input.executionId,
    roundIndex: input.roundIndex,
    kind: input.kind,
    argumentsJson: input.argumentsJson,
    resultInlineJson: inlineResult,
    resultArtifact,
    durationMs: endedAt.getTime() - input.startedAt.getTime(),
    startedAt: input.startedAt.toISOString(),
    endedAt: endedAtIso,
  });
  const execution = deps.storage.executions.updateStatus(input.executionId, status, endedAtIso);
  deps.storage.events.append({
    executionId: input.executionId,
    kind: eventKind,
    payload: {
      serverId: input.serverId,
      capabilityId: input.capabilityId,
      status,
      durationMs: round.durationMs,
      evidenceRefs: [evidenceRow.id],
      resultInline: inlineResult !== null,
      resultArtifact,
    },
  });
  return { round, execution, evidenceRow };
}

function recordRoundFailure(deps: GatewayDeps, input: RoundFailureInput): void {
  const endedAt = new Date();
  const message = errMsg(input.error);
  deps.storage.rounds.append({
    executionId: input.executionId,
    roundIndex: input.roundIndex,
    kind: input.kind,
    argumentsJson: input.argumentsJson,
    errorJson: JSON.stringify({ message }),
    durationMs: endedAt.getTime() - input.startedAt.getTime(),
    startedAt: input.startedAt.toISOString(),
    endedAt: endedAt.toISOString(),
  });
  deps.storage.executions.updateStatus(input.executionId, "failed", endedAt.toISOString());
  deps.storage.events.append({
    executionId: input.executionId,
    kind: "execution.failed",
    payload: { serverId: input.serverId, capabilityId: input.capabilityId, error: message },
  });
}

function recoverRequestState(resultInlineJson: string | null): string | undefined {
  if (!resultInlineJson) return undefined;
  try {
    const parsed = JSON.parse(resultInlineJson) as { requestState?: unknown };
    return typeof parsed.requestState === "string" ? parsed.requestState : undefined;
  } catch {
    return undefined;
  }
}

function recoverTaskId(resultInlineJson: string | null): string | undefined {
  if (!resultInlineJson) return undefined;
  try {
    const parsed = JSON.parse(resultInlineJson) as { taskId?: unknown };
    return typeof parsed.taskId === "string" ? parsed.taskId : undefined;
  } catch {
    return undefined;
  }
}

async function appendRound(c: Context, deps: GatewayDeps): Promise<Response> {
  const id = c.req.param("id") as string;
  const execution = deps.storage.executions.get(id);
  if (!execution) return c.json({ error: `unknown execution '${id}'` }, 404);

  let body: z.infer<typeof RoundsBodySchema>;
  try {
    body = RoundsBodySchema.parse(await c.req.json().catch(() => ({})));
  } catch {
    return c.json({ error: "invalid body" }, 400);
  }

  const rounds = deps.storage.rounds.listForExecution(id);
  const lastRound = rounds[rounds.length - 1];
  if (!lastRound) return c.json({ error: `execution '${id}' has no rounds yet` }, 400);

  const sep = "::tool::";
  const sepIdx = execution.capabilityId.indexOf(sep);
  if (sepIdx === -1) {
    return c.json({ error: `execution '${id}' is not a tool-call execution` }, 400);
  }
  const toolName = execution.capabilityId.slice(sepIdx + sep.length);
  const serverId = execution.serverId;
  if (!deps.serverManager.getBinding(serverId)) {
    return c.json({ error: `server '${serverId}' not connected` }, 409);
  }
  const firstRound = rounds[0];
  const originalArgs = (
    firstRound?.argumentsJson ? JSON.parse(firstRound.argumentsJson) : {}
  ) as Record<string, unknown>;

  const startedAt = new Date();
  const roundIndex = rounds.length;

  if (execution.status === "input_required") {
    if (!body.inputResponses) {
      return c.json({ error: `execution '${id}' is awaiting inputResponses` }, 400);
    }
    const requestState = recoverRequestState(lastRound.resultInlineJson);
    if (!requestState) {
      return c.json({ error: `execution '${id}' has no recoverable requestState` }, 400);
    }
    try {
      const { value, evidence } = await deps.adapter.continueCall({
        serverId,
        name: toolName,
        arguments: originalArgs as JsonObject,
        requestState,
        inputResponses: body.inputResponses as Record<string, JsonValue>,
      });
      const outcome = recordRoundOutcome(deps, {
        executionId: id,
        roundIndex,
        kind: "input_response",
        argumentsJson: JSON.stringify(body.inputResponses),
        startedAt,
        serverId,
        capabilityId: execution.capabilityId,
        value,
        evidence,
      });
      return c.json({
        executionId: id,
        status: outcome.execution.status,
        value,
        evidence,
        inputRequests: evidence.extensions?.["inputRequests"] ?? null,
        round: outcome.round,
      });
    } catch (err) {
      recordRoundFailure(deps, {
        executionId: id,
        roundIndex,
        kind: "input_response",
        argumentsJson: JSON.stringify(body.inputResponses),
        startedAt,
        serverId,
        capabilityId: execution.capabilityId,
        error: err,
      });
      return c.json({ executionId: id, error: errMsg(err) }, 502);
    }
  }

  if (execution.status === "task_working") {
    if (!body.taskAction) {
      return c.json({ error: `execution '${id}' is a running task; pass taskAction` }, 400);
    }
    const taskId = recoverTaskId(lastRound.resultInlineJson);
    if (!taskId) {
      return c.json({ error: `execution '${id}' has no recoverable taskId` }, 400);
    }
    // R1: real Tasks-extension wire. `tasks/cancel` for cancel; `tasks/get`
    // for poll. Previously this branch re-invoked `tools/call` with
    // `{ ...originalArgs, taskId, cancel }` — a domain-layer simulation
    // that never spoke the extension wire and would never carry the
    // required `Mcp-Name: <taskId>` header on Streamable HTTP.
    const isCancel = body.taskAction === "cancel";
    const argsForEvidence: Record<string, JsonValue> = { taskAction: body.taskAction, taskId };
    try {
      const { value, evidence } = isCancel
        ? await deps.adapter.cancelTask({ serverId, taskId })
        : await deps.adapter.getTask({ serverId, taskId });
      const outcome = recordRoundOutcome(deps, {
        executionId: id,
        roundIndex,
        kind: "task_update",
        argumentsJson: JSON.stringify(argsForEvidence),
        startedAt,
        serverId,
        capabilityId: execution.capabilityId,
        value,
        evidence,
      });
      return c.json({
        executionId: id,
        status: outcome.execution.status,
        value,
        evidence,
        round: outcome.round,
      });
    } catch (err) {
      recordRoundFailure(deps, {
        executionId: id,
        roundIndex,
        kind: "task_update",
        argumentsJson: JSON.stringify(argsForEvidence),
        startedAt,
        serverId,
        capabilityId: execution.capabilityId,
        error: err,
      });
      return c.json({ executionId: id, error: errMsg(err) }, 502);
    }
  }

  return c.json(
    { error: `execution '${id}' is not resumable (status '${execution.status}')` },
    400,
  );
}
