import { runConcurrent } from "@mcp-inspector-x/execution";
import type { JsonObject, McpClientAdapter } from "@mcp-inspector-x/protocol";
import type { Storage, WorkspaceNode } from "@mcp-inspector-x/storage";
import type { ServerManager } from "./servers";

// Same inline threshold as the tool-call route. Keep in one place so future
// tuning applies uniformly.
const INLINE_RESULT_LIMIT = 16 * 1024;

// Bounded concurrency envelope. Real workspaces are dozens of nodes, not
// hundreds — 8 is enough headroom that fan-out completes fast, and small
// enough that a single misbehaving server doesn't starve the runtime.
export const MAX_CONCURRENCY = 8;
export const DEFAULT_CONCURRENCY = 4;

// ---- W3C traceparent parsing (Phase L slice 2) ----
//
// Format: "<version>-<trace-id>-<parent-id>-<trace-flags>", each field
// lowercase hex, '-' separated. https://www.w3.org/TR/trace-context/
// Malformed input is never an error for the caller: this returns null and
// the caller silently proceeds without a traceId (ADR-0002).
const TRACEPARENT_RE =
  /^[0-9a-f]{2}-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/;
const ALL_ZERO_TRACE_ID = "0".repeat(32);
const ALL_ZERO_SPAN_ID = "0".repeat(16);

export interface ParsedTraceparent {
  version: string;
  traceId: string;
  spanId: string;
  flags: string;
}

export function parseTraceparent(header: string | null | undefined): ParsedTraceparent | null {
  if (!header) return null;
  try {
    const trimmed = header.trim();
    if (!TRACEPARENT_RE.test(trimmed)) {
      console.debug("[traceparent] malformed header ignored");
      return null;
    }
    const parts = trimmed.split("-");
    const version = parts[0]!;
    const traceId = parts[1]!;
    const spanId = parts[2]!;
    const flags = parts[3]!;
    if (traceId === ALL_ZERO_TRACE_ID || spanId === ALL_ZERO_SPAN_ID) {
      console.debug("[traceparent] all-zero trace/span id ignored");
      return null;
    }
    return { version, traceId, spanId, flags };
  } catch {
    console.debug("[traceparent] malformed header ignored");
    return null;
  }
}

export interface ExecutorDeps {
  adapter: McpClientAdapter;
  storage: Storage;
  serverManager: ServerManager;
}

export interface ExecuteToolInput {
  serverId: string;
  name: string;
  arguments: Record<string, unknown>;
  workspaceId?: string;
  workspaceNodeId?: string;
  captureSessionId?: string;
  agentRunId?: string;
}

export interface ExecuteResult {
  executionId: string;
  ok: boolean;
  value?: unknown;
  evidence?: unknown;
  evidenceRefs?: Array<{ id: string; kind: string; artifactRef: string }>;
  error?: string;
  durationMs: number;
}

/**
 * Execute a tool call end-to-end: create Execution, dispatch through the SDK
 * adapter, capture rounds + evidence + events, close Execution. Returns a
 * discriminated result so /run can aggregate without letting one failure
 * propagate out.
 */
export async function executeTool(
  deps: ExecutorDeps,
  input: ExecuteToolInput,
): Promise<ExecuteResult> {
  const capabilityId = `${input.serverId}::tool::${input.name}`;
  const createExecInput: Parameters<typeof deps.storage.executions.create>[0] = {
    serverId: input.serverId,
    capabilityId,
  };
  if (input.workspaceId !== undefined) createExecInput.workspaceId = input.workspaceId;
  if (input.workspaceNodeId !== undefined) createExecInput.workspaceNodeId = input.workspaceNodeId;
  if (input.captureSessionId !== undefined) createExecInput.captureSessionId = input.captureSessionId;
  if (input.agentRunId !== undefined) createExecInput.agentRunId = input.agentRunId;
  const execution = deps.storage.executions.create(createExecInput);

  const payload: Record<string, unknown> = {
    serverId: input.serverId,
    capabilityId,
    name: input.name,
    arguments: input.arguments,
  };
  if (input.workspaceId !== undefined) payload["workspaceId"] = input.workspaceId;
  if (input.workspaceNodeId !== undefined) payload["workspaceNodeId"] = input.workspaceNodeId;
  deps.storage.events.append({
    executionId: execution.id,
    kind: "execution.created",
    payload,
  });

  const startedAt = new Date();
  try {
    const { value, evidence } = await deps.adapter.callTool({
      serverId: input.serverId,
      name: input.name,
      arguments: input.arguments as JsonObject,
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
      argumentsJson: JSON.stringify(input.arguments),
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
      payload: {
        serverId: input.serverId,
        capabilityId,
        durationMs: round.durationMs,
        evidenceRefs: [evidenceRow.id],
      },
    });

    return {
      executionId: execution.id,
      ok: true,
      value,
      evidence,
      evidenceRefs: [
        { id: evidenceRow.id, kind: evidenceRow.kind, artifactRef: evidenceRow.artifactRef },
      ],
      durationMs: endedAt.getTime() - startedAt.getTime(),
    };
  } catch (err) {
    const endedAt = new Date();
    const message = err instanceof Error ? err.message : String(err);
    deps.storage.rounds.append({
      executionId: execution.id,
      roundIndex: 0,
      kind: "initial",
      argumentsJson: JSON.stringify(input.arguments),
      errorJson: JSON.stringify({ message }),
      durationMs: endedAt.getTime() - startedAt.getTime(),
      startedAt: startedAt.toISOString(),
      endedAt: endedAt.toISOString(),
    });
    deps.storage.executions.updateStatus(execution.id, "failed", endedAt.toISOString());
    deps.storage.events.append({
      executionId: execution.id,
      kind: "execution.failed",
      payload: { serverId: input.serverId, capabilityId, error: message },
    });
    return {
      executionId: execution.id,
      ok: false,
      error: message,
      durationMs: endedAt.getTime() - startedAt.getTime(),
    };
  }
}

// ---- Workspace run orchestration ----

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

export interface RunWorkspaceInput {
  workspaceId: string;
  runId: string;
  nodeIds?: string[];
  concurrency?: number;
}

export async function runWorkspace(
  deps: ExecutorDeps,
  input: RunWorkspaceInput,
): Promise<WorkspaceRunResult> {
  const allNodes = deps.storage.workspaceNodes.listForWorkspace(input.workspaceId);
  const targetIds = new Set(input.nodeIds ?? allNodes.map((n) => n.id));
  const nodes = allNodes.filter((n) => targetIds.has(n.id));
  const concurrency = clampConcurrency(input.concurrency);

  // Auto-open a CaptureSession + AgentRun so every Execution in this run is
  // walkable as one causal group. Correlation kind is 'inspector-run' —
  // this run originates in the Inspector itself, not from an outside agent.
  const captureSession = deps.storage.captureSessions.create({
    kind: "workspace-run",
    metadata: { workspaceId: input.workspaceId, runId: input.runId },
  });
  const agentRun = deps.storage.agentRuns.create({
    captureSessionId: captureSession.id,
    correlationKind: "inspector-run",
    correlationKey: input.runId,
    metadata: { workspaceId: input.workspaceId, runId: input.runId },
  });

  deps.storage.events.append({
    kind: "workspace.run.started",
    payload: {
      workspaceId: input.workspaceId,
      runId: input.runId,
      captureSessionId: captureSession.id,
      agentRunId: agentRun.id,
      nodeCount: nodes.length,
      concurrency,
    },
  });

  const envelopes = await runConcurrent(
    nodes,
    async (node) => dispatchNode(deps, input.workspaceId, input.runId, node, captureSession.id, agentRun.id),
    concurrency,
  );
  const results = envelopes.map((env, i) => {
    if (env.ok) return env.value;
    const node = nodes[i]!;
    return {
      nodeId: node.id,
      capabilityId: node.capabilityId,
      ok: false,
      error: env.error instanceof Error ? env.error.message : String(env.error),
    };
  });

  deps.storage.agentRuns.end(agentRun.id);
  deps.storage.captureSessions.end(captureSession.id);
  deps.storage.events.append({
    kind: "workspace.run.finished",
    payload: {
      workspaceId: input.workspaceId,
      runId: input.runId,
      captureSessionId: captureSession.id,
      agentRunId: agentRun.id,
      okCount: results.filter((r) => r.ok).length,
      failCount: results.filter((r) => !r.ok && r.skippedReason === undefined).length,
      skippedCount: results.filter((r) => r.skippedReason !== undefined).length,
    },
  });

  return {
    runId: input.runId,
    workspaceId: input.workspaceId,
    captureSessionId: captureSession.id,
    agentRunId: agentRun.id,
    concurrency,
    nodes: results,
  };
}

async function dispatchNode(
  deps: ExecutorDeps,
  workspaceId: string,
  runId: string,
  node: WorkspaceNode,
  captureSessionId: string,
  agentRunId: string,
): Promise<WorkspaceRunResult["nodes"][number]> {
  const base = { nodeId: node.id, capabilityId: node.capabilityId };

  if (!node.capabilityId) {
    return { ...base, ok: false, skippedReason: "unbound-capability" };
  }
  const parsed = parseCapabilityId(node.capabilityId);
  if (!parsed) {
    return { ...base, ok: false, skippedReason: "invalid-capability-id" };
  }
  if (parsed.type !== "tool") {
    // Resource + prompt dispatch in a workspace run land with Phase E slice 2B.
    return { ...base, ok: false, skippedReason: `unsupported-type:${parsed.type}` };
  }
  if (!deps.serverManager.getBinding(parsed.serverId)) {
    return { ...base, ok: false, skippedReason: "server-not-connected" };
  }

  const args = parseArgs(node.argumentsJson);
  deps.storage.events.append({
    kind: "workspace.run.node.started",
    payload: { workspaceId, runId, nodeId: node.id, capabilityId: node.capabilityId },
  });

  const executeInput: ExecuteToolInput = {
    serverId: parsed.serverId,
    name: parsed.name,
    arguments: args,
    workspaceId,
    workspaceNodeId: node.id,
    captureSessionId,
    agentRunId,
  };
  const r = await executeTool(deps, executeInput);
  deps.storage.events.append({
    kind: r.ok ? "workspace.run.node.complete" : "workspace.run.node.failed",
    payload: {
      workspaceId,
      runId,
      nodeId: node.id,
      executionId: r.executionId,
      ok: r.ok,
      error: r.error,
    },
  });
  const out: WorkspaceRunResult["nodes"][number] = {
    ...base,
    executionId: r.executionId,
    ok: r.ok,
    durationMs: r.durationMs,
  };
  if (r.error !== undefined) out.error = r.error;
  return out;
}

function parseCapabilityId(
  id: string,
): { serverId: string; type: string; name: string } | null {
  const parts = id.split("::");
  if (parts.length < 3) return null;
  const [serverId, type, ...rest] = parts;
  if (!serverId || !type || rest.length === 0) return null;
  return { serverId, type, name: rest.join("::") };
}

function parseArgs(json: string | null): Record<string, unknown> {
  if (json === null) return {};
  try {
    const parsed = JSON.parse(json);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // fall through — treat as empty
  }
  return {};
}

export function clampConcurrency(n: number | undefined): number {
  if (n === undefined) return DEFAULT_CONCURRENCY;
  if (!Number.isFinite(n)) return DEFAULT_CONCURRENCY;
  const int = Math.floor(n);
  if (int < 1) return 1;
  if (int > MAX_CONCURRENCY) return MAX_CONCURRENCY;
  return int;
}
