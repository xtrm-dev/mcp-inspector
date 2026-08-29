/**
 * Thin typed fetch client for /api/v1/*. One function per endpoint from the
 * documented contract (see task brief). No retry/caching layer — ponytail:
 * a query-cache lib (react-query et al.) would be the natural upgrade if
 * pages start re-fetching the same data a lot; not needed for this slice's
 * page count.
 */
import type {
  AgentRun,
  AgentRunTimeline,
  AppendRoundInput,
  AppendRoundResult,
  ArtifactPage,
  BuildPacketInput,
  CancelResult,
  CaptureSession,
  CompareResult,
  ConnectResult,
  CreateCredentialInput,
  CreateServerInput,
  CreateWorkspaceInput,
  CreateWorkspaceNodeInput,
  CredentialRef,
  ExecutionDetail,
  ExecutionEnvelope,
  ExecutionRecord,
  ExecutionTracesResult,
  InvestigationPacket,
  JsonObject,
  McpPromptDefinition,
  McpResourceDefinition,
  McpResourceTemplateDefinition,
  McpToolDefinition,
  RegisterSourceRevisionInput,
  RendererDescriptor,
  RetryResult,
  RunWorkspaceInput,
  ServerDetail,
  ServerSummary,
  SourceRevision,
  UpdateServerInput,
  UpdateWorkspaceInput,
  UpdateWorkspaceNodeInput,
  WorkspaceNodeRow,
  WorkspaceRow,
  WorkspaceRunResult,
} from "./types";

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: unknown,
  ) {
    super(
      `API ${status}: ${
        body && typeof body === "object" && "error" in body ? String((body as { error: unknown }).error) : String(body)
      }`,
    );
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
  const isJson = res.headers.get("content-type")?.includes("application/json") ?? false;
  const body: unknown = isJson ? await res.json().catch(() => null) : await res.text();
  if (!res.ok) throw new ApiError(res.status, body);
  return body as T;
}

const json = (body: unknown): RequestInit => ({ method: "POST", body: JSON.stringify(body) });
const patchJson = (body: unknown): RequestInit => ({ method: "PATCH", body: JSON.stringify(body) });

// ---- Servers ----

export const listServers = (): Promise<{ servers: ServerSummary[] }> => request("/api/v1/servers");
export const getServer = (id: string): Promise<{ server: ServerDetail }> =>
  request(`/api/v1/servers/${encodeURIComponent(id)}`);
export const createServer = (
  input: CreateServerInput,
): Promise<{ server: ServerSummary; connected: boolean; negotiation: unknown }> =>
  request("/api/v1/servers", json(input));
export const updateServer = (id: string, input: UpdateServerInput): Promise<{ server: ServerSummary }> =>
  request(`/api/v1/servers/${encodeURIComponent(id)}`, patchJson(input));
export const deleteServer = (id: string): Promise<{ ok: true }> =>
  request(`/api/v1/servers/${encodeURIComponent(id)}`, { method: "DELETE" });
export const connectServer = (id: string): Promise<ConnectResult> =>
  request(`/api/v1/servers/${encodeURIComponent(id)}/connect`, { method: "POST" });
export const disconnectServer = (id: string): Promise<{ connected: false }> =>
  request(`/api/v1/servers/${encodeURIComponent(id)}/disconnect`, { method: "POST" });
export const testServerConnection = (id: string): Promise<Record<string, unknown>> =>
  request(`/api/v1/servers/${encodeURIComponent(id)}/test-connection`, { method: "POST" });

// ---- Capabilities (tools / resources / prompts) ----

export const listTools = (serverId: string): Promise<{ tools: McpToolDefinition[] }> =>
  request(`/api/v1/servers/${encodeURIComponent(serverId)}/tools`);
export const listResources = (
  serverId: string,
): Promise<{ resources: McpResourceDefinition[]; resourceTemplates: McpResourceTemplateDefinition[] }> =>
  request(`/api/v1/servers/${encodeURIComponent(serverId)}/resources`);
export const listPrompts = (serverId: string): Promise<{ prompts: McpPromptDefinition[] }> =>
  request(`/api/v1/servers/${encodeURIComponent(serverId)}/prompts`);

/** Fetches tools + resources + prompts in one call — the "capabilities" surface for a server. */
export async function getServerCapabilities(serverId: string): Promise<{
  tools: McpToolDefinition[];
  resources: McpResourceDefinition[];
  resourceTemplates: McpResourceTemplateDefinition[];
  prompts: McpPromptDefinition[];
}> {
  const [tools, resources, prompts] = await Promise.all([
    listTools(serverId).catch(() => ({ tools: [] })),
    listResources(serverId).catch(() => ({ resources: [], resourceTemplates: [] })),
    listPrompts(serverId).catch(() => ({ prompts: [] })),
  ]);
  return { ...tools, ...resources, ...prompts };
}

// ---- Execution: call tool / read resource / get prompt ----

export const callTool = (
  serverId: string,
  name: string,
  toolArguments: JsonObject,
): Promise<ExecutionEnvelope> =>
  request(`/api/v1/servers/${encodeURIComponent(serverId)}/tools/${encodeURIComponent(name)}/call`, json({ arguments: toolArguments }));

export const readResource = (serverId: string, uri: string): Promise<ExecutionEnvelope> =>
  request(`/api/v1/servers/${encodeURIComponent(serverId)}/resources/read`, json({ uri }));

export const getPrompt = (
  serverId: string,
  name: string,
  promptArguments?: JsonObject,
): Promise<ExecutionEnvelope> =>
  request(
    `/api/v1/servers/${encodeURIComponent(serverId)}/prompts/${encodeURIComponent(name)}/get`,
    json(promptArguments ? { arguments: promptArguments } : {}),
  );

// ---- Executions / rounds / cancel / retry / compare ----

export const listExecutions = (opts?: { limit?: number; capabilityId?: string }): Promise<{ executions: ExecutionRecord[] }> => {
  const params = new URLSearchParams();
  if (opts?.limit !== undefined) params.set("limit", String(opts.limit));
  if (opts?.capabilityId !== undefined) params.set("capabilityId", opts.capabilityId);
  const qs = params.toString();
  return request(`/api/v1/executions${qs ? `?${qs}` : ""}`);
};
export const getExecution = (id: string): Promise<ExecutionDetail> =>
  request(`/api/v1/executions/${encodeURIComponent(id)}`);
export const appendRound = (id: string, input: AppendRoundInput): Promise<AppendRoundResult> =>
  request(`/api/v1/executions/${encodeURIComponent(id)}/rounds`, json(input));
export const cancelExecutionApi = (id: string): Promise<CancelResult> =>
  request(`/api/v1/executions/${encodeURIComponent(id)}/cancel`, { method: "POST" });
export const retryExecutionApi = (id: string): Promise<RetryResult> =>
  request(`/api/v1/executions/${encodeURIComponent(id)}/retry`, { method: "POST" });
export const compareExecutionsApi = (leftId: string, rightId: string): Promise<CompareResult> =>
  request("/api/v1/executions/compare", json({ leftId, rightId }));
export const getExecutionTraces = (id: string): Promise<ExecutionTracesResult> =>
  request(`/api/v1/executions/${encodeURIComponent(id)}/traces`);

// ---- Workspaces ----

export const listWorkspaces = (): Promise<{ workspaces: WorkspaceRow[] }> => request("/api/v1/workspaces");
export const createWorkspace = (input: CreateWorkspaceInput): Promise<{ workspace: WorkspaceRow }> =>
  request("/api/v1/workspaces", json(input));
export const getWorkspace = (id: string): Promise<{ workspace: WorkspaceRow; nodes: WorkspaceNodeRow[] }> =>
  request(`/api/v1/workspaces/${encodeURIComponent(id)}`);
export const updateWorkspace = (id: string, input: UpdateWorkspaceInput): Promise<{ workspace: WorkspaceRow }> =>
  request(`/api/v1/workspaces/${encodeURIComponent(id)}`, patchJson(input));
export const deleteWorkspace = (id: string): Promise<{ ok: true }> =>
  request(`/api/v1/workspaces/${encodeURIComponent(id)}`, { method: "DELETE" });

export const createWorkspaceNode = (
  workspaceId: string,
  input: CreateWorkspaceNodeInput,
): Promise<{ node: WorkspaceNodeRow }> =>
  request(`/api/v1/workspaces/${encodeURIComponent(workspaceId)}/nodes`, json(input));
export const updateWorkspaceNode = (
  workspaceId: string,
  nodeId: string,
  input: UpdateWorkspaceNodeInput,
): Promise<{ node: WorkspaceNodeRow }> =>
  request(
    `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/nodes/${encodeURIComponent(nodeId)}`,
    patchJson(input),
  );
export const deleteWorkspaceNode = (workspaceId: string, nodeId: string): Promise<{ ok: true }> =>
  request(`/api/v1/workspaces/${encodeURIComponent(workspaceId)}/nodes/${encodeURIComponent(nodeId)}`, {
    method: "DELETE",
  });
export const reorderWorkspaceNodes = (
  workspaceId: string,
  orderedIds: string[],
): Promise<{ nodes: WorkspaceNodeRow[] }> =>
  request(`/api/v1/workspaces/${encodeURIComponent(workspaceId)}/nodes/reorder`, json({ orderedIds }));

export const runWorkspaceApi = (workspaceId: string, input: RunWorkspaceInput): Promise<WorkspaceRunResult> =>
  request(`/api/v1/workspaces/${encodeURIComponent(workspaceId)}/run`, json(input));

// ---- Agent runs + timeline ----

export const listAgentRuns = (opts?: { limit?: number }): Promise<{ agentRuns: AgentRun[] }> => {
  const params = new URLSearchParams();
  if (opts?.limit !== undefined) params.set("limit", String(opts.limit));
  const qs = params.toString();
  return request(`/api/v1/agent-runs${qs ? `?${qs}` : ""}`);
};
export const getAgentRun = (id: string): Promise<{ agentRun: AgentRun; executions: ExecutionRecord[] }> =>
  request(`/api/v1/agent-runs/${encodeURIComponent(id)}`);
export const getAgentRunTimeline = (id: string): Promise<AgentRunTimeline> =>
  request(`/api/v1/agent-runs/${encodeURIComponent(id)}/timeline`);

export const listCaptureSessions = (opts?: { limit?: number }): Promise<{ captureSessions: CaptureSession[] }> => {
  const params = new URLSearchParams();
  if (opts?.limit !== undefined) params.set("limit", String(opts.limit));
  const qs = params.toString();
  return request(`/api/v1/capture-sessions${qs ? `?${qs}` : ""}`);
};

// ---- Renderers + artifact paging ----

export const listRenderers = (): Promise<{ renderers: RendererDescriptor[] }> => request("/api/v1/renderers");
export const getArtifactPage = (
  sha: string,
  opts?: { offset?: number; limit?: number; kind?: string },
): Promise<ArtifactPage> => {
  const params = new URLSearchParams();
  if (opts?.offset !== undefined) params.set("offset", String(opts.offset));
  if (opts?.limit !== undefined) params.set("limit", String(opts.limit));
  if (opts?.kind !== undefined) params.set("kind", opts.kind);
  const qs = params.toString();
  return request(`/api/v1/artifacts/${encodeURIComponent(sha)}/page${qs ? `?${qs}` : ""}`);
};

// ---- Investigation packets ----

export const buildInvestigationPacket = (
  input: BuildPacketInput,
): Promise<{ packet: InvestigationPacket } | string> => {
  const format = input.format ?? "json";
  if (format === "markdown") {
    return fetch("/api/v1/packets/build", { ...json(input), headers: { "content-type": "application/json" } }).then(
      async (res) => {
        const text = await res.text();
        if (!res.ok) throw new ApiError(res.status, text);
        return text;
      },
    );
  }
  return request("/api/v1/packets/build", json(input));
};

// ---- Credentials ----

export const listCredentials = (): Promise<{ credentials: CredentialRef[] }> => request("/api/v1/credentials");
export const createCredential = (input: CreateCredentialInput): Promise<{ credentialRef: CredentialRef }> =>
  request("/api/v1/credentials", json(input));
export const deleteCredential = (id: string): Promise<{ ok: true }> =>
  request(`/api/v1/credentials/${encodeURIComponent(id)}`, { method: "DELETE" });

// ---- Source revisions ----

export const registerSourceRevision = (
  input: RegisterSourceRevisionInput,
): Promise<{ sourceRevision: SourceRevision }> => request("/api/v1/source/revisions", json(input));
export const listSourceRevisions = (opts?: { repositoryRef?: string; limit?: number }): Promise<{
  sourceRevisions: SourceRevision[];
}> => {
  const params = new URLSearchParams();
  if (opts?.repositoryRef !== undefined) params.set("repositoryRef", opts.repositoryRef);
  if (opts?.limit !== undefined) params.set("limit", String(opts.limit));
  const qs = params.toString();
  return request(`/api/v1/source/revisions${qs ? `?${qs}` : ""}`);
};

export const getSourceGraph = (
  revisionId: string,
): Promise<import("./types").SourceGraphResponse> =>
  request(`/api/v1/source/revisions/${encodeURIComponent(revisionId)}/graph`);

export const getSourceCode = (
  revisionId: string,
  filePath: string,
  handlerSymbol: string,
): Promise<import("./types").SourceCodeResponse> => {
  const params = new URLSearchParams({ filePath, handlerSymbol });
  return request(
    `/api/v1/source/revisions/${encodeURIComponent(revisionId)}/code?${params.toString()}`,
  );
};

// ---- Config ----

export const getConfig = (): Promise<{ apiVersion: string; capabilities: Record<string, boolean> }> =>
  request("/api/v1/config");
