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
  resultType?: "complete" | "input_required";
  requestMeta?: JsonObject;
  responseMeta?: JsonObject;
  httpHeaders?: Record<string, string>;
  traceparent?: string;
  tracestate?: string;
  baggage?: string;
  extensions?: Record<string, JsonValue>;
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
  disconnect(serverId: string): Promise<void>;
}

/**
 * Stable seam around the official MCP SDK. The live implementation is added only
 * after its modern-era behavior is covered by conformance tests; product layers
 * depend on this interface rather than SDK-specific lifecycle details.
 */
export const protocolAdapterContractVersion = 1 as const;

export { createSdkAdapter } from "./sdk-adapter";
