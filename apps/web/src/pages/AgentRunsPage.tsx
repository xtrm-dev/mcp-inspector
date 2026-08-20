import { useEffect, useState } from "react";
import { listAgentRuns } from "../api/client";
import type { AgentRun } from "../api/types";
import { TraceOverlayPanel } from "../components/TraceOverlayPanel";

export function AgentRunsPage() {
  const [runs, setRuns] = useState<AgentRun[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  useEffect(() => {
    listAgentRuns({ limit: 100 }).then((res) => setRuns(res.agentRuns));
  }, []);

  return (
    <div className="page" data-testid="agent-runs-page">
      <h2>Agent runs</h2>
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

      {selectedId && <TraceOverlayPanel agentRunId={selectedId} />}
    </div>
  );
}
