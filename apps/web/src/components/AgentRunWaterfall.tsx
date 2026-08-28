import { useEffect, useMemo, useState } from "react";
import { getAgentRunTimeline } from "../api/client";
import type { AgentRunTimeline as AgentRunTimelineData, ExecutionRecord } from "../api/types";

// UX-6 slice 2: Waterfall projection over agent-run executions.
// Complements the Timeline projection (slice 1): where Timeline shows
// per-lane instants along one horizontal axis, Waterfall shows per-
// execution DURATION as a horizontal bar. Time positioning is derived
// from `startedAt` and `endedAt` on `ExecutionRecord`; executions with
// no `endedAt` yet render as "running" bars anchored at their start.
//
// Preserves concurrency per dispatch §21 — bars whose intervals
// overlap render on the same row. No fake parentage.

interface Props {
  agentRunId: string;
}

interface WaterfallRow {
  id: string;
  label: string;
  status: string;
  startMs: number;
  endMs: number | null;
  isRunning: boolean;
}

function toMs(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  return Number.isNaN(t) ? null : t;
}

function makeRows(execs: ExecutionRecord[]): WaterfallRow[] {
  const rows: WaterfallRow[] = [];
  for (const ex of execs) {
    const start = toMs(ex.startedAt) ?? toMs(ex.createdAt);
    if (start === null) continue;
    const end = toMs(ex.endedAt);
    rows.push({
      id: ex.id,
      label: `${ex.serverId} · ${ex.capabilityId}`,
      status: ex.status,
      startMs: start,
      endMs: end,
      isRunning: end === null,
    });
  }
  rows.sort((a, b) => a.startMs - b.startMs);
  return rows;
}

function statusClass(status: string): string {
  if (status === "complete") return "waterfall-bar-complete";
  if (status === "failed" || status === "cancelled") return "waterfall-bar-failed";
  return "waterfall-bar-active";
}

export function AgentRunWaterfall({ agentRunId }: Props) {
  const [data, setData] = useState<AgentRunTimelineData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    setError(null);
    getAgentRunTimeline(agentRunId)
      .then((r) => setData(r))
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setLoading(false));
  }, [agentRunId]);

  const rows = useMemo(() => (data ? makeRows(data.executions) : []), [data]);

  const bounds = useMemo(() => {
    if (rows.length === 0) return null;
    let min = Infinity;
    let max = -Infinity;
    const now = Date.now();
    for (const r of rows) {
      if (r.startMs < min) min = r.startMs;
      const end = r.endMs ?? now;
      if (end > max) max = end;
    }
    if (!isFinite(min) || !isFinite(max)) return null;
    if (min === max) return { min, max: min + 1_000, span: 1_000 };
    return { min, max, span: max - min };
  }, [rows]);

  if (loading) return <p className="muted">Loading waterfall…</p>;
  if (error) return <p className="form-error">{error}</p>;
  if (!bounds || rows.length === 0) {
    return (
      <p className="muted" data-testid="waterfall-empty">
        No execution durations for this agent run yet.
      </p>
    );
  }

  return (
    <div className="agent-waterfall" data-testid="agent-waterfall">
      <div className="agent-timeline-head muted">
        {rows.length} execution{rows.length === 1 ? "" : "s"} ·{" "}
        {new Date(bounds.min).toISOString()} → {new Date(bounds.max).toISOString()}
      </div>
      <div className="agent-waterfall-rows">
        {rows.map((r) => {
          const left = ((r.startMs - bounds.min) / bounds.span) * 100;
          const width = Math.max(
            0.4,
            (((r.endMs ?? bounds.max) - r.startMs) / bounds.span) * 100,
          );
          const durMs = (r.endMs ?? bounds.max) - r.startMs;
          return (
            <div
              key={r.id}
              className="agent-waterfall-row"
              data-testid={`waterfall-row-${r.id}`}
            >
              <div className="agent-timeline-lane-label" title={r.label}>
                {r.label}
              </div>
              <div className="agent-waterfall-track">
                <span
                  className={`agent-waterfall-bar ${statusClass(r.status)} ${r.isRunning ? "waterfall-bar-running" : ""}`}
                  style={{ left: `${left}%`, width: `${width}%` }}
                  title={`${r.status} · ${durMs}ms`}
                />
                <span className="agent-waterfall-dur muted">{durMs} ms</span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
