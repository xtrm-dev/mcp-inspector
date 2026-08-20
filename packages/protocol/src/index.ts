export const MODERN_PROTOCOL_VERSION = "2026-07-28" as const;

export type ProtocolEra = "modern" | "legacy";
export type ProtocolEraPolicy = "auto" | ProtocolEra;
export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };
export type JsonSchema = Record<string, unknown>;

export interface ProtocolNegotiation {
  policy: ProtocolEraPolicy;
  negotiatedEra?: ProtocolEra;
  selectedVersion?: string;
  supportedVersions?: string[];
  discoverResult?: JsonObject;
  extensions?: Record<string, JsonValue>;
}

export interface McpServerDescriptor {
  id: string;
  displayName: string;
  transport: "streamable-http" | "stdio";
  url?: string;
  command?: string;
  protocol: ProtocolNegotiation;
  /**
   * Optional bearer token to send on every request. Resolved by the gateway
   * from a CredentialRef before connect; never persisted on the descriptor
   * itself and never surfaced back to callers.
   */
  bearerToken?: string;
}

export interface McpToolDefinition {
  name: string;
  title?: string;
  description?: string;
  inputSchema: JsonSchema;
  outputSchema?: JsonSchema;
  annotations?: Record<string, JsonValue>;
}

export interface ProtocolEvidence {
  era?: ProtocolEra;
  version?: string;
  requestId?: string | number;
  resultType?: "complete" | "input_required" | "task";
  requestMeta?: JsonObject;
  responseMeta?: JsonObject;
  httpHeaders?: Record<string, string>;
  traceparent?: string;
  tracestate?: string;
  baggage?: string;
  extensions?: Record<string, JsonValue>;
}

export interface McpResourceDefinition {
  uri: string;
  name?: string;
  title?: string;
  description?: string;
  mimeType?: string;
  annotations?: Record<string, JsonValue>;
}

export interface McpResourceTemplateDefinition {
  uriTemplate: string;
  name?: string;
  title?: string;
  description?: string;
  mimeType?: string;
  annotations?: Record<string, JsonValue>;
}

export interface McpResourceContent {
  uri: string;
  mimeType?: string;
  text?: string;
  blob?: string; // base64
}

export interface McpPromptArgumentDefinition {
  name: string;
  description?: string;
  required?: boolean;
}

export interface McpPromptDefinition {
  name: string;
  title?: string;
  description?: string;
  arguments?: McpPromptArgumentDefinition[];
}

export interface McpPromptMessage {
  role: string;
  content: JsonValue;
}

export interface McpClientAdapter {
  connect(server: McpServerDescriptor): Promise<ProtocolNegotiation>;
  listTools(serverId: string): Promise<McpToolDefinition[]>;
  callTool(input: {
    serverId: string;
    name: string;
    arguments: JsonObject;
    signal?: AbortSignal;
  }): Promise<{ value: JsonValue; evidence: ProtocolEvidence }>;
  listResources(serverId: string): Promise<McpResourceDefinition[]>;
  listResourceTemplates(serverId: string): Promise<McpResourceTemplateDefinition[]>;
  readResource(input: { serverId: string; uri: string }): Promise<{
    contents: McpResourceContent[];
    evidence: ProtocolEvidence;
  }>;
  listPrompts(serverId: string): Promise<McpPromptDefinition[]>;
  getPrompt(input: { serverId: string; name: string; arguments?: JsonObject }): Promise<{
    messages: McpPromptMessage[];
    description?: string;
    evidence: ProtocolEvidence;
  }>;
  disconnect(serverId: string): Promise<void>;
}

/**
 * Stable seam around the official MCP SDK. The live implementation is added only
 * after its modern-era behavior is covered by conformance tests; product layers
 * depend on this interface rather than SDK-specific lifecycle details.
 */
export const protocolAdapterContractVersion = 3 as const;

/**
 * Tasks extension key. Client opts in by advertising this in
 * `clientCapabilities.extensions`; server may then return
 * `resultType: 'task'` results carrying a taskId the consumer polls.
 *
 * ponytail: full poll/get/cancel lifecycle requires `@modelcontextprotocol/ext-tasks`
 * or re-declared wire schemas (SDK v2 deprecated the 2025 Task vocabulary
 * and does not ship modern Task types). This adapter advertises the
 * capability and surfaces incoming task results via evidence — polling
 * is deferred until the ext-tasks integration slice.
 */
export const TASKS_EXTENSION_KEY = "io.modelcontextprotocol/tasks" as const;

export { createSdkAdapter } from "./sdk-adapter";
