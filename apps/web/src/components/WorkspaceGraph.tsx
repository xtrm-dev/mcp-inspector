import { useEffect, useMemo, useRef, useState, type PointerEvent, type WheelEvent } from "react";
import type { WorkspaceEdge } from "@mcp-inspector-x/workspace";
import type { ServerSummary, WorkspaceNodeRow } from "../api/types";
import { getWorkspaceNodeSummary } from "./WorkspaceProjections";

const CARD_WIDTH = 180;
const CARD_HEIGHT = 64;
const SNAP = 20;
const MIN_SCALE = 0.25;
const MAX_SCALE = 2.5;

export type WorkspaceProjection = "graph" | "grid" | "list";
export type GraphGrouping = "server" | "none";
export interface GraphPosition { x: number; y: number }
export interface GraphViewport { x: number; y: number; scale: number }
export interface GraphLayout {
  positions: Record<string, GraphPosition>;
  viewport: GraphViewport;
  groupBy: GraphGrouping;
}
export interface WorkspaceLayoutState {
  raw: Record<string, unknown>;
  projection: WorkspaceProjection;
  selectedNodeIds: string[];
  graph: GraphLayout;
}

interface WorkspaceGraphProps {
  nodes: WorkspaceNodeRow[];
  servers: Map<string, ServerSummary>;
  selectedNodeId: string | null;
  selectedNodeIds: Set<string>;
  executionDetails: Parameters<typeof getWorkspaceNodeSummary>[0]["executionDetails"];
  runResult: Parameters<typeof getWorkspaceNodeSummary>[0]["runResult"];
  edges: WorkspaceEdge[];
  layout: GraphLayout;
  onSelectNode: (id: string, additive: boolean) => void;
  onLayoutChange: (layout: GraphLayout) => void;
}

type PointerAction =
  | { kind: "pan"; startX: number; startY: number; viewport: GraphViewport }
  | { kind: "node"; id: string; startX: number; startY: number; position: GraphPosition; additive: boolean; moved: boolean };

export function WorkspaceGraph(props: WorkspaceGraphProps) {
  const svgRef = useRef<SVGSVGElement>(null);
  const actionRef = useRef<PointerAction | null>(null);
  const [positions, setPositions] = useState(() => placeNodes(props.nodes, props.layout.positions, props.layout.groupBy));
  const [viewport, setViewport] = useState(props.layout.viewport);
  const [groupBy, setGroupBy] = useState(props.layout.groupBy);
  const positionsRef = useRef(positions);
  const viewportRef = useRef(viewport);

  useEffect(() => {
    const next = placeNodes(props.nodes, props.layout.positions, props.layout.groupBy);
    positionsRef.current = next;
    setPositions(next);
    viewportRef.current = props.layout.viewport;
    setViewport(props.layout.viewport);
    setGroupBy(props.layout.groupBy);
    if (Object.keys(next).length !== Object.keys(props.layout.positions).length) {
      props.onLayoutChange({ ...props.layout, positions: next });
    }
  }, [props.nodes, props.layout]);

  const groups = useMemo(() => graphGroups(props.nodes, positions, props.servers, groupBy), [groupBy, positions, props.nodes, props.servers]);

  function persist(nextPositions = positionsRef.current, nextViewport = viewportRef.current, nextGroupBy = groupBy) {
    props.onLayoutChange({ positions: nextPositions, viewport: nextViewport, groupBy: nextGroupBy });
  }

  function setNextViewport(next: GraphViewport, shouldPersist = false) {
    viewportRef.current = next;
    setViewport(next);
    if (shouldPersist) persist(positionsRef.current, next);
  }

  function fit(ids = props.nodes.map((node) => node.id)) {
    const next = fitViewport(ids, positionsRef.current, svgRef.current?.getBoundingClientRect());
    setNextViewport(next, true);
  }

  function handlePointerMove(event: PointerEvent<SVGSVGElement>) {
    const action = actionRef.current;
    if (!action) return;
    if (action.kind === "pan") {
      setNextViewport({
        ...action.viewport,
        x: action.viewport.x + event.clientX - action.startX,
        y: action.viewport.y + event.clientY - action.startY,
      });
      return;
    }
    const scale = viewportRef.current.scale;
    const next = {
      x: snap(action.position.x + (event.clientX - action.startX) / scale),
      y: snap(action.position.y + (event.clientY - action.startY) / scale),
    };
    action.moved ||= Math.abs(event.clientX - action.startX) + Math.abs(event.clientY - action.startY) > 3;
    const nextPositions = { ...positionsRef.current, [action.id]: next };
    positionsRef.current = nextPositions;
    setPositions(nextPositions);
  }

  function handlePointerUp(event: PointerEvent<SVGSVGElement>) {
    const action = actionRef.current;
    if (!action) return;
    actionRef.current = null;
    svgRef.current?.releasePointerCapture?.(event.pointerId);
    if (action.kind === "pan") persist();
    else if (action.moved) persist();
    else props.onSelectNode(action.id, action.additive);
  }

  function handleWheel(event: WheelEvent<SVGSVGElement>) {
    event.preventDefault();
    const rect = svgRef.current?.getBoundingClientRect();
    const left = rect?.left ?? 0;
    const top = rect?.top ?? 0;
    const cursorX = event.clientX - left;
    const cursorY = event.clientY - top;
    const current = viewportRef.current;
    const scale = clamp(current.scale * Math.exp(-event.deltaY * 0.001), MIN_SCALE, MAX_SCALE);
    setNextViewport({
      scale,
      x: cursorX - ((cursorX - current.x) / current.scale) * scale,
      y: cursorY - ((cursorY - current.y) / current.scale) * scale,
    }, true);
  }

  function reset() {
    const nextPositions = placeNodes(props.nodes, {}, groupBy);
    positionsRef.current = nextPositions;
    setPositions(nextPositions);
    const nextViewport = fitViewport(props.nodes.map((node) => node.id), nextPositions, svgRef.current?.getBoundingClientRect());
    viewportRef.current = nextViewport;
    setViewport(nextViewport);
    persist(nextPositions, nextViewport);
  }

  return (
    <section className="workspace-graph-wrap" data-testid="workspace-graph-wrap">
      <div className="workspace-graph-controls">
        <button className="button" onClick={() => fit()}>Fit</button>
        <button className="button" onClick={() => fit([...props.selectedNodeIds])} disabled={props.selectedNodeIds.size === 0}>Fit selected</button>
        <button className="button" data-testid="graph-reset" onClick={reset}>Reset layout</button>
        <label>Group
          <select
            value={groupBy}
            onChange={(event) => {
              const nextGroup = event.target.value as GraphGrouping;
              const nextPositions = placeNodes(props.nodes, {}, nextGroup);
              setGroupBy(nextGroup);
              positionsRef.current = nextPositions;
              setPositions(nextPositions);
              persist(nextPositions, viewportRef.current, nextGroup);
            }}
          >
            <option value="server">Server</option>
            <option value="none">None</option>
          </select>
        </label>
      </div>
      <svg
        ref={svgRef}
        className={`workspace-graph ${actionRef.current ? "interacting" : ""}`}
        data-testid="workspace-graph"
        role="application"
        aria-label="Workspace graph"
        onPointerDown={(event) => {
          if (event.button !== 0 || event.target !== event.currentTarget) return;
          actionRef.current = { kind: "pan", startX: event.clientX, startY: event.clientY, viewport: viewportRef.current };
          event.currentTarget.setPointerCapture?.(event.pointerId);
        }}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        onWheel={handleWheel}
      >
        <defs>
          <pattern id="workspace-graph-grid" width={SNAP} height={SNAP} patternUnits="userSpaceOnUse">
            <circle cx="1" cy="1" r="1" />
          </pattern>
        </defs>
        <rect className="workspace-graph-grid" width="100%" height="100%" fill="url(#workspace-graph-grid)" />
        <g className="workspace-graph-world" transform={`translate(${viewport.x} ${viewport.y}) scale(${viewport.scale})`}>
          {groups.map((group) => (
            <g key={group.id} className="workspace-graph-group">
              <rect x={group.x} y={group.y} width={group.width} height={group.height} rx="12" />
              <text x={group.x + 12} y={group.y + 20}>{group.label}</text>
            </g>
          ))}
          {props.edges.map((edge) => {
            const from = positions[edge.fromNodeId];
            const to = positions[edge.toNodeId];
            if (!from || !to) return null;
            const startX = from.x + CARD_WIDTH;
            const startY = from.y + CARD_HEIGHT / 2;
            const endX = to.x;
            const endY = to.y + CARD_HEIGHT / 2;
            return <path key={edge.id} className="workspace-graph-edge" d={`M${startX},${startY} C${startX + 50},${startY} ${endX - 50},${endY} ${endX},${endY}`} />;
          })}
          {props.nodes.map((node) => {
            const position = positions[node.id];
            if (!position) return null;
            const summary = getWorkspaceNodeSummary({ node, servers: props.servers, executionDetails: props.executionDetails, runResult: props.runResult });
            const selected = props.selectedNodeIds.has(node.id);
            const active = props.selectedNodeId === node.id;
            return (
              <g
                key={node.id}
                className={`workspace-graph-node ${selected ? "selected" : ""} ${active ? "active" : ""}`}
                data-testid={`graph-node-${node.id}`}
                role="button"
                tabIndex={0}
                aria-label={`${summary.serverName} ${summary.name}`}
                transform={`translate(${position.x} ${position.y})`}
                onPointerDown={(event) => {
                  if (event.button !== 0) return;
                  event.stopPropagation();
                  actionRef.current = {
                    kind: "node",
                    id: node.id,
                    startX: event.clientX,
                    startY: event.clientY,
                    position,
                    additive: event.ctrlKey || event.metaKey || event.shiftKey,
                    moved: false,
                  };
                  svgRef.current?.setPointerCapture?.(event.pointerId);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") props.onSelectNode(node.id, event.ctrlKey || event.metaKey || event.shiftKey);
                }}
              >
                <rect className="workspace-graph-node-card" width={CARD_WIDTH} height={CARD_HEIGHT} rx="9" />
                <rect className="workspace-graph-server-chip" x="10" y="9" width="104" height="18" rx="9" />
                <text className="workspace-graph-server" x="18" y="22">{ellipsize(summary.serverName, 16)}</text>
                <circle className={`workspace-graph-status ${summary.statusClass}`} cx="162" cy="18" r="5" />
                <text className="workspace-graph-capability" x="12" y="47">{ellipsize(summary.name, 23)}</text>
                <text className="workspace-graph-kind" x="168" y="48" textAnchor="end">{ellipsize(summary.type, 9)}</text>
                <rect className="workspace-graph-selection" x="160" y="51" width="10" height="10" rx="2" />
                {selected && <path className="workspace-graph-check" d="M162 56 l2 2 l4 -5" />}
              </g>
            );
          })}
        </g>
      </svg>
    </section>
  );
}

export function readWorkspaceLayout(raw: string): WorkspaceLayoutState {
  const value = parseObject(raw);
  const graph = objectValue(value.graph);
  const positions = objectValue(graph.positions);
  const viewport = objectValue(graph.viewport);
  return {
    raw: value,
    projection: value.projection === "graph" || value.projection === "list" ? value.projection : "grid",
    selectedNodeIds: Array.isArray(value.selectedNodeIds) ? value.selectedNodeIds.filter((id): id is string => typeof id === "string") : [],
    graph: {
      positions: Object.fromEntries(Object.entries(positions).flatMap(([id, position]) => {
        const point = objectValue(position);
        return finite(point.x) && finite(point.y) ? [[id, { x: point.x, y: point.y }]] : [];
      })),
      viewport: {
        x: finite(viewport.x) ? viewport.x : 0,
        y: finite(viewport.y) ? viewport.y : 0,
        scale: finite(viewport.scale) ? clamp(viewport.scale, MIN_SCALE, MAX_SCALE) : 1,
      },
      groupBy: graph.groupBy === "none" ? "none" : "server",
    },
  };
}

export function serializeWorkspaceLayout(layout: WorkspaceLayoutState) {
  const graph = objectValue(layout.raw.graph);
  return JSON.stringify({
    ...layout.raw,
    projection: layout.projection,
    selectedNodeIds: layout.selectedNodeIds,
    graph: { ...graph, ...layout.graph },
  });
}

export function placeNodes(nodes: WorkspaceNodeRow[], saved: Record<string, GraphPosition>, groupBy: GraphGrouping) {
  const positions: Record<string, GraphPosition> = {};
  const groups = groupBy === "server"
    ? [...new Set(nodes.map((node) => node.serverId ?? "unbound"))].map((id) => nodes.filter((node) => (node.serverId ?? "unbound") === id))
    : [nodes];
  let groupY = 60;
  for (const group of groups) {
    group.forEach((node, index) => {
      positions[node.id] = saved[node.id] ?? { x: 60 + (index % 4) * 220, y: groupY + Math.floor(index / 4) * 100 };
    });
    groupY += Math.max(1, Math.ceil(group.length / 4)) * 100 + 60;
  }
  return positions;
}

function fitViewport(ids: string[], positions: Record<string, GraphPosition>, rect?: Pick<DOMRect, "width" | "height">): GraphViewport {
  const points = ids.map((id) => positions[id]).filter((point): point is GraphPosition => point !== undefined);
  if (points.length === 0) return { x: 0, y: 0, scale: 1 };
  const minX = Math.min(...points.map((point) => point.x));
  const minY = Math.min(...points.map((point) => point.y));
  const maxX = Math.max(...points.map((point) => point.x + CARD_WIDTH));
  const maxY = Math.max(...points.map((point) => point.y + CARD_HEIGHT));
  const width = rect?.width || 800;
  const height = rect?.height || 600;
  const scale = clamp(Math.min((width - 80) / (maxX - minX), (height - 80) / (maxY - minY)), MIN_SCALE, 1.8);
  return {
    scale,
    x: (width - (maxX - minX) * scale) / 2 - minX * scale,
    y: (height - (maxY - minY) * scale) / 2 - minY * scale,
  };
}

function graphGroups(nodes: WorkspaceNodeRow[], positions: Record<string, GraphPosition>, servers: Map<string, ServerSummary>, groupBy: GraphGrouping) {
  if (groupBy === "none") return [];
  return [...new Set(nodes.map((node) => node.serverId ?? "unbound"))].flatMap((serverId) => {
    const grouped = nodes
      .filter((node) => (node.serverId ?? "unbound") === serverId)
      .map((node) => positions[node.id])
      .filter((point): point is GraphPosition => point !== undefined);
    if (grouped.length === 0) return [];
    const x = Math.min(...grouped.map((point) => point.x)) - 20;
    const y = Math.min(...grouped.map((point) => point.y)) - 36;
    const right = Math.max(...grouped.map((point) => point.x + CARD_WIDTH)) + 20;
    const bottom = Math.max(...grouped.map((point) => point.y + CARD_HEIGHT)) + 20;
    return [{ id: serverId, label: servers.get(serverId)?.displayName ?? (serverId === "unbound" ? "No server" : serverId), x, y, width: right - x, height: bottom - y }];
  });
}

function parseObject(raw: string): Record<string, unknown> {
  try { return objectValue(JSON.parse(raw)); } catch { return {}; }
}

function objectValue(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function snap(value: number) {
  return Math.round(value / SNAP) * SNAP;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function ellipsize(value: string, length: number) {
  return value.length > length ? `${value.slice(0, length - 1)}…` : value;
}
