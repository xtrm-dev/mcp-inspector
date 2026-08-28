import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ServerSummary, WorkspaceNodeRow } from "../api/types";

// UX-3 slice 1: minimal, hand-rolled SVG workspace graph. No graph
// library — evaluation of @xyflow/react added 52 kB gzip against a 200 kB
// app-budget cap; a hand-roll fits the V1 goals in the dispatch §15 list
// (large canvas, pan, zoom, fit, selection, edges where bound, server
// grouping, persisted layout) without the dependency. Slice 2 will add
// edges once a workspace-binding surface exists; slice 3 will unify
// selection with the shared CapabilityInspector UX-2 introduced.
//
// The layout state is persisted onto `workspace.layoutJson` under a
// namespaced key (`graph`) so other projections keep their sub-tree
// intact. Missing / malformed entries fall back to auto-placement,
// keyed by server → per-server grid.

export interface GraphLayoutState {
  positions?: Record<string, { x: number; y: number }>;
  viewport?: { x: number; y: number; scale: number };
  groupBy?: "server" | "none";
}

export interface WorkspaceGraphLayoutJson {
  view?: string;
  graph?: GraphLayoutState;
  [key: string]: unknown;
}

interface Props {
  nodes: WorkspaceNodeRow[];
  servers: ServerSummary[];
  selectedNodeId: string | null;
  onSelect: (nodeId: string | null) => void;
  layout: GraphLayoutState;
  onLayoutChange: (next: GraphLayoutState) => void;
}

const CARD_W = 180;
const CARD_H = 64;
const GRID_H_STEP = CARD_H + 32;
const GRID_V_STEP = CARD_W + 40;
const SNAP = 20;
const CANVAS_W = 2400;
const CANVAS_H = 1600;
const MIN_SCALE = 0.35;
const MAX_SCALE = 2.4;
const DEFAULT_VIEWPORT = { x: 0, y: 0, scale: 1 };

function snap(v: number): number {
  return Math.round(v / SNAP) * SNAP;
}

function serverIndex(serverId: string | null, servers: ServerSummary[]): number {
  if (!serverId) return -1;
  const idx = servers.findIndex((s) => s.id === serverId);
  return idx === -1 ? servers.length : idx;
}

function autoPlace(
  nodes: WorkspaceNodeRow[],
  servers: ServerSummary[],
): Record<string, { x: number; y: number }> {
  const perServer = new Map<string | null, number>();
  const out: Record<string, { x: number; y: number }> = {};
  for (const node of nodes) {
    const key = node.serverId ?? null;
    const seq = perServer.get(key) ?? 0;
    perServer.set(key, seq + 1);
    const col = serverIndex(key, servers) + 1; // shift so unassigned lands left
    const row = seq;
    out[node.id] = {
      x: snap(80 + col * GRID_V_STEP),
      y: snap(80 + row * GRID_H_STEP),
    };
  }
  return out;
}

function statusForNode(_node: WorkspaceNodeRow): "ok" | "warn" | "err" | "idle" {
  // ponytail: V1 has no per-node status field on WorkspaceNodeRow.
  // Slice 2 (or a workspace-binding surface) will populate this from
  // the latest execution. Until then, everything reads idle.
  return "idle";
}

export function WorkspaceGraph({
  nodes,
  servers,
  selectedNodeId,
  onSelect,
  layout,
  onLayoutChange,
}: Props) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const positions = useMemo(() => {
    const auto = autoPlace(nodes, servers);
    return { ...auto, ...(layout.positions ?? {}) };
  }, [nodes, servers, layout.positions]);
  const viewport = layout.viewport ?? DEFAULT_VIEWPORT;

  const [dragging, setDragging] = useState<
    | { kind: "canvas"; startX: number; startY: number; origVX: number; origVY: number }
    | { kind: "node"; nodeId: string; startX: number; startY: number; origX: number; origY: number }
    | null
  >(null);

  const setViewport = useCallback(
    (next: { x: number; y: number; scale: number }) => {
      onLayoutChange({ ...layout, viewport: next });
    },
    [layout, onLayoutChange],
  );

  const setPosition = useCallback(
    (nodeId: string, x: number, y: number) => {
      const nextPositions = { ...(layout.positions ?? {}), [nodeId]: { x: snap(x), y: snap(y) } };
      onLayoutChange({ ...layout, positions: nextPositions });
    },
    [layout, onLayoutChange],
  );

  const worldPoint = useCallback(
    (clientX: number, clientY: number): { x: number; y: number } => {
      const svg = svgRef.current;
      if (!svg) return { x: 0, y: 0 };
      const rect = svg.getBoundingClientRect();
      const x = (clientX - rect.left - viewport.x) / viewport.scale;
      const y = (clientY - rect.top - viewport.y) / viewport.scale;
      return { x, y };
    },
    [viewport],
  );

  function handleWheel(e: React.WheelEvent) {
    e.preventDefault();
    const delta = e.deltaY < 0 ? 1.1 : 1 / 1.1;
    const nextScale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, viewport.scale * delta));
    if (nextScale === viewport.scale) return;
    // Zoom around the pointer.
    const w = worldPoint(e.clientX, e.clientY);
    const svg = svgRef.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    setViewport({
      x: e.clientX - rect.left - w.x * nextScale,
      y: e.clientY - rect.top - w.y * nextScale,
      scale: nextScale,
    });
  }

  function handlePointerDownCanvas(e: React.PointerEvent) {
    if ((e.target as Element).closest("[data-graph-node]")) return;
    (e.target as Element).setPointerCapture?.(e.pointerId);
    setDragging({
      kind: "canvas",
      startX: e.clientX,
      startY: e.clientY,
      origVX: viewport.x,
      origVY: viewport.y,
    });
    onSelect(null);
  }

  function handlePointerDownNode(e: React.PointerEvent, nodeId: string) {
    e.stopPropagation();
    (e.target as Element).setPointerCapture?.(e.pointerId);
    const pos = positions[nodeId] ?? { x: 80, y: 80 };
    setDragging({
      kind: "node",
      nodeId,
      startX: e.clientX,
      startY: e.clientY,
      origX: pos.x,
      origY: pos.y,
    });
    onSelect(nodeId);
  }

  function handlePointerMove(e: React.PointerEvent) {
    if (!dragging) return;
    if (dragging.kind === "canvas") {
      setViewport({
        x: dragging.origVX + (e.clientX - dragging.startX),
        y: dragging.origVY + (e.clientY - dragging.startY),
        scale: viewport.scale,
      });
    } else {
      const dx = (e.clientX - dragging.startX) / viewport.scale;
      const dy = (e.clientY - dragging.startY) / viewport.scale;
      setPosition(dragging.nodeId, dragging.origX + dx, dragging.origY + dy);
    }
  }

  function handlePointerUp() {
    setDragging(null);
  }

  const fitAll = useCallback(() => {
    if (nodes.length === 0) {
      setViewport(DEFAULT_VIEWPORT);
      return;
    }
    const svg = svgRef.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const node of nodes) {
      const p = positions[node.id];
      if (!p) continue;
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x + CARD_W > maxX) maxX = p.x + CARD_W;
      if (p.y + CARD_H > maxY) maxY = p.y + CARD_H;
    }
    if (!isFinite(minX)) return;
    const pad = 60;
    const contentW = maxX - minX + pad * 2;
    const contentH = maxY - minY + pad * 2;
    const scaleX = rect.width / contentW;
    const scaleY = rect.height / contentH;
    const scale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, Math.min(scaleX, scaleY)));
    setViewport({
      x: pad * scale - minX * scale,
      y: pad * scale - minY * scale,
      scale,
    });
  }, [nodes, positions, setViewport]);

  const resetLayout = useCallback(() => {
    onLayoutChange({ ...layout, positions: undefined, viewport: DEFAULT_VIEWPORT });
  }, [layout, onLayoutChange]);

  useEffect(() => {
    // Auto-fit on first mount when we have nodes but no persisted viewport.
    if (nodes.length > 0 && !layout.viewport) {
      // Defer to next frame so SVG has a real bounding rect.
      const t = setTimeout(fitAll, 0);
      return () => clearTimeout(t);
    }
    return undefined;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodes.length]);

  return (
    <div className="workspace-graph" data-testid="workspace-graph">
      <div className="workspace-graph-toolbar">
        <span className="muted">
          {nodes.length} node{nodes.length === 1 ? "" : "s"} · zoom {(viewport.scale * 100).toFixed(0)}%
        </span>
        <div className="workspace-graph-actions">
          <button type="button" onClick={fitAll} data-testid="graph-fit">
            Fit
          </button>
          <button type="button" onClick={resetLayout} data-testid="graph-reset">
            Reset
          </button>
        </div>
      </div>
      <svg
        ref={svgRef}
        className="workspace-graph-canvas"
        viewBox={`0 0 ${CANVAS_W} ${CANVAS_H}`}
        preserveAspectRatio="xMidYMid meet"
        onWheel={handleWheel}
        onPointerDown={handlePointerDownCanvas}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        data-testid="workspace-graph-svg"
      >
        <defs>
          <pattern id="graph-grid" width="20" height="20" patternUnits="userSpaceOnUse">
            <circle cx="1" cy="1" r="1" fill="rgba(255,255,255,0.045)" />
          </pattern>
        </defs>
        <g transform={`translate(${viewport.x} ${viewport.y}) scale(${viewport.scale})`}>
          <rect x="0" y="0" width={CANVAS_W} height={CANVAS_H} fill="url(#graph-grid)" />
          {nodes.map((node) => {
            const pos = positions[node.id] ?? { x: 80, y: 80 };
            const status = statusForNode(node);
            const server = servers.find((s) => s.id === node.serverId);
            const isSelected = node.id === selectedNodeId;
            return (
              <g
                key={node.id}
                data-graph-node={node.id}
                data-testid={`graph-node-${node.id}`}
                transform={`translate(${pos.x} ${pos.y})`}
                onPointerDown={(e) => handlePointerDownNode(e, node.id)}
                className={`workspace-graph-node ${isSelected ? "workspace-graph-node-selected" : ""}`}
              >
                <rect
                  width={CARD_W}
                  height={CARD_H}
                  rx={10}
                  ry={10}
                  className="workspace-graph-node-body"
                />
                <circle cx={12} cy={CARD_H / 2} r={5} className={`workspace-graph-status-${status}`} />
                <text x={26} y={CARD_H / 2 - 6} className="workspace-graph-node-label">
                  {node.capabilityId ?? node.id}
                </text>
                <text x={26} y={CARD_H / 2 + 10} className="workspace-graph-node-server">
                  {server?.displayName ?? node.serverId ?? "unbound"}
                </text>
              </g>
            );
          })}
        </g>
      </svg>
    </div>
  );
}
