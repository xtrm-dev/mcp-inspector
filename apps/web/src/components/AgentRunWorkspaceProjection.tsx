import { useEffect, useMemo, useState } from "react";
import { getAgentRunTimeline, getExecution, listServers } from "../api/client";
import type {
  ExecutionDetail,
  ExecutionRecord,
  ServerSummary,
  WorkspaceNodePresentation,
  WorkspaceNodeRow,
} from "../api/types";
import { WorkspaceProjections } from "./WorkspaceProjections";

interface Props {
  agentRunId: string;
}

// UX-6 slice 3: Workspace projection over an agent-run's executions.
// Adapts each ExecutionRecord to a synthetic WorkspaceNodeRow so the
// shared WorkspaceProjections grid renders the same capability cards
// and CapabilityInspector the workspace uses. No workspace mutation
// happens here — the executions are read-only.

function execToNode(exec: ExecutionRecord): WorkspaceNodeRow {
  return {
    id: exec.id,
    workspaceId: exec.workspaceId ?? "",
    serverId: exec.serverId,
    capabilityId: exec.capabilityId,
    argumentsJson: null,
    presentation: "expanded" as WorkspaceNodePresentation,
    position: 0,
    createdAt: exec.startedAt,
    updatedAt: exec.endedAt ?? exec.startedAt,
  };
}

export function AgentRunWorkspaceProjection({ agentRunId }: Props) {
  const [executions, setExecutions] = useState<ExecutionRecord[]>([]);
  const [details, setDetails] = useState<Map<string, ExecutionDetail>>(new Map());
  const [servers, setServers] = useState<Map<string, ServerSummary>>(new Map());
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [presentations, setPresentations] = useState<Map<string, WorkspaceNodePresentation>>(new Map());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    setError(null);
    let cancelled = false;
    (async () => {
      try {
        const [timeline, srv] = await Promise.all([
          getAgentRunTimeline(agentRunId),
          listServers(),
        ]);
        if (cancelled) return;
        setExecutions(timeline.executions);
        setServers(new Map(srv.servers.map((s) => [s.id, s])));
        const detailMap = new Map<string, ExecutionDetail>();
        const detailResults = await Promise.all(
          timeline.executions.map((e) => getExecution(e.id).catch(() => null)),
        );
        if (cancelled) return;
        detailResults.forEach((d, i) => {
          const exec = timeline.executions[i];
          if (d && exec) detailMap.set(exec.id, d);
        });
        setDetails(detailMap);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [agentRunId]);

  const nodes = useMemo<WorkspaceNodeRow[]>(() => {
    return executions.map((exec) => {
      const base = execToNode(exec);
      const p = presentations.get(exec.id);
      return p ? { ...base, presentation: p } : base;
    });
  }, [executions, presentations]);

  if (loading) return <p className="muted">Loading workspace projection…</p>;
  if (error) return <p className="form-error">{error}</p>;
  if (executions.length === 0) {
    return (
      <p className="muted" data-testid="agent-workspace-empty">
        No executions to render as workspace cards yet.
      </p>
    );
  }

  return (
    <div data-testid="agent-run-workspace">
      <WorkspaceProjections
        projection="grid"
        nodes={nodes}
        servers={servers}
        selectedNodeId={selectedNodeId}
        selectedNodeIds={new Set()}
        executionDetails={details}
        executionHistory={new Map()}
        descriptions={new Map()}
        inputSchemas={new Map()}
        runResult={null}
        onRunNode={async () => {}}
        onSelectNode={setSelectedNodeId}
        onToggleSelected={() => {}}
        onPresentationChange={(node, presentation) => {
          setPresentations((prev) => {
            const next = new Map(prev);
            next.set(node.id, presentation);
            return next;
          });
        }}
      />
    </div>
  );
}
