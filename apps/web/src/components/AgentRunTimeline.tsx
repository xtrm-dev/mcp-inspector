import { useEffect, useMemo, useState } from "react";
import { getAgentRunTimeline } from "../api/client";
import type { AgentRunTimeline as AgentRunTimelineData, TimelineOverlayEntry } from "../api/types";

interface Props {
  agentRunId: string;
}

interface LaneRow {
  key: string;
  label: string;
  entries: Array<{ at: number; entry: TimelineOverlayEntry }>;
}

function entryLaneKey(e: TimelineOverlayEntry): string {
  if (e.kind === "execution") return `exec::${e.ref.serverId}::${e.ref.capabilityId}`;
  return `span::${e.ref.traceId}`;
}

function entryLaneLabel(e: TimelineOverlayEntry): string {
  if (e.kind === "execution") return `${e.ref.serverId} · ${e.ref.capabilityId}`;
  return `trace ${e.ref.traceId}${e.ref.name ? ` · ${e.ref.name}` : ""}`;
}

function statusClass(entry: TimelineOverlayEntry): string {
  if (entry.kind !== "execution") return "timeline-span";
  const s = entry.ref.status;
  if (s === "complete") return "timeline-exec-complete";
  if (s === "failed" || s === "cancelled") return "timeline-exec-failed";
  return "timeline-exec-active";
}

export function AgentRunTimeline({ agentRunId }: Props) {
  const [timeline, setTimeline] = useState<AgentRunTimelineData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    setError(null);
    getAgentRunTimeline(agentRunId)
      .then((data) => setTimeline(data))
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setLoading(false));
  }, [agentRunId]);

  const lanes = useMemo<LaneRow[]>(() => {
    if (!timeline) return [];
    const grouped = new Map<string, LaneRow>();
    for (const entry of timeline.overlay) {
      const at = new Date(entry.at).getTime();
      if (Number.isNaN(at)) continue;
      const key = entryLaneKey(entry);
      let lane = grouped.get(key);
      if (!lane) {
        lane = { key, label: entryLaneLabel(entry), entries: [] };
        grouped.set(key, lane);
      }
      lane.entries.push({ at, entry });
    }
    for (const lane of grouped.values()) {
      lane.entries.sort((a, b) => a.at - b.at);
    }
    return Array.from(grouped.values()).sort((a, b) => a.label.localeCompare(b.label));
  }, [timeline]);

  const bounds = useMemo(() => {
    if (!timeline || timeline.overlay.length === 0) return null;
    let min = Infinity;
    let max = -Infinity;
    for (const e of timeline.overlay) {
      const t = new Date(e.at).getTime();
      if (Number.isNaN(t)) continue;
      if (t < min) min = t;
      if (t > max) max = t;
    }
    if (!isFinite(min) || !isFinite(max)) return null;
    if (min === max) return { min, max: min + 1_000, span: 1_000 };
    return { min, max, span: max - min };
  }, [timeline]);

  if (loading) return <p className="muted">Loading timeline…</p>;
  if (error) return <p className="form-error">{error}</p>;
  if (!timeline || !bounds || lanes.length === 0) {
    return (
      <p className="muted" data-testid="timeline-empty">
        No timeline entries for this agent run yet.
      </p>
    );
  }

  return (
    <div className="agent-timeline" data-testid="agent-timeline">
      <div className="agent-timeline-head muted">
        {lanes.length} lane{lanes.length === 1 ? "" : "s"} · {timeline.overlay.length} entries ·{" "}
        {new Date(bounds.min).toISOString()} → {new Date(bounds.max).toISOString()}
      </div>
      <div className="agent-timeline-lanes">
        {lanes.map((lane) => (
          <div key={lane.key} className="agent-timeline-lane" data-testid={`timeline-lane-${lane.key}`}>
            <div className="agent-timeline-lane-label" title={lane.label}>
              {lane.label}
            </div>
            <div className="agent-timeline-track">
              {lane.entries.map((e, idx) => {
                const left = ((e.at - bounds.min) / bounds.span) * 100;
                return (
                  <span
                    key={`${lane.key}-${idx}`}
                    className={`agent-timeline-mark ${statusClass(e.entry)}`}
                    style={{ left: `${left}%` }}
                    title={`${e.entry.kind} at ${new Date(e.at).toISOString()}`}
                  />
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
