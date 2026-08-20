/**
 * Wire types for /api/v1/*.
 *
 * Where the shape already exists as a real, merged storage/protocol type we
 * import it (type-only — erased at build time, no runtime cost). Where the
 * shape comes from a PR that hasn't merged into this branch's base yet
 * (#42 trace correlation, #44 MRTR rounds, #45 cancel/retry, #37/#40
 * renderer registry + artifact paging), we hand-write it here against the
 * documented contract in the task brief + the sibling worktrees that carry
 * those PRs (read for shape only, not imported).
 */
import type {
  JsonObject,
  JsonSchema,
  JsonValue,
  McpPromptArgumentDefinition,
  McpPromptDefinition,
  McpPromptMessage,
  McpResourceContent,
  McpResourceDefinition,
  McpResourceTemplateDefinition,
  McpToolDefinition,
  ProtocolEvidence,
  ProtocolNegotiation,
} from "@mcp-inspector-x/protocol";
import type {
  AgentRun,
  CaptureSession,
  CredentialProvider,
  CredentialRef,
  EvidenceRef,
  ExecutionRecord,
  ExecutionRound,
  SourceRevision,
  Transport,
  TraceRecord,
  Workspace as WorkspaceRow,
  WorkspaceNode as WorkspaceNodeRow,
  WorkspaceNodePresentation,
} from "@mcp-inspector-x/storage";

export type {
  JsonObject,
  JsonSchema,
  JsonValue,
  McpPromptArgumentDefinition,
  McpPromptDefinition,
  McpPromptMessage,
  McpResourceContent,
  McpResourceDefinition,
  McpResourceTemplateDefinition,
  McpToolDefinition,
  ProtocolEvidence,
  ProtocolNegotiation,
  AgentRun,
  CaptureSession,
  CredentialProvider,
  CredentialRef,
  EvidenceRef,
  ExecutionRecord,
  ExecutionRound,
  SourceRevision,
  Transport,
  WorkspaceRow,
  WorkspaceNodeRow,
  WorkspaceNodePresentation,
};

// ---- Servers ----

export interface ServerSummary {
  id: string;
  displayName: string;
  transport: Transport;
  endpoint: string | null;
  protocolPolicy: "auto" | "modern" | "legacy";
  disabled: boolean;
  createdAt: string;
  updatedAt: string;
  connected: boolean;
  negotiation: ProtocolNegotiation | null;
}

export interface CreateServerInput {
  id?: string;
  displayName: string;
  transport: Transport;
  endpoint?: string | null;
  command?: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  protocolPolicy?: "auto" | "modern" | "legacy";
  disabled?: boolean;
  credentialRefId?: string | null;
  connectNow?: boolean;
}

export type UpdateServerInput = Partial<Omit<CreateServerInput, "id" | "connectNow">>;

export interface ConnectResult {
  connected: boolean;
  negotiation?: ProtocolNegotiation | null;
  error?: string;
}

export interface TestConnectionResult {
  ok: boolean;
  [key: string]: JsonValue | boolean | undefined;
}

// ---- Execution envelope shared by tool call / resource read / prompt get ----

export interface EvidenceRefSummary {
  id: string;
  kind: string;
  artifactRef: string;
}

export interface SourceHint {
  revisionId: string;
  filePath: string;
  symbol: string | null;
  lineStart: number | null;
  lineEnd: number | null;
}

export interface ExecutionEnvelope {
  executionId: string;
  value?: JsonValue;
  contents?: McpResourceContent[];
  messages?: McpPromptMessage[];
  description?: string;
  evidence: ProtocolEvidence;
  evidenceRefs?: EvidenceRefSummary[];
  suggestedRenderer?: RendererKind;
  sourceHint?: SourceHint | null;
  error?: string;
}

// ---- Executions / rounds / rounds continuation (MRTR, PR #44) ----

export interface ExecutionDetail {
  execution: ExecutionRecord;
  rounds: ExecutionRound[];
  evidence: EvidenceRef[];
}

export interface AppendRoundInput {
  inputResponses?: Record<string, JsonValue>;
  taskAction?: "poll" | "cancel";
}

export interface AppendRoundResult {
  executionId: string;
  status: string;
  value: JsonValue;
  evidence: ProtocolEvidence;
  round: ExecutionRound;
  error?: string;
}

// ---- Cancel / retry (PR #45) ----

export interface CancelResult {
  executionId: string;
  cancelling: boolean;
  error?: string;
}

export interface RetryResult {
  executionId: string;
  retriedFrom: string;
  ok: boolean;
  value?: JsonValue;
  error?: string;
}

export interface CompareResult {
  left: ExecutionDetail["execution"];
  right: ExecutionDetail["execution"];
  [key: string]: JsonValue | ExecutionDetail["execution"];
}

// ---- Workspaces ----

export interface CreateWorkspaceInput {
  id?: string;
  name: string;
  layoutJson?: string;
}

export interface UpdateWorkspaceInput {
  name?: string;
  layoutJson?: string;
}

export interface CreateWorkspaceNodeInput {
  id?: string;
  serverId?: string | null;
  capabilityId?: string | null;
  argumentsJson?: string | null;
  presentation?: WorkspaceNodePresentation;
  position?: number;
}

export type UpdateWorkspaceNodeInput = CreateWorkspaceNodeInput;

export interface RunWorkspaceInput {
  nodeIds?: string[];
  concurrency?: number;
}

export interface WorkspaceRunResult {
  runId: string;
  workspaceId: string;
  captureSessionId: string;
  agentRunId: string;
  concurrency: number;
  nodes: Array<{
    nodeId: string;
    capabilityId: string | null;
    executionId?: string;
    ok: boolean;
    skippedReason?: string;
    error?: string;
    durationMs?: number;
  }>;
}

// ---- Traces + agent-run timeline (PR #42) ----

export type CorrelationKind = "w3c-trace" | "inspector-run" | "protocol" | "inference";

export interface TraceLinkSummary {
  trace: TraceRecord;
  correlationKind: CorrelationKind;
  confidence: number;
}

export interface ExecutionTracesResult {
  traces: TraceLinkSummary[];
  _note?: string;
}

export type TimelineOverlayEntry =
  | { at: string; kind: "execution"; ref: { id: string; status: string; capabilityId: string; serverId: string } }
  | { at: string; kind: "span"; ref: { id: string; traceId: string; name?: string } };

export interface AgentRunTimeline {
  agentRun: AgentRun;
  executions: ExecutionRecord[];
  traces: Array<{ trace: TraceRecord; spans: unknown }>;
  overlay: TimelineOverlayEntry[];
  _note?: string;
}

// ---- Renderers (PR #37 + #40) ----

export type RendererKind =
  | "json-tree"
  | "json-formatted"
  | "json-raw"
  | "table"
  | "toon"
  | "csv"
  | "tsv"
  | "ndjson"
  | "text"
  | "mcp-content-block";

/** supportsShape is a function on the server type and does not survive JSON. */
export interface RendererDescriptor {
  kind: RendererKind;
  label: string;
  mimeHint?: string;
}

export interface ArtifactPage {
  artifactRef: string;
  offset: number;
  limit: number;
  hasMore: boolean;
  lines: string[];
  kind?: RendererKind;
  rows?: unknown[][];
  columns?: string[];
}

// ---- Investigation packets ----

export type PacketTier = "compact" | "investigation" | "exhaustive";
export type PacketFormat = "json" | "markdown";

export interface BuildPacketInput {
  executionIds: string[];
  tier?: PacketTier;
  format?: PacketFormat;
  packetId?: string;
}

export interface InvestigationPacket {
  id: string;
  tier: PacketTier;
  [key: string]: JsonValue | string;
}

// ---- Credentials ----

export interface CreateCredentialInput {
  id?: string;
  provider: CredentialProvider;
  key: string;
  scope?: string | null;
}

// ---- Source revisions ----

export interface RegisterSourceRevisionInput {
  repositoryRef: string;
  revisionHash: string;
  branch?: string;
  shortSha?: string;
  metadata?: JsonValue;
}
