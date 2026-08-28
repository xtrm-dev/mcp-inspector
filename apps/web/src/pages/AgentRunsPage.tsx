import { useEffect, useState } from "react";
import { listAgentRuns } from "../api/client";
import type { AgentRun } from "../api/types";
import { TraceOverlayPanel } from "../components/TraceOverlayPanel";
import { AgentRunTimeline } from "../components/AgentRunTimeline";
import { AgentRunWaterfall } from "../components/AgentRunWaterfall";

// UX-6 slice 2: adds Waterfall projection. Graph / Workspace projections
// land in slice 3.
type ProjectionId = "list" | "timeline" | "waterfall";

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
          {(["list", "timeline", "waterfall"] as const).map((p) => (
            <button
              key={p}
              type="button"
              role="tab"
              aria-selected={projection === p}
              className={`chip ${projection === p ? "chip-active" : ""}`}
              data-testid={`agent-runs-projection-${p}`}
              onClick={() => setProjection(p)}
            >
              {p === "list" ? "List" : p === "timeline" ? "Timeline" : "Waterfall"}
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
      {selectedId && <TraceOverlayPanel agentRunId={selectedId} />}
    </div>
  );
}
