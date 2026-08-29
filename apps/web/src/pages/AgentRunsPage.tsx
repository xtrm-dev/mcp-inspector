import { useEffect, useState } from "react";
import { listAgentRuns } from "../api/client";
import type { AgentRun } from "../api/types";
import { TraceOverlayPanel } from "../components/TraceOverlayPanel";
import { AgentRunTimeline } from "../components/AgentRunTimeline";
import { AgentRunWaterfall } from "../components/AgentRunWaterfall";
import { AgentRunGraph } from "../components/AgentRunGraph";
import { AgentRunWorkspaceProjection } from "../components/AgentRunWorkspaceProjection";

// UX-6 slice 3: all five PRD projections wired — list, timeline,
// waterfall, graph, workspace.
type ProjectionId = "list" | "timeline" | "waterfall" | "graph" | "workspace";

const PROJECTION_LABEL: Record<ProjectionId, string> = {
  list: "List",
  timeline: "Timeline",
  waterfall: "Waterfall",
  graph: "Graph",
  workspace: "Workspace",
};

export function AgentRunsPage() {
  const [runs, setRuns] = useState<AgentRun[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [projection, setProjection] = useState<ProjectionId>("list");

  useEffect(() => {
    listAgentRuns({ limit: 100 }).then((res) => setRuns(res.agentRuns));
  }, []);

  return (
    <div className="page" data-testid="agent-runs-page">
      <div className="page-header">
        <h2>Agent runs</h2>
        <div className="projection-picker" role="tablist" aria-label="Agent runs projection">
          {(["list", "timeline", "waterfall", "graph", "workspace"] as const).map((p) => (
            <button
              key={p}
              type="button"
              role="tab"
              aria-selected={projection === p}
              className={`chip ${projection === p ? "chip-active" : ""}`}
              data-testid={`agent-runs-projection-${p}`}
              onClick={() => setProjection(p)}
            >
              {PROJECTION_LABEL[p]}
            </button>
          ))}
        </div>
      </div>

      <table className="data-table">
        <thead>
          <tr>
            <th>Correlation</th>
            <th>Started</th>
            <th>Ended</th>
          </tr>
        </thead>
        <tbody>
          {runs.map((r) => (
            <tr key={r.id} className={r.id === selectedId ? "selected" : ""} onClick={() => setSelectedId(r.id)}>
              <td>{r.correlationKind} · {r.correlationKey ?? r.id}</td>
              <td>{r.startedAt}</td>
              <td>{r.endedAt ?? "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {selectedId && projection === "timeline" && <AgentRunTimeline agentRunId={selectedId} />}
      {selectedId && projection === "waterfall" && <AgentRunWaterfall agentRunId={selectedId} />}
      {selectedId && projection === "graph" && <AgentRunGraph agentRunId={selectedId} />}
      {selectedId && projection === "workspace" && <AgentRunWorkspaceProjection agentRunId={selectedId} />}
      {selectedId && <TraceOverlayPanel agentRunId={selectedId} />}
    </div>
  );
}
