import { useEffect, useState } from "react";
import { getAgentRunTimeline } from "../api/client";
import type { AgentRunTimeline } from "../api/types";

export interface TraceOverlayPanelProps {
  agentRunId: string;
}

/**
 * Trace overlay panel — GET /api/v1/agent-runs/:id/timeline merges an
 * AgentRun's Executions with any correlated trace spans (PR #42) into one
 * time-sorted overlay. Used on the Workspace (after a Run) and Agent Run
 * detail views.
 */
export function TraceOverlayPanel({ agentRunId }: TraceOverlayPanelProps) {
  const [timeline, setTimeline] = useState<AgentRunTimeline | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setTimeline(null);
    setError(null);
    getAgentRunTimeline(agentRunId)
      .then((t) => !cancelled && setTimeline(t))
      .catch((err) => !cancelled && setError(err instanceof Error ? err.message : String(err)));
    return () => {
      cancelled = true;
    };
  }, [agentRunId]);

  if (error) return <p className="form-error">trace overlay: {error}</p>;
  if (!timeline) return <p className="muted">loading trace overlay…</p>;

  return (
    <div className="panel trace-overlay" data-testid="trace-overlay">
      <h3>Trace overlay — {agentRunId}</h3>
      {timeline._note && <p className="muted">{timeline._note}</p>}
      <ol className="overlay-list">
        {timeline.overlay.map((entry, i) => (
          <li key={i} className={`overlay-entry overlay-${entry.kind}`}>
            <span className="overlay-time">{entry.at}</span>
            {entry.kind === "execution" ? (
              <span>
                execution · {entry.ref.capabilityId} · <span className={`status ${entry.ref.status}`}>{entry.ref.status}</span>
              </span>
            ) : (
              <span>span · {entry.ref.name ?? entry.ref.id} (trace {entry.ref.traceId})</span>
            )}
          </li>
        ))}
      </ol>
      {timeline.overlay.length === 0 && <p className="muted">no executions or spans yet</p>}
    </div>
  );
}
