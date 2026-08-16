import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import {
  MODERN_PROTOCOL_VERSION,
  type JsonObject,
  type JsonValue,
  type McpClientAdapter,
  type McpServerDescriptor,
  type McpToolDefinition,
  type ProtocolEra,
  type ProtocolEvidence,
  type ProtocolNegotiation,
} from "./index";

interface Session {
  client: Client;
  transport: StreamableHTTPClientTransport;
}

const CLIENT_INFO = { name: "mcp-inspector-x", version: "0.0.0" } as const;

/**
 * Live @modelcontextprotocol/client v2 implementation of McpClientAdapter.
 *
 * Slice-1 scope (per epic in issue): streamable-http only, single-round
 * tools/call, evidence populated from negotiated era + response _meta.
 *
 * ponytail: stdio, MRTR/input_required, Tasks extension, streaming/notifications,
 * resources/prompts, auth pass-through are deferred to later slices — extend the
 * McpClientAdapter interface (and bump protocolAdapterContractVersion) when they land.
 */
export function createSdkAdapter(): McpClientAdapter {
  const sessions = new Map<string, Session>();

  const adapter: McpClientAdapter = {
    async connect(descriptor: McpServerDescriptor): Promise<ProtocolNegotiation> {
      if (descriptor.transport !== "streamable-http") {
        throw new Error(
          `sdk-adapter: transport '${descriptor.transport}' not implemented yet`,
        );
      }
      if (!descriptor.url) {
        throw new Error(
          `sdk-adapter: streamable-http descriptor '${descriptor.id}' requires 'url'`,
        );
      }
      if (sessions.has(descriptor.id)) {
        throw new Error(
          `sdk-adapter: session '${descriptor.id}' already connected; call disconnect first`,
        );
      }

      const policy = descriptor.protocol.policy;
      const versionNegotiation =
        policy === "legacy"
          ? ({ mode: "legacy" } as const)
          : policy === "modern"
            ? ({ mode: { pin: MODERN_PROTOCOL_VERSION } } as const)
            : ({ mode: "auto" } as const);

      const transport = new StreamableHTTPClientTransport(new URL(descriptor.url));
      const client = new Client(CLIENT_INFO, {
        capabilities: {},
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
      const result = await s.client.callTool(
        { name: input.name, arguments: input.arguments as Record<string, unknown> },
        input.signal ? { signal: input.signal } : {},
      );

      const value = normalizeResult(result);
      const era = s.client.getProtocolEra() as ProtocolEra | undefined;
      const version = s.client.getNegotiatedProtocolVersion();
      const responseMeta = (result as { _meta?: unknown })._meta;

      const evidence: ProtocolEvidence = { resultType: "complete" };
      if (era) evidence.era = era;
      if (version) evidence.version = version;
      if (isJsonObject(responseMeta)) evidence.responseMeta = responseMeta;
      return { value, evidence };
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
