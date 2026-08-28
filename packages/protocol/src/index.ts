import type { OAuthClientProvider } from "@modelcontextprotocol/client";

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
  /**
   * Live OAuth client provider (see ./oauth.ts) for a streamable-http
   * server whose auth is OAuth-managed rather than a static bearer token.
   * Set instead of `bearerToken`, never both. The adapter passes it
   * straight through to the SDK transport's `authProvider` option, which
   * drives the SDK's own 401→refresh retry for the lifetime of the
   * connection.
   */
  oauthProvider?: OAuthClientProvider;
  /**
   * Additional static HTTP request headers sent with every request to a
   * streamable-http MCP server. Populated from resolved credential-ref
   * values by the gateway at connect time — never persisted raw in the
   * descriptor's owner (see ServerDefinition.headerCredentials). Header
   * NAMES are treated as plain strings; header VALUES are secrets and
   * are registered with SecretsRegistry.known() for redaction.
   *
   * Coexists with `bearerToken` (SDK auth flow) and `oauthProvider`
   * (SDK OAuth flow); those cover Authorization: Bearer specifically,
   * while this seam covers non-Bearer schemes real MCP servers use
   * (e.g. X-API-Key, X-Mercury-*). Ignored for stdio.
   */
  customHeaders?: Record<string, string>;
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
   * `requestState` the server minted on the prior round.
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
  /**
   * Tasks extension (`io.modelcontextprotocol/tasks`, MCP `2026-07-28`).
   * Poll a server-issued task handle. Wire: JSON-RPC method `tasks/get`,
   * params `{ taskId }`. Over Streamable HTTP the request MUST carry
   * `Mcp-Method: tasks/get` and `Mcp-Name: <taskId>` per the extension.
   * Response envelope carries `status` in {`working` | `input_required`
   * | `completed` | `failed` | `cancelled`}, and — when `completed` — a
   * `result` shaped like a normal `tools/call` return.
   *
   * `tasks/list` and `tasks/result` are HISTORICAL. Adapter implementations
   * MUST NOT emit them; strict servers reject them.
   */
  getTask(input: {
    serverId: string;
    taskId: string;
    signal?: AbortSignal;
  }): Promise<{ value: JsonValue; evidence: ProtocolEvidence }>;
  /**
   * Tasks extension: provide `inputResponses` (and a byte-exact echo of
   * `requestState`) to a task whose current status is `input_required`.
   * Wire: JSON-RPC method `tasks/update`, params
   * `{ taskId, inputResponses?, requestState? }`. Not blocked by SDK #2598.
   */
  updateTask(input: {
    serverId: string;
    taskId: string;
    inputResponses?: Record<string, JsonValue>;
    requestState?: string;
    signal?: AbortSignal;
  }): Promise<{ value: JsonValue; evidence: ProtocolEvidence }>;
  /**
   * Tasks extension: request server-side task cancellation. Wire:
   * JSON-RPC method `tasks/cancel`, params `{ taskId }`. Distinct from
   * transport-level cancellation (SSE close on HTTP; `notifications/cancelled`
   * on stdio).
   */
  cancelTask(input: {
    serverId: string;
    taskId: string;
    signal?: AbortSignal;
  }): Promise<{ value: JsonValue; evidence: ProtocolEvidence }>;
  disconnect(serverId: string): Promise<void>;
}

/**
 * Stable seam around the official MCP SDK. The live implementation is added only
 * after its modern-era behavior is covered by conformance tests; product layers
 * depend on this interface rather than SDK-specific lifecycle details.
 *
 * v4 (R1): getTask / updateTask / cancelTask added for the Tasks extension
 * raw-wire path. Callers previously polled tasks by re-invoking the same
 * `tools/call` with `{ taskId, cancel }` in arguments; that was a domain-layer
 * simulation, not the extension wire. The new methods speak `tasks/get`,
 * `tasks/update`, `tasks/cancel` directly.
 */
export const protocolAdapterContractVersion = 4 as const;

/**
 * Tasks extension key. Client opts in by advertising this in
 * `clientCapabilities.extensions`; server may then return
 * `resultType: 'task'` results carrying a taskId the consumer polls via
 * the Tasks extension methods on `McpClientAdapter`
 * (`getTask` / `updateTask` / `cancelTask`).
 */
export const TASKS_EXTENSION_KEY = "io.modelcontextprotocol/tasks" as const;

/**
 * Historical Tasks methods that MUST NOT be sent to a modern
 * `2026-07-28` server. The extension replaces `tasks/list` and the
 * blocking `tasks/result` with `tasks/get` (poll one) and status
 * carried in the `tasks/get` response envelope.
 */
export const HISTORICAL_TASK_METHODS = ["tasks/list", "tasks/result"] as const;

export { createSdkAdapter } from "./sdk-adapter";
export {
  createOAuthClientProvider,
  runOAuthFlow,
  followAuthorizationRedirect,
  type OAuthPersistedState,
  type OAuthStateStore,
  type CreateOAuthClientProviderOptions,
} from "./oauth";
