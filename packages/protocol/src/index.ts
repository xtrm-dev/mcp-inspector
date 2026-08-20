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
  /**
   * Unix domain socket path for an already-spawned stdio MCP child. The
   * privileged runner owns the spawn (see ADR-0003); the gateway resolves
   * this via runner.spawnStdioMcp before calling connect().
   */
  socketPath?: string;
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
  /**
   * Resume an `input_required` MRTR round: re-invokes the same tool with
   * the caller's `inputResponses` plus a byte-exact echo of the opaque
   * `requestState` the server minted on the prior round. See the
   * top-of-file comment in sdk-adapter.ts for the verified SDK call shape.
   */
  continueCall(input: {
    serverId: string;
    name: string;
    arguments: JsonObject;
    requestState: string;
    inputResponses: Record<string, JsonValue>;
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
export const protocolAdapterContractVersion = 4 as const;

/**
 * Tasks extension key. Client opts in by advertising this in
 * `clientCapabilities.extensions`; server may then return
 * `resultType: 'task'` results carrying a taskId the consumer polls.
 *
 * ponytail: the installed @modelcontextprotocol/client@2.0.0 marks the
 * ENTIRE 2025-11-25 Task wire vocabulary (TaskCreationParamsSchema,
 * CreateTaskResultSchema, tasks/get, tasks/result, tasks/cancel,
 * tasks/list) `@deprecated ... no SDK runtime; kept importable for
 * interoperability only`, and the 2026-07-28 era registry has ZERO
 * task-related methods at all (verified against
 * node_modules/@modelcontextprotocol/client/dist/src-D_zzAWoS.mjs's
 * `rev2026-07-28/registry.ts` region — no `tasks/*` key). There is no
 * live wire-level task poll/get/cancel to call through this SDK version.
 * Phase G's Tasks lifecycle is therefore modeled at the gateway/domain
 * layer instead (apps/gateway/src/routes.ts): a task-shaped tool result
 * (`{taskId, status}`) drives Execution status + round persistence, and
 * "polling"/"cancelling" is an ordinary follow-up `tools/call` carrying
 * the taskId back to the same demo tool — not a raw `tasks/get` RPC.
 * Revisit if/when `@modelcontextprotocol/ext-tasks` (or a modern-era
 * Tasks vocabulary) ships.
 */
export const TASKS_EXTENSION_KEY = "io.modelcontextprotocol/tasks" as const;

export { createSdkAdapter } from "./sdk-adapter";
