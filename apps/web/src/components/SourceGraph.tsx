import { useMemo, useRef, useState, type PointerEvent, type WheelEvent } from "react";
import type {
  SourceGraphNode,
  SourceGraphResponse,
  SourceGraphRuntimeEdge,
  SourceGraphStaticEdge,
} from "../api/types";

// Stream E — Runtime + Combined source-graph substrate. Hand-rolled SVG,
// mirroring the pan/zoom pattern of `WorkspaceGraph.tsx` without pulling
// `@xyflow/react` into the bundle. Nodes = handler symbols; static edges
// come from mapping.calls, runtime edges are observed executions.

const CARD_WIDTH = 200;
const CARD_HEIGHT = 60;
const MIN_SCALE = 0.4;
const MAX_SCALE = 2.5;
const COL_GAP = 260;
const ROW_GAP = 110;

export type SourceGraphOverlay = "runtime" | "combined";

interface Props {
  data: SourceGraphResponse;
  overlay: SourceGraphOverlay;
  selectedSymbolId: string | null;
  onSelectSymbol: (symbolId: string) => void;
}

interface Viewport { x: number; y: number; scale: number }

export function SourceGraph({ data, overlay, selectedSymbolId, onSelectSymbol }: Props) {
  const svgRef = useRef<SVGSVGElement>(null);
  const panRef = useRef<{ startX: number; startY: number; viewport: Viewport } | null>(null);
  const [viewport, setViewport] = useState<Viewport>({ x: 20, y: 20, scale: 1 });

  const positions = useMemo(() => layoutNodes(data.nodes), [data.nodes]);

  const runtimeBySymbol = useMemo(() => groupRuntime(data.runtimeEdges), [data.runtimeEdges]);
  const hasRuntimeSet = useMemo(() => new Set(data.runtimeEdges.map((e) => e.symbolId)), [data.runtimeEdges]);

  const staticEdges: SourceGraphStaticEdge[] = overlay === "runtime" ? [] : data.staticEdges;

  function handleWheel(event: WheelEvent<SVGSVGElement>) {
    event.preventDefault();
    const rect = svgRef.current?.getBoundingClientRect();
    const left = rect?.left ?? 0;
    const top = rect?.top ?? 0;
    const cursorX = event.clientX - left;
    const cursorY = event.clientY - top;
    const nextScale = clamp(viewport.scale * Math.exp(-event.deltaY * 0.001), MIN_SCALE, MAX_SCALE);
    setViewport({
      scale: nextScale,
      x: cursorX - ((cursorX - viewport.x) / viewport.scale) * nextScale,
      y: cursorY - ((cursorY - viewport.y) / viewport.scale) * nextScale,
    });
  }

  return (
    <div className="source-graph-wrap" data-testid="source-graph-wrap">
      <div className="source-graph-legend" data-testid="source-graph-legend">
        <span className="legend-swatch legend-swatch-static" /> Static (indexed calls)
        <span className="legend-swatch legend-swatch-runtime" /> Runtime (observed executions)
      </div>
      {data.nodes.length === 0 ? (
        <p className="muted" data-testid="source-graph-empty">
          No indexed handler symbols for this revision yet. Ingest a capability→handler mapping
          via <code>POST /api/v1/source/revisions/:id/index</code> to populate the graph.
        </p>
      ) : (
        <svg
          ref={svgRef}
          className="source-graph"
          data-testid="source-graph"
          role="application"
          aria-label="Source graph"
          onPointerDown={(event) => {
            if (event.button !== 0 || event.target !== event.currentTarget) return;
            panRef.current = { startX: event.clientX, startY: event.clientY, viewport };
            event.currentTarget.setPointerCapture?.(event.pointerId);
          }}
          onPointerMove={(event) => {
            const pan = panRef.current;
            if (!pan) return;
            setViewport({
              scale: pan.viewport.scale,
              x: pan.viewport.x + event.clientX - pan.startX,
              y: pan.viewport.y + event.clientY - pan.startY,
            });
          }}
          onPointerUp={(event) => {
            panRef.current = null;
            svgRef.current?.releasePointerCapture?.(event.pointerId);
          }}
          onWheel={handleWheel}
        >
          <g transform={`translate(${viewport.x} ${viewport.y}) scale(${viewport.scale})`}>
            {staticEdges.map((edge, i) => {
              const from = positions[edge.fromId];
              const to = positions[edge.toId];
              if (!from || !to) return null;
              return (
                <path
                  key={`s-${i}`}
                  className="source-graph-edge source-graph-edge-static"
                  data-testid={`source-edge-static-${edge.fromId}-${edge.toId}`}
                  d={edgePath(from, to)}
                />
              );
            })}
            {(overlay === "runtime" || overlay === "combined") &&
              data.runtimeEdges.map((edge, i) => {
                const target = positions[edge.symbolId];
                if (!target) return null;
                const originX = target.x - 90;
                const originY = target.y + CARD_HEIGHT / 2;
                return (
                  <g key={`r-${i}`} data-testid={`source-edge-runtime-${edge.executionId}`}>
                    <circle
                      className="source-graph-runtime-origin"
                      cx={originX}
                      cy={originY}
                      r={5}
                    />
                    <path
                      className={`source-graph-edge source-graph-edge-runtime source-graph-edge-runtime-${edge.status}`}
                      d={edgePath({ x: originX - 90, y: originY - CARD_HEIGHT / 2 }, target)}
                    />
                  </g>
                );
              })}
            {data.nodes.map((node) => {
              const position = positions[node.id];
              if (!position) return null;
              const selected = selectedSymbolId === node.id;
              const observed = hasRuntimeSet.has(node.id);
              return (
                <g
                  key={node.id}
                  className={`source-graph-node ${selected ? "selected" : ""} ${observed ? "observed" : ""}`}
                  data-testid={`source-graph-node-${node.id}`}
                  role="button"
                  tabIndex={0}
                  aria-label={`${node.handlerSymbol} in ${node.filePath}`}
                  transform={`translate(${position.x} ${position.y})`}
                  onPointerDown={(event) => {
                    event.stopPropagation();
                    onSelectSymbol(node.id);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") onSelectSymbol(node.id);
                  }}
                >
                  <rect
                    className="source-graph-node-card"
                    width={CARD_WIDTH}
                    height={CARD_HEIGHT}
                    rx={8}
                  />
                  <text className="source-graph-symbol" x={10} y={22}>
                    {ellipsize(node.handlerSymbol, 24)}
                  </text>
                  <text className="source-graph-file muted" x={10} y={40}>
                    {ellipsize(node.filePath, 28)}
                  </text>
                  <text className="source-graph-kind" x={CARD_WIDTH - 8} y={22} textAnchor="end">
                    {node.kind}
                  </text>
                  {observed && (
                    <text className="source-graph-runtime-count" x={CARD_WIDTH - 8} y={52} textAnchor="end">
                      {runtimeBySymbol.get(node.id) ?? 0}× runtime
                    </text>
                  )}
                </g>
              );
            })}
          </g>
        </svg>
      )}
    </div>
  );
}

interface Point { x: number; y: number }

function layoutNodes(nodes: SourceGraphNode[]): Record<string, Point> {
  // ponytail: fixed row/col grid keyed by file path. A real layered layout
  // is not the point of this slice — the substrate needs to be legible, not
  // optimal. Pan/zoom covers over any awkward placement.
  const positions: Record<string, Point> = {};
  const byFile = new Map<string, SourceGraphNode[]>();
  for (const node of nodes) {
    const bucket = byFile.get(node.filePath) ?? [];
    bucket.push(node);
    byFile.set(node.filePath, bucket);
  }
  let col = 0;
  for (const bucket of byFile.values()) {
    bucket.forEach((node, row) => {
      positions[node.id] = { x: col * COL_GAP, y: row * ROW_GAP };
    });
    col += 1;
  }
  return positions;
}

function groupRuntime(edges: SourceGraphRuntimeEdge[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const e of edges) counts.set(e.symbolId, (counts.get(e.symbolId) ?? 0) + 1);
  return counts;
}

function edgePath(from: Point, to: Point): string {
  const startX = from.x + CARD_WIDTH;
  const startY = from.y + CARD_HEIGHT / 2;
  const endX = to.x;
  const endY = to.y + CARD_HEIGHT / 2;
  return `M${startX},${startY} C${startX + 60},${startY} ${endX - 60},${endY} ${endX},${endY}`;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function ellipsize(value: string, length: number) {
  return value.length > length ? `${value.slice(0, length - 1)}…` : value;
}
