import {
  Client,
  StreamableHTTPClientTransport,
  isInputRequiredResult,
  type RequestMethod,
  type Transport,
} from "@modelcontextprotocol/client";
import {
  MODERN_PROTOCOL_VERSION,
  TASKS_EXTENSION_KEY,
  type JsonObject,
  type JsonValue,
  type McpClientAdapter,
  type McpPromptDefinition,
  type McpPromptMessage,
  type McpResourceContent,
  type McpResourceDefinition,
  type McpResourceTemplateDefinition,
  type McpServerDescriptor,
  type McpToolDefinition,
  type ProtocolEra,
  type ProtocolEvidence,
  type ProtocolNegotiation,
} from "./index";

interface Session {
  client: Client;
  transport: Transport;
}

const CLIENT_INFO = { name: "mcp-inspector-x", version: "0.0.0" } as const;

/**
 * Live @modelcontextprotocol/client v2 implementation of McpClientAdapter.
 *
 * Supports streamable-http (SDK-owned HTTP transport) and stdio (a UDS
 * transport over a socket the privileged runner already spawned the child
 * behind — see ADR-0003), tools/call plus MRTR continuation, evidence
 * populated from negotiated era + response _meta.
 *
 * ---
 * SDK-VERIFIED MRTR CONTINUATION CONTRACT (Phase G, mcp-inspector-moc.3)
 * ---
 * @modelcontextprotocol/client@2.0.0's typed `Client.callTool()` wrapper has
 * NO way to send `requestState` / `inputResponses` on retry — its params
 * type (`CallToolRequestParams`, dist/index-D4xIIEF6.d.mts:484) has no room
 * for either field. Verified directly: passing them to `callTool()` is a
 * compile error —
 *   TS2353: Object literal may only specify known properties, and
 *   'requestState' does not exist in type '{ name: string; _meta?: ...;
 *   task?: { ttl?: number | undefined; } | undefined; arguments?: ...; }'.
 * (reproduced against the installed package; see packages/protocol's
 * tsconfig — no local fixture needed, the SDK's own bundled .d.mts fails
 * the assignment.)
 *
 * The SDK's own docs for manual MRTR mode (`RequestOptions.allowInputRequired`,
 * dist/index-D4xIIEF6.d.mts:1828-1839) say the caller is "responsible for
 * gathering the requested input and retrying the original request with
 * `inputResponses` / `requestState` params and a fresh request" — that
 * "request" is the lower-level, loosely-typed generic overload of
 * `Protocol.request()` that `Client` inherits (dist/index-D4xIIEF6.d.mts:
 * 2222-2224 — `Client extends Protocol<ClientContext>`, declared 1889):
 *
 *   request<M extends RequestMethod>(request: {
 *     method: M;
 *     params?: Record<string, unknown>;
 *   }, options?: RequestOptions): Promise<ResultTypeMap[M]>;
 *
 * `params` there is an untyped `Record<string, unknown>` bag (unlike
 * `callTool`'s strict `CallToolRequestParams`), so it accepts
 * `requestState` / `inputResponses` alongside the normal `name` /
 * `arguments`. `continueCall()` below calls exactly this method:
 *
 *   client.request(
 *     { method: "tools/call", params: { name, arguments, requestState, inputResponses } },
 *     { allowInputRequired: true, signal },
 *   )
 *
 * verified by direct compilation against the installed
 * @modelcontextprotocol/client@2.0.0 package (node_modules/@modelcontextprotocol/client/package.json).
 *
 * ponytail: streaming/notifications, resources/prompts auth pass-through
 * remain deferred to later slices — extend McpClientAdapter (and bump
 * protocolAdapterContractVersion) when they land. Tasks lifecycle: see the
 * TASKS_EXTENSION_KEY doc comment in ./index — the installed SDK has no
 * wire-level task methods at all, so Tasks are modeled at the gateway
 * layer on top of ordinary tools/call, not through this adapter.
 */
export function createSdkAdapter(): McpClientAdapter {
  const sessions = new Map<string, Session>();

  const adapter: McpClientAdapter = {
    async connect(descriptor: McpServerDescriptor): Promise<ProtocolNegotiation> {
      if (descriptor.transport !== "streamable-http" && descriptor.transport !== "stdio") {
        throw new Error(
          `sdk-adapter: transport '${descriptor.transport}' not implemented yet`,
        );
      }
      if (sessions.has(descriptor.id)) {
        throw new Error(
          `sdk-adapter: session '${descriptor.id}' already connected; call disconnect first`,
        );
      }

      let transport: Transport;
      if (descriptor.transport === "streamable-http") {
        if (!descriptor.url) {
          throw new Error(
            `sdk-adapter: streamable-http descriptor '${descriptor.id}' requires 'url'`,
          );
        }
        const transportOpts: ConstructorParameters<typeof StreamableHTTPClientTransport>[1] = {};
        if (descriptor.bearerToken !== undefined) {
          const token = descriptor.bearerToken;
          transportOpts.authProvider = { token: async () => token };
        }
        transport = new StreamableHTTPClientTransport(new URL(descriptor.url), transportOpts);
      } else {
        // stdio: the child was already spawned by the privileged runner
        // (ADR-0003); we just speak line-delimited JSON-RPC over the UDS it
        // handed back.
        if (!descriptor.socketPath) {
          throw new Error(
            `sdk-adapter: stdio descriptor '${descriptor.id}' requires 'socketPath' (spawn via runner.spawnStdioMcp first)`,
          );
        }
        // Dynamic import keeps `node:net` out of apps/web's bundle — the
        // stdio branch is unreachable in the browser (browser never opens a
        // UDS descriptor) so this module is never loaded there.
        const { UdsLineTransport } = await import("./sdk-adapter-uds");
        transport = new UdsLineTransport(descriptor.socketPath);
      }

      const policy = descriptor.protocol.policy;
      const versionNegotiation =
        policy === "legacy"
          ? ({ mode: "legacy" } as const)
          : policy === "modern"
            ? ({ mode: { pin: MODERN_PROTOCOL_VERSION } } as const)
            : ({ mode: "auto" } as const);

      const client = new Client(CLIENT_INFO, {
        // Advertise:
        //   - elicitation.form → servers may return input_required results
        //   - tasks extension  → servers may return resultType='task' results
        // Manual mode on inputRequired: adapter surfaces the raw result on
        // evidence and lets the caller decide how to fulfil / poll.
        capabilities: {
          elicitation: { form: {} },
          extensions: { [TASKS_EXTENSION_KEY]: {} },
        },
        inputRequired: { autoFulfill: false },
        versionNegotiation,
      });

      try {
        await client.connect(transport);
      } catch (err) {
        await safeClose(client);
        throw err;
      }

      sessions.set(descriptor.id, { client, transport });

      const era = client.getProtocolEra() as ProtocolEra | undefined;
      const version = client.getNegotiatedProtocolVersion();
      const discover = client.getDiscoverResult() as JsonObject | undefined;
      const supported = extractSupportedVersions(discover);

      const negotiation: ProtocolNegotiation = { policy };
      if (era) negotiation.negotiatedEra = era;
      if (version) negotiation.selectedVersion = version;
      if (supported) negotiation.supportedVersions = supported;
      if (discover) negotiation.discoverResult = discover;
      return negotiation;
    },

    async listTools(serverId: string): Promise<McpToolDefinition[]> {
      const s = requireSession(sessions, serverId);
      const { tools } = await s.client.listTools();
      return (tools ?? []).map(toolToDefinition);
    },

    async callTool(input) {
      const s = requireSession(sessions, input.serverId);
      const callOpts: { signal?: AbortSignal; allowInputRequired: true } = {
        allowInputRequired: true,
      };
      if (input.signal) callOpts.signal = input.signal;
      const result = await s.client.callTool(
        { name: input.name, arguments: input.arguments as Record<string, unknown> },
        callOpts,
      );
      return toCallToolOutput(s.client, result);
    },

    async continueCall(input) {
      const s = requireSession(sessions, input.serverId);
      // See the top-of-file comment: callTool()'s typed params reject
      // requestState/inputResponses, so continuation goes through the
      // lower-level, loosely-typed Protocol.request() overload instead.
      const requestOpts: { signal?: AbortSignal; allowInputRequired: true } = {
        allowInputRequired: true,
      };
      if (input.signal) requestOpts.signal = input.signal;
      const result = await s.client.request(
        {
          method: "tools/call" as RequestMethod,
          params: {
            name: input.name,
            arguments: input.arguments,
            requestState: input.requestState,
            inputResponses: input.inputResponses,
          },
        },
        requestOpts,
      );
      return toCallToolOutput(s.client, result);
    },

    async listResources(serverId: string): Promise<McpResourceDefinition[]> {
      const s = requireSession(sessions, serverId);
      const { resources } = await s.client.listResources();
      return (resources ?? []).map(resourceToDefinition);
    },

    async listResourceTemplates(serverId: string): Promise<McpResourceTemplateDefinition[]> {
      const s = requireSession(sessions, serverId);
      const { resourceTemplates } = await s.client.listResourceTemplates();
      return (resourceTemplates ?? []).map(resourceTemplateToDefinition);
    },

    async readResource(input) {
      const s = requireSession(sessions, input.serverId);
      const result = await s.client.readResource({ uri: input.uri });
      const era = s.client.getProtocolEra() as ProtocolEra | undefined;
      const version = s.client.getNegotiatedProtocolVersion();
      const contents = (result.contents ?? []).map(contentToResourceContent);
      const evidence: ProtocolEvidence = { resultType: "complete" };
      if (era) evidence.era = era;
      if (version) evidence.version = version;
      const responseMeta = (result as { _meta?: unknown })._meta;
      if (isJsonObject(responseMeta)) evidence.responseMeta = responseMeta;
      return { contents, evidence };
    },

    async listPrompts(serverId: string): Promise<McpPromptDefinition[]> {
      const s = requireSession(sessions, serverId);
      const { prompts } = await s.client.listPrompts();
      return (prompts ?? []).map(promptToDefinition);
    },

    async getPrompt(input) {
      const s = requireSession(sessions, input.serverId);
      const result = await s.client.getPrompt({
        name: input.name,
        arguments: (input.arguments ?? {}) as Record<string, string>,
      });
      const era = s.client.getProtocolEra() as ProtocolEra | undefined;
      const version = s.client.getNegotiatedProtocolVersion();
      const messages: McpPromptMessage[] = (result.messages ?? []).map((m: unknown) => {
        const mm = m as { role?: string; content?: unknown };
        return { role: mm.role ?? "user", content: (mm.content ?? null) as JsonValue };
      });
      const evidence: ProtocolEvidence = { resultType: "complete" };
      if (era) evidence.era = era;
      if (version) evidence.version = version;
      const responseMeta = (result as { _meta?: unknown })._meta;
      if (isJsonObject(responseMeta)) evidence.responseMeta = responseMeta;
      const out: { messages: McpPromptMessage[]; description?: string; evidence: ProtocolEvidence } = {
        messages,
        evidence,
      };
      const description = (result as { description?: unknown }).description;
      if (typeof description === "string") out.description = description;
      return out;
    },

    async disconnect(serverId: string): Promise<void> {
      const s = sessions.get(serverId);
      if (!s) return;
      sessions.delete(serverId);
      await safeClose(s.client);
    },
  };

  return adapter;
}

/**
 * Shared `callTool`/`continueCall` result → McpClientAdapter output mapping.
 * Both entry points invoke the SDK with `allowInputRequired: true` and get
 * back the same neutral `CallToolResult | InputRequiredResult` union, so the
 * era/evidence/task/MRTR classification only needs to live once.
 */
function toCallToolOutput(
  client: Client,
  result: unknown,
): { value: JsonValue; evidence: ProtocolEvidence } {
  const era = client.getProtocolEra() as ProtocolEra | undefined;
  const version = client.getNegotiatedProtocolVersion();
  const responseMeta = (result as { _meta?: unknown })._meta;

  // Tasks extension: SDK v2 removed core Task types (deprecated
  // 2025-11-25 vocabulary) so we detect the modern task result by its
  // string discriminant. Full poll/get/cancel lifecycle requires
  // @modelcontextprotocol/ext-tasks (not installed) — see #5.
  // ponytail: taskId + status surfaced via evidence; consumer polls externally.
  const rawResultType = (result as { resultType?: unknown }).resultType;
  if (rawResultType === "task") {
    const r = result as { taskId?: unknown; status?: unknown };
    const extensions: Record<string, JsonValue> = {};
    if (typeof r.taskId === "string") extensions["taskId"] = r.taskId;
    if (typeof r.status === "string") extensions["status"] = r.status;
    const evidence: ProtocolEvidence = { resultType: "task" };
    if (era) evidence.era = era;
    if (version) evidence.version = version;
    if (isJsonObject(responseMeta)) evidence.responseMeta = responseMeta;
    if (Object.keys(extensions).length > 0) evidence.extensions = extensions;
    return { value: null, evidence };
  }

  if (isInputRequiredResult(result)) {
    // MRTR: value is null (no tool value yet); consumer inspects
    // extensions to fulfil the embedded requests and retry.
    const extensions: Record<string, JsonValue> = {};
    if (result.inputRequests !== undefined) {
      extensions["inputRequests"] = result.inputRequests as unknown as JsonValue;
    }
    if (result.requestState !== undefined) {
      extensions["requestState"] = result.requestState;
    }
    const evidence: ProtocolEvidence = { resultType: "input_required" };
    if (era) evidence.era = era;
    if (version) evidence.version = version;
    if (isJsonObject(responseMeta)) evidence.responseMeta = responseMeta;
    if (Object.keys(extensions).length > 0) evidence.extensions = extensions;
    return { value: null, evidence };
  }

  const value = normalizeResult(result);
  const evidence: ProtocolEvidence = { resultType: "complete" };
  if (era) evidence.era = era;
  if (version) evidence.version = version;
  if (isJsonObject(responseMeta)) evidence.responseMeta = responseMeta;
  return { value, evidence };
}

function requireSession(sessions: Map<string, Session>, serverId: string): Session {
  const s = sessions.get(serverId);
  if (!s) {
    throw new Error(
      `sdk-adapter: no session for serverId '${serverId}' (call connect first)`,
    );
  }
  return s;
}

async function safeClose(client: Client): Promise<void> {
  try {
    await client.close();
  } catch {
    // Client.close() throws if never connected; swallow to preserve caller error.
  }
}

function extractSupportedVersions(discover: JsonObject | undefined): string[] | undefined {
  if (!discover) return undefined;
  const raw = discover["supportedProtocolVersions"];
  if (!Array.isArray(raw)) return undefined;
  const versions = raw.filter((v): v is string => typeof v === "string");
  return versions.length > 0 ? versions : undefined;
}

function resourceToDefinition(r: unknown): McpResourceDefinition {
  const o = r as Record<string, unknown>;
  const def: McpResourceDefinition = { uri: String(o["uri"] ?? "") };
  if (typeof o["name"] === "string") def.name = o["name"];
  if (typeof o["title"] === "string") def.title = o["title"];
  if (typeof o["description"] === "string") def.description = o["description"];
  if (typeof o["mimeType"] === "string") def.mimeType = o["mimeType"];
  if (isJsonObject(o["annotations"])) def.annotations = o["annotations"] as Record<string, JsonValue>;
  return def;
}

function resourceTemplateToDefinition(r: unknown): McpResourceTemplateDefinition {
  const o = r as Record<string, unknown>;
  const def: McpResourceTemplateDefinition = { uriTemplate: String(o["uriTemplate"] ?? "") };
  if (typeof o["name"] === "string") def.name = o["name"];
  if (typeof o["title"] === "string") def.title = o["title"];
  if (typeof o["description"] === "string") def.description = o["description"];
  if (typeof o["mimeType"] === "string") def.mimeType = o["mimeType"];
  if (isJsonObject(o["annotations"])) def.annotations = o["annotations"] as Record<string, JsonValue>;
  return def;
}

function contentToResourceContent(c: unknown): McpResourceContent {
  const o = c as Record<string, unknown>;
  const out: McpResourceContent = { uri: String(o["uri"] ?? "") };
  if (typeof o["mimeType"] === "string") out.mimeType = o["mimeType"];
  if (typeof o["text"] === "string") out.text = o["text"];
  if (typeof o["blob"] === "string") out.blob = o["blob"];
  return out;
}

function promptToDefinition(p: unknown): McpPromptDefinition {
  const o = p as Record<string, unknown>;
  const def: McpPromptDefinition = { name: String(o["name"] ?? "") };
  if (typeof o["title"] === "string") def.title = o["title"];
  if (typeof o["description"] === "string") def.description = o["description"];
  const args = o["arguments"];
  if (Array.isArray(args)) {
    def.arguments = args.map((a): McpPromptDefinition["arguments"] extends (infer T)[] | undefined ? T : never => {
      const ao = a as Record<string, unknown>;
      const out: { name: string; description?: string; required?: boolean } = {
        name: String(ao["name"] ?? ""),
      };
      if (typeof ao["description"] === "string") out.description = ao["description"];
      if (typeof ao["required"] === "boolean") out.required = ao["required"];
      return out as never;
    });
  }
  return def;
}

function toolToDefinition(t: unknown): McpToolDefinition {
  const o = t as Record<string, unknown>;
  const def: McpToolDefinition = {
    name: String(o["name"] ?? ""),
    inputSchema: (isJsonObject(o["inputSchema"]) ? o["inputSchema"] : {}) as Record<string, unknown>,
  };
  if (typeof o["title"] === "string") def.title = o["title"];
  if (typeof o["description"] === "string") def.description = o["description"];
  if (isJsonObject(o["outputSchema"])) {
    def.outputSchema = o["outputSchema"] as Record<string, unknown>;
  }
  if (isJsonObject(o["annotations"])) {
    def.annotations = o["annotations"] as Record<string, JsonValue>;
  }
  return def;
}

function normalizeResult(result: unknown): JsonValue {
  const r = result as { structuredContent?: unknown; content?: unknown };
  if (r.structuredContent !== undefined) return r.structuredContent as JsonValue;
  const content = r.content;
  if (!Array.isArray(content) || content.length === 0) return null;
  if (content.length === 1) return contentBlockToJson(content[0]);
  return content.map(contentBlockToJson);
}

function contentBlockToJson(block: unknown): JsonValue {
  if (!block || typeof block !== "object") return (block as JsonValue) ?? null;
  const b = block as { type?: unknown; text?: unknown };
  if (b.type === "text" && typeof b.text === "string") return b.text;
  return block as JsonValue;
}

function isJsonObject(v: unknown): v is JsonObject {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}
