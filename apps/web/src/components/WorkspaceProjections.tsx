import { useEffect, useMemo, useState, type MouseEvent, type ReactNode } from "react";
import { buildInvestigationPacket, getExecutionTraces } from "../api/client";
import { parseCapabilityId } from "../api/capability-id";
import type {
  ExecutionDetail,
  ExecutionRecord,
  JsonValue,
  ServerSummary,
  TraceLinkSummary,
  WorkspaceNodePresentation,
  WorkspaceNodeRow,
  WorkspaceRunResult,
} from "../api/types";
import { RendererView, suggestKindClientSide } from "../renderer-view";

export interface WorkspaceProjectionsProps {
  projection: "grid" | "list";
  nodes: WorkspaceNodeRow[];
  servers: Map<string, ServerSummary>;
  selectedNodeId: string | null;
  selectedNodeIds: Set<string>;
  executionDetails: Map<string, ExecutionDetail>;
  executionHistory: Map<string, ExecutionRecord[]>;
  descriptions: Map<string, string>;
  runResult: WorkspaceRunResult | null;
  onSelectNode: (id: string) => void;
  onToggleSelected: (id: string) => void;
  onPresentationChange: (node: WorkspaceNodeRow, presentation: WorkspaceNodePresentation) => void;
}

export interface NodeProjectionProps extends Omit<WorkspaceProjectionsProps, "projection" | "nodes"> {
  node: WorkspaceNodeRow;
}

export function WorkspaceProjections(props: WorkspaceProjectionsProps) {
  const focusNode = props.nodes.find((node) => node.id === props.selectedNodeId && node.presentation === "focus")
    ?? props.nodes.find((node) => node.presentation === "focus");
  return (
    <>
      {props.projection === "grid" ? <GridProjection {...props} /> : <ListProjection {...props} />}
      {focusNode && (
        <div className="capability-focus" data-testid={`capability-focus-${focusNode.id}`}>
          <CapabilityInspector {...nodeProps(props, focusNode)} />
        </div>
      )}
    </>
  );
}

function GridProjection(props: WorkspaceProjectionsProps) {
  return (
    <section className="capability-grid" data-testid="workspace-grid" aria-label="Capability grid">
      {props.nodes.map((node) => <CapabilityCard key={node.id} {...nodeProps(props, node)} />)}
    </section>
  );
}

function ListProjection(props: WorkspaceProjectionsProps) {
  return (
    <div className="capability-list-wrap" data-testid="workspace-list">
      <table className="capability-list">
        <thead>
          <tr>
            <th aria-label="Selected" />
            <th>Capability</th>
            <th>Server</th>
            <th>Type</th>
            <th>Status</th>
            <th>Duration</th>
            <th>Protocol</th>
            <th>Availability</th>
            <th>Result</th>
            <th>View</th>
          </tr>
        </thead>
        <tbody>
          {props.nodes.map((node) => <CapabilityListRows key={node.id} {...nodeProps(props, node)} />)}
        </tbody>
      </table>
    </div>
  );
}

export function CapabilityInspector(props: NodeProjectionProps) {
  return <CapabilityCard {...props} forceExpanded />;
}

function CapabilityCard(props: NodeProjectionProps & { forceExpanded?: boolean }) {
  const summary = getWorkspaceNodeSummary(props);
  const isExpanded = props.forceExpanded || props.node.presentation !== "collapsed";
  return (
    <article
      className={`capability-card ${props.node.presentation} ${props.selectedNodeId === props.node.id ? "active" : ""}`}
      data-testid={`capability-card-${props.node.id}`}
    >
      <header className="capability-card-head">
        <SelectionToggle {...props} />
        <button className="capability-identity" onClick={() => props.onSelectNode(props.node.id)}>
          <strong>{summary.name}</strong>
          <span>{summary.serverName} · {summary.type}</span>
        </button>
        <span className={`status ${summary.statusClass}`}>{summary.status}</span>
      </header>
      <div className="capability-summary">
        <Metric label="Duration" value={summary.duration} />
        <Metric label="Protocol" value={summary.protocol} />
        <Metric label="Availability" value={summary.availability} tone={summary.available ? "ok" : "error"} />
        <Metric label="Result" value={summary.result} />
      </div>
      <PresentationActions {...props} />
      {isExpanded && <InspectionTabs {...props} />}
    </article>
  );
}

function CapabilityListRows(props: NodeProjectionProps) {
  const summary = getWorkspaceNodeSummary(props);
  const expanded = props.node.presentation !== "collapsed";
  return (
    <>
      <tr
        className={props.selectedNodeId === props.node.id ? "active" : ""}
        data-testid={`capability-row-${props.node.id}`}
        tabIndex={0}
        onClick={() => props.onSelectNode(props.node.id)}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") props.onSelectNode(props.node.id);
        }}
      >
        <td><SelectionToggle {...props} /></td>
        <td><strong>{summary.name}</strong></td>
        <td>{summary.serverName}</td>
        <td className="uppercase">{summary.type}</td>
        <td><span className={`status ${summary.statusClass}`}>{summary.status}</span></td>
        <td>{summary.duration}</td>
        <td>{summary.protocol}</td>
        <td className={summary.available ? "available" : "unavailable"}>{summary.availability}</td>
        <td className="result-cell">{summary.result}</td>
        <td><PresentationActions {...props} compact /></td>
      </tr>
      {expanded && (
        <tr className="capability-list-inspector">
          <td colSpan={10}><InspectionTabs {...props} /></td>
        </tr>
      )}
    </>
  );
}

function SelectionToggle(props: NodeProjectionProps) {
  return (
    <input
      type="checkbox"
      aria-label={`Select ${getCapabilityName(props.node)}`}
      data-testid={`select-${props.node.id}`}
      checked={props.selectedNodeIds.has(props.node.id)}
      onChange={() => props.onToggleSelected(props.node.id)}
      onClick={(event) => event.stopPropagation()}
    />
  );
}

function PresentationActions(props: NodeProjectionProps & { compact?: boolean }) {
  const setPresentation = (presentation: WorkspaceNodePresentation) => (event: MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    props.onPresentationChange(props.node, presentation);
  };
  return (
    <div className={`presentation-actions ${props.compact ? "compact" : ""}`}>
      {props.node.presentation === "collapsed" ? (
        <button onClick={setPresentation("expanded")}>Expand</button>
      ) : (
        <button onClick={setPresentation("collapsed")}>Collapse</button>
      )}
      {props.node.presentation !== "focus" && (
        <button data-testid={`focus-${props.node.id}`} onClick={setPresentation("focus")}>Focus</button>
      )}
      {props.node.presentation === "focus" && <button onClick={setPresentation("expanded")}>Exit focus</button>}
    </div>
  );
}

function InspectionTabs(props: NodeProjectionProps) {
  const detail = props.executionDetails.get(props.node.id);
  const round = detail?.rounds.at(-1);
  const server = props.node.serverId ? props.servers.get(props.node.serverId) : undefined;
  const history = props.executionHistory.get(props.node.id) ?? [];
  const description = props.descriptions.get(props.node.id);
  const result = parseJson(round?.resultInlineJson);
  const error = parseJson(round?.errorJson);
  const [traces, setTraces] = useState<TraceLinkSummary[] | null>(null);
  const [packet, setPacket] = useState<string | null>(null);
  const [packetError, setPacketError] = useState<string | null>(null);
  const [resultMaximized, setResultMaximized] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setTraces(null);
    if (!detail) return;
    getExecutionTraces(detail.execution.id)
      .then((response) => { if (!cancelled) setTraces(response.traces); })
      .catch(() => { if (!cancelled) setTraces([]); });
    return () => { cancelled = true; };
  }, [detail?.execution.id]);

  const tabs = useMemo(() => {
    const available: Array<{ id: string; label: string; content: ReactNode }> = [];
    if (round && (result !== undefined || round.resultArtifact || error !== undefined)) {
      available.push({
        id: "result",
        label: "Result",
        content: error !== undefined && result === undefined
          ? <pre>{formatJson(error)}</pre>
          : <RendererView value={result} resultArtifact={round.resultArtifact} suggestedRenderer={result === undefined ? undefined : suggestKindClientSide(result)} />,
      });
    }
    if (props.node.argumentsJson) {
      available.push({ id: "parameters", label: "Parameters", content: <pre>{formatArguments(props.node.argumentsJson)}</pre> });
    }
    if (description) available.push({ id: "docs", label: "Docs", content: <p className="inspection-docs">{description}</p> });
    if (server) available.push({ id: "protocol", label: "Protocol", content: <ProtocolDetails server={server} /> });
    if (traces?.length) available.push({ id: "trace", label: "Trace", content: <TraceDetails traces={traces} /> });
    if (history.length) available.push({ id: "history", label: "History", content: <HistoryDetails executions={history} /> });
    if (server) available.push({ id: "transport", label: "Transport", content: <TransportDetails server={server} /> });
    if (detail) {
      available.push({
        id: "handoff",
        label: "Agent Handoff",
        content: (
          <div className="handoff-panel">
            <p>Build a redacted investigation packet from this execution's captured evidence.</p>
            <button
              className="button primary"
              onClick={() => {
                setPacketError(null);
                void buildInvestigationPacket({ executionIds: [detail.execution.id], tier: "investigation", format: "markdown" })
                  .then((value) => setPacket(typeof value === "string" ? value : JSON.stringify(value.packet, null, 2)))
                  .catch((reason) => setPacketError(reason instanceof Error ? reason.message : String(reason)));
              }}
            >
              Build handoff
            </button>
            {packetError && <p className="form-error">{packetError}</p>}
            {packet && <pre>{packet}</pre>}
          </div>
        ),
      });
    }
    return available;
  }, [description, detail, error, history, packet, packetError, props.node.argumentsJson, result, round, server, traces]);

  const [activeTab, setActiveTab] = useState("result");
  useEffect(() => {
    if (!tabs.some((tab) => tab.id === activeTab)) setActiveTab(tabs[0]?.id ?? "");
    if (activeTab !== "result") setResultMaximized(false);
  }, [activeTab, tabs]);
  const active = tabs.find((tab) => tab.id === activeTab) ?? tabs[0];
  if (!active) return null;

  return (
    <div
      className={`inspection-tabs ${resultMaximized ? "result-maximized" : ""}`}
      data-testid={resultMaximized ? `result-focus-${props.node.id}` : undefined}
      onClick={(event) => event.stopPropagation()}
    >
      <div className="local-tabs" role="tablist" aria-label={`${getCapabilityName(props.node)} inspection`}>
        {tabs.map((tab) => (
          <button key={tab.id} data-testid={`inspection-tab-${tab.id}-${props.node.id}`} role="tab" aria-selected={tab.id === active.id} className={tab.id === active.id ? "active" : ""} onClick={() => setActiveTab(tab.id)}>
            {tab.label}
          </button>
        ))}
        {active.id === "result" && (
          <button data-testid={`maximize-result-${props.node.id}`} className="maximize-result" onClick={() => setResultMaximized((current) => !current)}>
            {resultMaximized ? "Exit result" : "Maximize result"}
          </button>
        )}
      </div>
      <div className="inspection-content" role="tabpanel">{active.content}</div>
    </div>
  );
}

function Metric({ label, value, tone }: { label: string; value: string; tone?: "ok" | "error" }) {
  return <div className={tone ? `metric ${tone}` : "metric"}><span>{label}</span><strong>{value}</strong></div>;
}

function ProtocolDetails({ server }: { server: ServerSummary }) {
  return (
    <dl className="inspection-list">
      <div><dt>Policy</dt><dd>{server.protocolPolicy}</dd></div>
      {server.negotiation?.negotiatedEra && <div><dt>Era</dt><dd>{server.negotiation.negotiatedEra}</dd></div>}
      {server.negotiation?.selectedVersion && <div><dt>Revision</dt><dd>{server.negotiation.selectedVersion}</dd></div>}
      {server.negotiation?.extensions && <div><dt>Extensions</dt><dd>{Object.keys(server.negotiation.extensions).join(", ") || "None"}</dd></div>}
    </dl>
  );
}

function TransportDetails({ server }: { server: ServerSummary }) {
  return (
    <dl className="inspection-list">
      <div><dt>Transport</dt><dd>{server.transport}</dd></div>
      {server.endpoint && <div><dt>Endpoint</dt><dd>{server.endpoint}</dd></div>}
      <div><dt>Connection</dt><dd>{server.connected ? "Connected" : "Disconnected"}</dd></div>
    </dl>
  );
}

function TraceDetails({ traces }: { traces: TraceLinkSummary[] }) {
  return (
    <ul className="trace-list">
      {traces.map(({ trace, correlationKind, confidence }) => (
        <li key={trace.id}><strong>{trace.traceId}</strong><span>{correlationKind} · {Math.round(confidence * 100)}%</span></li>
      ))}
    </ul>
  );
}

function HistoryDetails({ executions }: { executions: ExecutionRecord[] }) {
  return (
    <ul className="history-list">
      {executions.map((execution) => (
        <li key={execution.id}><span className={`status ${statusClass(execution.status)}`}>{execution.status}</span><span>{new Date(execution.startedAt).toLocaleString()}</span></li>
      ))}
    </ul>
  );
}

export function getWorkspaceNodeSummary(props: Pick<NodeProjectionProps, "node" | "servers" | "executionDetails" | "runResult">) {
  const capability = props.node.capabilityId ? parseCapabilityId(props.node.capabilityId) : null;
  const server = props.node.serverId ? props.servers.get(props.node.serverId) : undefined;
  const detail = props.executionDetails.get(props.node.id);
  const round = detail?.rounds.at(-1);
  const run = props.runResult?.nodes.find((result) => result.nodeId === props.node.id);
  const status = run ? (run.ok ? "complete" : "error") : (detail?.execution.status ?? "idle");
  const runError = run?.error ?? run?.skippedReason;
  return {
    name: capability?.name ?? props.node.capabilityId ?? "Unbound node",
    type: capability?.type ?? "unbound",
    serverName: server?.displayName ?? props.node.serverId ?? "No server",
    status,
    statusClass: statusClass(status),
    duration: formatDuration(run?.durationMs ?? round?.durationMs),
    protocol: formatProtocol(server),
    available: Boolean(server?.connected && !server.disabled && props.node.capabilityId && !runError),
    availability: runError ?? (server?.disabled ? "Disabled" : server?.connected ? "Available" : "Offline"),
    result: resultSummary(round),
  };
}

function nodeProps(props: WorkspaceProjectionsProps, node: WorkspaceNodeRow): NodeProjectionProps {
  return {
    node,
    servers: props.servers,
    selectedNodeId: props.selectedNodeId,
    selectedNodeIds: props.selectedNodeIds,
    executionDetails: props.executionDetails,
    executionHistory: props.executionHistory,
    descriptions: props.descriptions,
    runResult: props.runResult,
    onSelectNode: props.onSelectNode,
    onToggleSelected: props.onToggleSelected,
    onPresentationChange: props.onPresentationChange,
  };
}

function getCapabilityName(node: WorkspaceNodeRow) {
  return node.capabilityId ? (parseCapabilityId(node.capabilityId)?.name ?? node.capabilityId) : "unbound node";
}

function statusClass(status: string) {
  if (status === "complete" || status === "success") return "complete";
  if (status === "error" || status === "failed") return "error";
  if (status === "idle") return "idle";
  return "running";
}

function formatProtocol(server?: ServerSummary) {
  if (!server) return "Unavailable";
  const era = server.negotiation?.negotiatedEra;
  const version = server.negotiation?.selectedVersion;
  return era && version ? `${era} · ${version}` : `${server.protocolPolicy} policy`;
}

function formatDuration(duration?: number | null) {
  if (duration === undefined || duration === null) return "—";
  return duration >= 1000 ? `${(duration / 1000).toFixed(duration >= 10_000 ? 0 : 2)} s` : `${duration} ms`;
}

function resultSummary(round?: ExecutionDetail["rounds"][number]) {
  if (!round) return "No execution";
  if (round.errorJson) return "Error details";
  if (round.resultArtifact) return "Paged artifact";
  const value = parseJson(round.resultInlineJson);
  if (value === undefined) return "No result";
  const kind = suggestKindClientSide(value).replaceAll("-", " ");
  if (Array.isArray(value)) return `${kind} · ${value.length} items`;
  if (value && typeof value === "object") return `${kind} · ${Object.keys(value).length} fields`;
  return `${kind} · ${String(value).slice(0, 42)}`;
}

function parseJson(value?: string | null): JsonValue | undefined {
  if (!value) return undefined;
  try { return JSON.parse(value) as JsonValue; } catch { return value; }
}

function formatJson(value: JsonValue) {
  return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

function formatArguments(value: string) {
  try { return JSON.stringify(JSON.parse(value), null, 2); } catch { return value; }
}
