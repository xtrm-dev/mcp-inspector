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
  // Retry lineage, stored on the new Execution row as { retriedFrom: id }.
  metadata?: unknown;
  // External abort — from a per-run AbortController (workspace /run). This
  // call also always registers its own controller in the `inFlight` map
  // below under the new Execution id, so POST /executions/:id/cancel works
  // independently of whether a caller signal was passed in. Forwarded to
  // the SDK client's per-request signal; see the callTool() comment for the
  // SDK wiring citation.
  signal?: AbortSignal;
}

export interface ExecuteResult {
  executionId: string;
  ok: boolean;
  value?: unknown;
  evidence?: unknown;
  evidenceRefs?: Array<{ id: string; kind: string; artifactRef: string }>;
  error?: string;
  cancelled?: boolean;
  durationMs: number;
}

// ---- In-flight cancellation registry ----
//
// Keyed by Execution id so POST /executions/:id/cancel (routes.ts) can find
// the AbortController for a call that is mid-flight and abort it. A tool
// call's own controller also links to any caller-supplied `signal` (e.g. a
// per-run AbortController from workspace /run) so either source cancels it.
// ponytail: process-local Map — fine for a single-gateway-process deployment;
// swap for a durable registry if the gateway ever runs multi-process.
const inFlight = new Map<string, AbortController>();

/** Abort the in-flight tool call for `executionId`, if any is registered. */
export function cancelExecution(executionId: string, reason: string): boolean {
  const controller = inFlight.get(executionId);
  if (!controller) return false;
  controller.abort(reason);
  return true;
}

export function isInFlight(executionId: string): boolean {
  return inFlight.has(executionId);
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
  if (input.metadata !== undefined) createExecInput.metadata = input.metadata;
  const execution = deps.storage.executions.create(createExecInput);

  const payload: Record<string, unknown> = {
    serverId: input.serverId,
    capabilityId,
    name: input.name,
    arguments: input.arguments,
  };
  if (input.workspaceId !== undefined) payload["workspaceId"] = input.workspaceId;
  if (input.workspaceNodeId !== undefined) payload["workspaceNodeId"] = input.workspaceNodeId;
  if (input.metadata !== undefined) payload["metadata"] = input.metadata;
  deps.storage.events.append({
    executionId: execution.id,
    kind: "execution.created",
    payload,
  });

  // Own AbortController per call, registered under the Execution id so
  // POST /executions/:id/cancel (routes.ts) can find and abort it. If the
  // caller also passed a signal (e.g. workspace /run's per-run controller),
  // link the two so either source cancels this call.
  const controller = new AbortController();
  if (input.signal) {
    if (input.signal.aborted) controller.abort(input.signal.reason);
    else input.signal.addEventListener("abort", () => controller.abort(input.signal!.reason), { once: true });
  }
  inFlight.set(execution.id, controller);

  const startedAt = new Date();
  try {
    // RequestOptions.signal (node_modules/@modelcontextprotocol/client/dist/
    // index-D4xIIEF6.d.mts:1807 — "Can be used to cancel an in-flight
    // request. This will cause an AbortError to be raised from
    // Protocol.request()") is threaded through by sdk-adapter.ts:141-147
    // (`callOpts.signal`) into `Client.callTool()`, which extends
    // RequestOptions per index.d.mts:1807. That's the mechanism this
    // controller's signal rides on.
    const { value, evidence } = await deps.adapter.callTool({
      serverId: input.serverId,
      name: input.name,
      arguments: input.arguments as JsonObject,
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
    const durationMs = endedAt.getTime() - startedAt.getTime();

    // Cancellation provenance (ADR-0003 §17.5): a round transitioning to
    // cancelled records *which* round (this one, roundIndex 0 — MRTR rounds
    // land in a later slice) and *by what* — the abort reason passed to
    // controller.abort() by the cancel route ("user") or a future caller
    // ("timeout", etc). Distinct code path from an ordinary tool failure.
    if (controller.signal.aborted) {
      const cancelledBy =
        typeof controller.signal.reason === "string" ? controller.signal.reason : "unknown";
      deps.storage.rounds.append({
        executionId: execution.id,
        roundIndex: 0,
        kind: "initial",
        argumentsJson: JSON.stringify(input.arguments),
        errorJson: JSON.stringify({ cancelled: true, cancelledBy }),
        durationMs,
        startedAt: startedAt.toISOString(),
        endedAt: endedAt.toISOString(),
      });
      deps.storage.executions.updateStatus(execution.id, "cancelled", endedAt.toISOString());
      deps.storage.events.append({
        executionId: execution.id,
        kind: "execution.cancelled",
        payload: { serverId: input.serverId, capabilityId, cancelledBy },
      });
      return {
        executionId: execution.id,
        ok: false,
        cancelled: true,
        error: `cancelled by ${cancelledBy}`,
        durationMs,
      };
    }

    const message = err instanceof Error ? err.message : String(err);
    deps.storage.rounds.append({
      executionId: execution.id,
      roundIndex: 0,
      kind: "initial",
      argumentsJson: JSON.stringify(input.arguments),
      errorJson: JSON.stringify({ message }),
      durationMs,
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
      durationMs,
    };
  } finally {
    inFlight.delete(execution.id);
  }
}

// ---- Resource read / prompt get (dispatch + retry share these) ----
//
// Structurally mirror executeTool (create Execution, dispatch through the
// adapter, capture round + evidence + events, close Execution) so
// dispatchNode and the retry route can treat all three capability types
// uniformly. No cancellation signal here: McpClientAdapter.readResource /
// getPrompt don't accept one (only callTool does — see ExecuteToolInput),
// and the bead scope for this slice is tool-call cancellation only.

export interface ExecuteResourceInput {
  serverId: string;
  uri: string;
  workspaceId?: string;
  workspaceNodeId?: string;
  captureSessionId?: string;
  agentRunId?: string;
  metadata?: unknown;
}

export async function executeResourceRead(
  deps: ExecutorDeps,
  input: ExecuteResourceInput,
): Promise<ExecuteResult> {
  const capabilityId = `${input.serverId}::resource::${input.uri}`;
  const createExecInput: Parameters<typeof deps.storage.executions.create>[0] = {
    serverId: input.serverId,
    capabilityId,
  };
  if (input.workspaceId !== undefined) createExecInput.workspaceId = input.workspaceId;
  if (input.workspaceNodeId !== undefined) createExecInput.workspaceNodeId = input.workspaceNodeId;
  if (input.captureSessionId !== undefined) createExecInput.captureSessionId = input.captureSessionId;
  if (input.agentRunId !== undefined) createExecInput.agentRunId = input.agentRunId;
  if (input.metadata !== undefined) createExecInput.metadata = input.metadata;
  const execution = deps.storage.executions.create(createExecInput);

  const payload: Record<string, unknown> = { serverId: input.serverId, capabilityId, uri: input.uri };
  if (input.metadata !== undefined) payload["metadata"] = input.metadata;
  deps.storage.events.append({ executionId: execution.id, kind: "execution.created", payload });

  const startedAt = new Date();
  try {
    const { contents, evidence } = await deps.adapter.readResource({
      serverId: input.serverId,
      uri: input.uri,
    });
    const endedAt = new Date();
    const durationMs = endedAt.getTime() - startedAt.getTime();

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
      argumentsJson: JSON.stringify({ uri: input.uri }),
      resultInlineJson: inlineResult,
      resultArtifact,
      durationMs,
      startedAt: startedAt.toISOString(),
      endedAt: endedAt.toISOString(),
    });
    deps.storage.executions.updateStatus(execution.id, "complete", endedAt.toISOString());
    deps.storage.events.append({
      executionId: execution.id,
      kind: "execution.complete",
      payload: { serverId: input.serverId, capabilityId, evidenceRefs: [evidenceRow.id] },
    });
    return {
      executionId: execution.id,
      ok: true,
      value: contents,
      evidence,
      evidenceRefs: [{ id: evidenceRow.id, kind: evidenceRow.kind, artifactRef: evidenceRow.artifactRef }],
      durationMs,
    };
  } catch (err) {
    const endedAt = new Date();
    const durationMs = endedAt.getTime() - startedAt.getTime();
    const message = err instanceof Error ? err.message : String(err);
    deps.storage.rounds.append({
      executionId: execution.id,
      roundIndex: 0,
      kind: "initial",
      argumentsJson: JSON.stringify({ uri: input.uri }),
      errorJson: JSON.stringify({ message }),
      durationMs,
      startedAt: startedAt.toISOString(),
      endedAt: endedAt.toISOString(),
    });
    deps.storage.executions.updateStatus(execution.id, "failed", endedAt.toISOString());
    deps.storage.events.append({
      executionId: execution.id,
      kind: "execution.failed",
      payload: { serverId: input.serverId, capabilityId, error: message },
    });
    return { executionId: execution.id, ok: false, error: message, durationMs };
  }
}

export interface ExecuteGetPromptInput {
  serverId: string;
  name: string;
  arguments?: Record<string, unknown>;
  workspaceId?: string;
  workspaceNodeId?: string;
  captureSessionId?: string;
  agentRunId?: string;
  metadata?: unknown;
}

export async function executeGetPrompt(
  deps: ExecutorDeps,
  input: ExecuteGetPromptInput,
): Promise<ExecuteResult> {
  const capabilityId = `${input.serverId}::prompt::${input.name}`;
  const createExecInput: Parameters<typeof deps.storage.executions.create>[0] = {
    serverId: input.serverId,
    capabilityId,
  };
  if (input.workspaceId !== undefined) createExecInput.workspaceId = input.workspaceId;
  if (input.workspaceNodeId !== undefined) createExecInput.workspaceNodeId = input.workspaceNodeId;
  if (input.captureSessionId !== undefined) createExecInput.captureSessionId = input.captureSessionId;
  if (input.agentRunId !== undefined) createExecInput.agentRunId = input.agentRunId;
  if (input.metadata !== undefined) createExecInput.metadata = input.metadata;
  const execution = deps.storage.executions.create(createExecInput);

  const args = input.arguments ?? {};
  const payload: Record<string, unknown> = {
    serverId: input.serverId,
    capabilityId,
    name: input.name,
    arguments: args,
  };
  if (input.metadata !== undefined) payload["metadata"] = input.metadata;
  deps.storage.events.append({ executionId: execution.id, kind: "execution.created", payload });

  const startedAt = new Date();
  try {
    // Build the call args explicitly so exactOptionalPropertyTypes doesn't
    // reject a present-but-undefined `arguments` (same pattern as the
    // POST /servers/:id/prompts/:name/get route).
    const { messages, description, evidence } =
      Object.keys(args).length > 0
        ? await deps.adapter.getPrompt({ serverId: input.serverId, name: input.name, arguments: args as JsonObject })
        : await deps.adapter.getPrompt({ serverId: input.serverId, name: input.name });
    const endedAt = new Date();
    const durationMs = endedAt.getTime() - startedAt.getTime();

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
      durationMs,
      startedAt: startedAt.toISOString(),
      endedAt: endedAt.toISOString(),
    });
    deps.storage.executions.updateStatus(execution.id, "complete", endedAt.toISOString());
    deps.storage.events.append({
      executionId: execution.id,
      kind: "execution.complete",
      payload: { serverId: input.serverId, capabilityId, evidenceRefs: [evidenceRow.id] },
    });
    return {
      executionId: execution.id,
      ok: true,
      value: { messages, description },
      evidence,
      evidenceRefs: [{ id: evidenceRow.id, kind: evidenceRow.kind, artifactRef: evidenceRow.artifactRef }],
      durationMs,
    };
  } catch (err) {
    const endedAt = new Date();
    const durationMs = endedAt.getTime() - startedAt.getTime();
    const message = err instanceof Error ? err.message : String(err);
    deps.storage.rounds.append({
      executionId: execution.id,
      roundIndex: 0,
      kind: "initial",
      argumentsJson: JSON.stringify(args),
      errorJson: JSON.stringify({ message }),
      durationMs,
      startedAt: startedAt.toISOString(),
      endedAt: endedAt.toISOString(),
    });
    deps.storage.executions.updateStatus(execution.id, "failed", endedAt.toISOString());
    deps.storage.events.append({
      executionId: execution.id,
      kind: "execution.failed",
      payload: { serverId: input.serverId, capabilityId, error: message },
    });
    return { executionId: execution.id, ok: false, error: message, durationMs };
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
  // Per-run AbortController's signal (routes.ts builds one per /run request
  // and links it to the client's own disconnect). Threaded down to every
  // tool-node's executeTool call so cancelling the run cancels every
  // in-flight child; see ExecuteToolInput.signal.
  signal?: AbortSignal;
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
    async (node) =>
      dispatchNode(deps, input.workspaceId, input.runId, node, captureSession.id, agentRun.id, input.signal),
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
  signal?: AbortSignal,
): Promise<WorkspaceRunResult["nodes"][number]> {
  const base = { nodeId: node.id, capabilityId: node.capabilityId };

  if (!node.capabilityId) {
    return { ...base, ok: false, skippedReason: "unbound-capability" };
  }
  const parsed = parseCapabilityId(node.capabilityId);
  if (!parsed) {
    return { ...base, ok: false, skippedReason: "invalid-capability-id" };
  }
  if (parsed.type !== "tool" && parsed.type !== "resource" && parsed.type !== "prompt") {
    return { ...base, ok: false, skippedReason: `unsupported-type:${parsed.type}` };
  }
  if (!deps.serverManager.getBinding(parsed.serverId)) {
    return { ...base, ok: false, skippedReason: "server-not-connected" };
  }

  deps.storage.events.append({
    kind: "workspace.run.node.started",
    payload: { workspaceId, runId, nodeId: node.id, capabilityId: node.capabilityId },
  });

  let r: ExecuteResult;
  if (parsed.type === "tool") {
    const args = parseArgs(node.argumentsJson);
    const executeInput: ExecuteToolInput = {
      serverId: parsed.serverId,
      name: parsed.name,
      arguments: args,
      workspaceId,
      workspaceNodeId: node.id,
      captureSessionId,
      agentRunId,
    };
    if (signal !== undefined) executeInput.signal = signal;
    r = await executeTool(deps, executeInput);
  } else if (parsed.type === "resource") {
    // capabilityId is `${serverId}::resource::${uri}`; parseCapabilityId's
    // rest.join("::") already reconstructs the full URI as parsed.name.
    r = await executeResourceRead(deps, {
      serverId: parsed.serverId,
      uri: parsed.name,
      workspaceId,
      workspaceNodeId: node.id,
      captureSessionId,
      agentRunId,
    });
  } else {
    const args = parseArgs(node.argumentsJson);
    const executeInput: ExecuteGetPromptInput = {
      serverId: parsed.serverId,
      name: parsed.name,
      workspaceId,
      workspaceNodeId: node.id,
      captureSessionId,
      agentRunId,
    };
    if (Object.keys(args).length > 0) executeInput.arguments = args;
    r = await executeGetPrompt(deps, executeInput);
  }
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

// Exported so the /executions/:id/retry route (routes.ts) can decode a
// source Execution's capabilityId the same way dispatchNode does, and
// dispatch to the matching execute* helper for "same server/capability".
export function parseCapabilityId(
  id: string,
): { serverId: string; type: string; name: string } | null {
  const parts = id.split("::");
  if (parts.length < 3) return null;
  const [serverId, type, ...rest] = parts;
  if (!serverId || !type || rest.length === 0) return null;
  return { serverId, type, name: rest.join("::") };
}

export function parseArgs(json: string | null): Record<string, unknown> {
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
