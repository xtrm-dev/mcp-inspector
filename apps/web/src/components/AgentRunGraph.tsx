import { useEffect, useMemo, useState } from "react";
import { getAgentRunTimeline } from "../api/client";
import type { AgentRunTimeline as AgentRunTimelineData, ExecutionRecord } from "../api/types";

// UX-6 slice 3: Graph projection over agent-run executions. Reuses the
// hand-rolled SVG substrate from WorkspaceGraph (no @xyflow/react). Each
// execution renders as a card; edges connect start-time-ordered siblings
// so the reader sees the sequence the agent actually walked. Concurrent
// (overlapping) executions render on separate rows so parallelism stays
// visible.

const CARD_WIDTH = 200;
const CARD_HEIGHT = 60;
const COL_GAP = 40;
const ROW_GAP = 24;
const MARGIN = 24;

interface Props {
  agentRunId: string;
}

interface Placed {
  exec: ExecutionRecord;
  col: number;
  row: number;
  x: number;
  y: number;
}

function toMs(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  return Number.isNaN(t) ? null : t;
}

function statusClass(status: string): string {
  if (status === "complete") return "complete";
  if (status === "failed" || status === "cancelled") return "error";
  if (status === "idle") return "idle";
  return "running";
}

// ponytail: greedy row-packing. Each new (start-ordered) execution
// takes the lowest-index row whose current tail is <= its start.
function place(execs: ExecutionRecord[]): Placed[] {
  const sorted = execs
    .map((e) => ({ e, s: toMs(e.startedAt), n: toMs(e.endedAt) ?? toMs(e.startedAt) }))
    .filter((x): x is { e: ExecutionRecord; s: number; n: number } => x.s !== null && x.n !== null)
    .sort((a, b) => a.s - b.s || a.e.id.localeCompare(b.e.id));
  const rowTail: number[] = [];
  const placed: Placed[] = [];
  sorted.forEach((item, col) => {
    let row = rowTail.findIndex((tail) => tail <= item.s);
    if (row === -1) { row = rowTail.length; rowTail.push(item.n); }
    else rowTail[row] = item.n;
    placed.push({
      exec: item.e,
      col,
      row,
      x: MARGIN + col * (CARD_WIDTH + COL_GAP),
      y: MARGIN + row * (CARD_HEIGHT + ROW_GAP),
    });
  });
  return placed;
}

function ellipsize(value: string, length: number): string {
  return value.length > length ? `${value.slice(0, length - 1)}…` : value;
}

export function AgentRunGraph({ agentRunId }: Props) {
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

  const placed = useMemo(() => (data ? place(data.executions) : []), [data]);
  const dims = useMemo(() => {
    if (placed.length === 0) return { width: 0, height: 0 };
    const maxCol = Math.max(...placed.map((p) => p.col));
    const maxRow = Math.max(...placed.map((p) => p.row));
    return {
      width: MARGIN * 2 + (maxCol + 1) * CARD_WIDTH + maxCol * COL_GAP,
      height: MARGIN * 2 + (maxRow + 1) * CARD_HEIGHT + maxRow * ROW_GAP,
    };
  }, [placed]);

  if (loading) return <p className="muted">Loading graph…</p>;
  if (error) return <p className="form-error">{error}</p>;
  if (placed.length === 0) {
    return (
      <p className="muted" data-testid="agent-graph-empty">
        No executions to graph for this agent run yet.
      </p>
    );
  }

  return (
    <section className="workspace-graph-wrap" data-testid="agent-run-graph-wrap">
      <svg
        className="workspace-graph"
        data-testid="agent-run-graph"
        role="img"
        aria-label="Agent run graph"
        width={dims.width}
        height={dims.height}
        viewBox={`0 0 ${dims.width} ${dims.height}`}
      >
        {placed.slice(1).map((to, i) => {
          const from = placed[i]!;
          const startX = from.x + CARD_WIDTH;
          const startY = from.y + CARD_HEIGHT / 2;
          const endX = to.x;
          const endY = to.y + CARD_HEIGHT / 2;
          return (
            <path
              key={`edge-${from.exec.id}-${to.exec.id}`}
              className="workspace-graph-edge"
              data-testid={`agent-graph-edge-${from.exec.id}-${to.exec.id}`}
              d={`M${startX},${startY} C${startX + 40},${startY} ${endX - 40},${endY} ${endX},${endY}`}
            />
          );
        })}
        {placed.map(({ exec, x, y }) => (
          <g
            key={exec.id}
            className="workspace-graph-node"
            data-testid={`agent-graph-node-${exec.id}`}
            transform={`translate(${x} ${y})`}
          >
            <rect className="workspace-graph-node-card" width={CARD_WIDTH} height={CARD_HEIGHT} rx="9" />
            <rect className="workspace-graph-server-chip" x="10" y="9" width="120" height="18" rx="9" />
            <text className="workspace-graph-server" x="18" y="22">{ellipsize(exec.serverId, 18)}</text>
            <circle className={`workspace-graph-status ${statusClass(exec.status)}`} cx={CARD_WIDTH - 18} cy="18" r="5" />
            <text className="workspace-graph-capability" x="12" y="45">{ellipsize(exec.capabilityId, 26)}</text>
          </g>
        ))}
      </svg>
    </section>
  );
}
