import { useEffect, useMemo, useRef, useState } from "react";
import {
  AgentRunsPage,
  CapabilitiesPage,
  CredentialsPage,
  ExecutionsPage,
  PacketsPage,
  ServersPage,
  SourcePage,
  WorkspacesPage,
} from "./pages";
import {
  createWorkspace,
  getExecution,
  getServerCapabilities,
  getWorkspace,
  listExecutions,
  listServers,
  listWorkspaces,
  runWorkspaceApi,
  updateWorkspace,
  updateWorkspaceNode,
} from "./api/client";
import { parseCapabilityId } from "./api/capability-id";
import type {
  ExecutionDetail,
  ExecutionRecord,
  ServerSummary,
  WorkspaceNodePresentation,
  WorkspaceNodeRow,
  WorkspaceRow,
  WorkspaceRunResult,
} from "./api/types";
import { CapabilityInspector, WorkspaceProjections, type NodeProjectionProps } from "./components/WorkspaceProjections";
import {
  WorkspaceGraph,
  readWorkspaceLayout,
  serializeWorkspaceLayout,
  type GraphLayout,
  type WorkspaceLayoutState,
  type WorkspaceProjection,
} from "./components/WorkspaceGraph";

const NAV_ITEMS = [
  { id: "workspace", label: "Workspace" },
  { id: "capabilities", label: "Capabilities" },
  { id: "executions", label: "Executions" },
  { id: "agent-runs", label: "Agent Runs" },
  { id: "source", label: "Source / Runtime" },
  { id: "servers", label: "Servers" },
  { id: "settings", label: "Settings" },
] as const;

type ViewId = (typeof NAV_ITEMS)[number]["id"];
type SettingsView = "workspaces" | "credentials" | "packets";

export function App() {
  const [view, setView] = useState<ViewId>("workspace");
  const [workspaces, setWorkspaces] = useState<WorkspaceRow[]>([]);
  const [servers, setServers] = useState<ServerSummary[]>([]);
  const [activeWorkspaceId, setActiveWorkspaceId] = useState<string | null>(null);
  const [activeWorkspace, setActiveWorkspace] = useState<WorkspaceRow | null>(null);
  const [workspaceRefreshKey, setWorkspaceRefreshKey] = useState(0);
  const [nodes, setNodes] = useState<WorkspaceNodeRow[]>([]);
  const [workspaceLayout, setWorkspaceLayout] = useState<WorkspaceLayoutState>(() => readWorkspaceLayout("{}"));
  const workspaceLayoutRef = useRef(workspaceLayout);
  const layoutSaveRef = useRef<Promise<void>>(Promise.resolve());
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [executionDetails, setExecutionDetails] = useState<Map<string, ExecutionDetail>>(new Map());
  const [executionHistory, setExecutionHistory] = useState<Map<string, ExecutionRecord[]>>(new Map());
  const [descriptions, setDescriptions] = useState<Map<string, string>>(new Map());
  const [runResult, setRunResult] = useState<WorkspaceRunResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [workspaceLoading, setWorkspaceLoading] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function loadShell() {
    setLoading(true);
    setError(null);
    Promise.all([listWorkspaces(), listServers()])
      .then(([workspaceResult, serverResult]) => {
        setWorkspaces(workspaceResult.workspaces);
        setServers(serverResult.servers);
        setActiveWorkspaceId((current) => {
          if (current && workspaceResult.workspaces.some((workspace) => workspace.id === current)) return current;
          return workspaceResult.workspaces[0]?.id ?? null;
        });
      })
      .catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)))
      .finally(() => setLoading(false));
  }

  useEffect(loadShell, []);

  useEffect(() => {
    if (!activeWorkspaceId) {
      setActiveWorkspace(null);
      setNodes([]);
      setSelectedNodeId(null);
      setWorkspaceLayoutState(readWorkspaceLayout("{}"));
      setWorkspaceLoading(false);
      return;
    }

    let cancelled = false;
    setActiveWorkspace(null);
    setNodes([]);
    setSelectedNodeId(null);
    setWorkspaceLayoutState(readWorkspaceLayout("{}"));
    setExecutionDetails(new Map());
    setExecutionHistory(new Map());
    setDescriptions(new Map());
    setWorkspaceLoading(true);
    getWorkspace(activeWorkspaceId)
      .then((result) => {
        if (cancelled) return;
        const nodeIds = new Set(result.nodes.map((node) => node.id));
        const layout = readWorkspaceLayout(result.workspace.layoutJson);
        layout.selectedNodeIds = layout.selectedNodeIds.filter((id) => nodeIds.has(id));
        setActiveWorkspace(result.workspace);
        setNodes(result.nodes);
        setWorkspaceLayoutState(layout);
        setSelectedNodeId(layout.selectedNodeIds[0] ?? result.nodes[0]?.id ?? null);
      })
      .catch((reason) => {
        if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason));
      })
      .finally(() => {
        if (!cancelled) setWorkspaceLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [activeWorkspaceId, workspaceRefreshKey]);

  const selectedNode = nodes.find((node) => node.id === selectedNodeId) ?? null;
  const selectedNodeIds = useMemo(() => new Set(workspaceLayout.selectedNodeIds), [workspaceLayout.selectedNodeIds]);
  const projection = workspaceLayout.projection;
  const serversById = useMemo(() => new Map(servers.map((server) => [server.id, server])), [servers]);
  const connectedServers = servers.filter((server) => server.connected);

  function setWorkspaceLayoutState(next: WorkspaceLayoutState) {
    workspaceLayoutRef.current = next;
    setWorkspaceLayout(next);
  }

  function commitWorkspaceLayout(update: (current: WorkspaceLayoutState) => WorkspaceLayoutState) {
    if (!activeWorkspaceId) return;
    const workspaceId = activeWorkspaceId;
    const next = update(workspaceLayoutRef.current);
    setWorkspaceLayoutState(next);
    const layoutJson = serializeWorkspaceLayout(next);
    layoutSaveRef.current = layoutSaveRef.current.then(async () => {
      try {
        const { workspace } = await updateWorkspace(workspaceId, { layoutJson });
        setActiveWorkspace((current) => current?.id === workspaceId ? workspace : current);
        setWorkspaces((current) => current.map((item) => item.id === workspaceId ? workspace : item));
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : String(reason));
      }
    });
  }

  useEffect(() => {
    if (!activeWorkspaceId || nodes.length === 0) return;
    let cancelled = false;
    const nodeIds = new Set(nodes.map((node) => node.id));
    const serverIds = [...new Set(nodes.flatMap((node) => node.serverId ? [node.serverId] : []))];

    // ponytail: bounded latest-history scan; add cursor paging when the API exposes it.
    void Promise.all([
      listExecutions({ limit: 500 }),
      Promise.all(serverIds.map(async (serverId) => [serverId, await getServerCapabilities(serverId)] as const)),
    ]).then(async ([executionResult, capabilitiesByServer]) => {
      if (cancelled) return;
      const history = new Map<string, ExecutionRecord[]>();
      for (const execution of executionResult.executions) {
        if (execution.workspaceId !== activeWorkspaceId || !execution.workspaceNodeId || !nodeIds.has(execution.workspaceNodeId)) continue;
        history.set(execution.workspaceNodeId, [...(history.get(execution.workspaceNodeId) ?? []), execution]);
      }
      setExecutionHistory(history);

      const details = new Map<string, ExecutionDetail>();
      await Promise.all([...history].map(async ([nodeId, executions]) => {
        const latest = executions[0];
        if (!latest) return;
        try {
          details.set(nodeId, await getExecution(latest.id));
        } catch {
          // The compact execution row still provides status when detail evidence is unavailable.
        }
      }));
      if (!cancelled) setExecutionDetails(details);

      const docs = new Map<string, string>();
      for (const node of nodes) {
        if (!node.serverId || !node.capabilityId) continue;
        const parsed = parseCapabilityId(node.capabilityId);
        const capabilities = capabilitiesByServer.find(([serverId]) => serverId === node.serverId)?.[1];
        if (!parsed || !capabilities) continue;
        const definition = parsed.type === "tool"
          ? capabilities.tools.find((item) => item.name === parsed.name)
          : parsed.type === "prompt"
            ? capabilities.prompts.find((item) => item.name === parsed.name)
            : capabilities.resources.find((item) => item.uri === parsed.name || item.name === parsed.name);
        if (definition?.description) docs.set(node.id, definition.description);
      }
      if (!cancelled) setDescriptions(docs);
    }).catch((reason) => {
      if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason));
    });

    return () => { cancelled = true; };
  }, [activeWorkspaceId, nodes]);

  async function createFirstWorkspace(name: string) {
    setError(null);
    try {
      const { workspace } = await createWorkspace({ name });
      setWorkspaces((current) => [workspace, ...current]);
      setActiveWorkspaceId(workspace.id);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }

  function navigate(next: ViewId) {
    setView(next);
    if (next === "workspace") {
      setWorkspaceLoading(true);
      setWorkspaceRefreshKey((current) => current + 1);
      loadShell();
    }
  }

  const workspaceReady = activeWorkspace?.id === activeWorkspaceId && !workspaceLoading;

  async function runNodes(nodeIds?: string[]) {
    if (!activeWorkspaceId || !workspaceReady || nodes.length === 0) return;
    setRunning(true);
    setError(null);
    try {
      const result = await runWorkspaceApi(activeWorkspaceId, nodeIds ? { nodeIds } : {});
      setRunResult(result);
      const settledDetails = await Promise.allSettled(
        result.nodes.flatMap((node) => node.executionId ? [getExecution(node.executionId)] : []),
      );
      const details = settledDetails.flatMap((item) => item.status === "fulfilled" ? [item.value] : []);
      setExecutionDetails((current) => {
        const next = new Map(current);
        for (const detail of details) {
          if (detail.execution.workspaceNodeId) next.set(detail.execution.workspaceNodeId, detail);
        }
        return next;
      });
      setExecutionHistory((current) => {
        const next = new Map(current);
        for (const detail of details) {
          const nodeId = detail.execution.workspaceNodeId;
          if (nodeId) next.set(nodeId, [detail.execution, ...(next.get(nodeId) ?? []).filter((item) => item.id !== detail.execution.id)]);
        }
        return next;
      });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setRunning(false);
    }
  }

  function toggleSelectedNode(nodeId: string) {
    commitWorkspaceLayout((current) => {
      const selected = new Set(current.selectedNodeIds);
      if (selected.has(nodeId)) selected.delete(nodeId); else selected.add(nodeId);
      return { ...current, selectedNodeIds: [...selected] };
    });
  }

  function selectGraphNode(nodeId: string, additive: boolean) {
    setSelectedNodeId(nodeId);
    commitWorkspaceLayout((current) => {
      const selected = additive ? new Set(current.selectedNodeIds) : new Set<string>();
      if (additive && selected.has(nodeId)) selected.delete(nodeId); else selected.add(nodeId);
      return { ...current, selectedNodeIds: [...selected] };
    });
  }

  function changeProjection(projection: WorkspaceProjection) {
    commitWorkspaceLayout((current) => ({ ...current, projection }));
  }

  function changeGraphLayout(graph: GraphLayout) {
    commitWorkspaceLayout((current) => ({ ...current, graph }));
  }

  async function changePresentation(node: WorkspaceNodeRow, presentation: WorkspaceNodePresentation) {
    if (!activeWorkspaceId) return;
    setError(null);
    try {
      const { node: updated } = await updateWorkspaceNode(activeWorkspaceId, node.id, { presentation });
      setNodes((current) => current.map((item) => item.id === updated.id ? updated : item));
      setSelectedNodeId(updated.id);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }

  const showWorkspace = view === "workspace";

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">
          <span className="logo" aria-hidden="true">X</span>
          <strong>MCP Inspector X</strong>
        </div>
        <label className="workspace-picker">
          <span className="sr-only">Active workspace</span>
          <select
            value={activeWorkspaceId ?? ""}
            onChange={(event) => {
              setActiveWorkspaceId(event.target.value || null);
              setView("workspace");
              setRunResult(null);
            }}
            disabled={workspaces.length === 0}
          >
            {workspaces.length === 0 && <option value="">No workspace</option>}
            {workspaces.map((workspace) => (
              <option key={workspace.id} value={workspace.id}>{workspace.name}</option>
            ))}
          </select>
        </label>
        <div className="topbar-spacer" />
        <span className="protocol-chip">{protocolSummary(connectedServers)}</span>
        <button className="button primary" onClick={() => void runNodes()} disabled={!showWorkspace || !workspaceReady || nodes.length === 0 || running}>
          {running ? "Running…" : "Run All"}
        </button>
      </header>

      <aside className="sidebar" aria-label="Primary navigation">
        <p className="eyebrow">Explore</p>
        {NAV_ITEMS.slice(0, 5).map((item) => (
          <NavButton key={item.id} item={item} active={view === item.id} onSelect={navigate} />
        ))}

        <p className="eyebrow">Servers</p>
        {servers.length === 0 && <span className="sidebar-empty">No configured servers</span>}
        {servers.slice(0, 6).map((server) => (
          <button key={server.id} className="nav server-nav" onClick={() => setView("servers")}>
            <span className={`connection-dot ${server.connected ? "online" : "offline"}`} />
            <span>{server.displayName}</span>
          </button>
        ))}
        <NavButton item={NAV_ITEMS[5]} active={view === "servers"} onSelect={navigate} />

        <p className="eyebrow">Manage</p>
        <NavButton item={NAV_ITEMS[6]} active={view === "settings"} onSelect={navigate} />
      </aside>

      {showWorkspace ? (
        <div className="shell-main">
          <WorkspaceCanvas
            workspace={activeWorkspace}
            nodes={nodes}
            servers={serversById}
            selectedNodeId={selectedNodeId}
            selectedNodeIds={selectedNodeIds}
            projection={projection}
            graphLayout={workspaceLayout.graph}
            executionDetails={executionDetails}
            executionHistory={executionHistory}
            descriptions={descriptions}
            runResult={runResult}
            loading={loading || workspaceLoading}
            running={running}
            error={error}
            onSelectNode={setSelectedNodeId}
            onToggleSelected={toggleSelectedNode}
            onSelectGraphNode={selectGraphNode}
            onProjectionChange={changeProjection}
            onGraphLayoutChange={changeGraphLayout}
            onPresentationChange={(node, presentation) => void changePresentation(node, presentation)}
            onRunSelected={() => void runNodes([...selectedNodeIds])}
            onCreateWorkspace={createFirstWorkspace}
            onOpenManager={() => setView("settings")}
          />
          <WorkspaceDetailPane
            node={selectedNode}
            servers={serversById}
            selectedNodeId={selectedNodeId}
            selectedNodeIds={selectedNodeIds}
            executionDetails={executionDetails}
            executionHistory={executionHistory}
            descriptions={descriptions}
            runResult={runResult}
            onSelectNode={setSelectedNodeId}
            onToggleSelected={toggleSelectedNode}
            onPresentationChange={(node, presentation) => void changePresentation(node, presentation)}
          />
        </div>
      ) : (
        <main className="legacy-workspace">{renderView(view)}</main>
      )}

      <footer className="status-footer">
        <span>{activeWorkspace ? activeWorkspace.name : "No workspace"}</span>
        <span>{nodes.length} nodes</span>
        <span>{selectedNodeIds.size} selected</span>
        {runResult && <span>{runResult.nodes.filter((node) => node.ok).length} succeeded</span>}
        {runResult && <span>{runResult.nodes.filter((node) => !node.ok).length} failed</span>}
        <span className="topbar-spacer" />
        <span>{connectedServers.length} / {servers.length} servers online</span>
      </footer>
    </div>
  );
}

function NavButton({
  item,
  active,
  onSelect,
}: {
  item: (typeof NAV_ITEMS)[number];
  active: boolean;
  onSelect: (id: ViewId) => void;
}) {
  return (
    <button
      data-testid={`nav-${item.id}`}
      className={`nav ${active ? "active" : ""}`}
      onClick={() => onSelect(item.id)}
    >
      {item.label}
    </button>
  );
}

function WorkspaceCanvas({
  workspace,
  nodes,
  servers,
  selectedNodeId,
  selectedNodeIds,
  projection,
  graphLayout,
  executionDetails,
  executionHistory,
  descriptions,
  runResult,
  loading,
  running,
  error,
  onSelectNode,
  onToggleSelected,
  onSelectGraphNode,
  onProjectionChange,
  onGraphLayoutChange,
  onPresentationChange,
  onRunSelected,
  onCreateWorkspace,
  onOpenManager,
}: {
  workspace: WorkspaceRow | null;
  nodes: WorkspaceNodeRow[];
  servers: Map<string, ServerSummary>;
  selectedNodeId: string | null;
  selectedNodeIds: Set<string>;
  projection: WorkspaceProjection;
  graphLayout: GraphLayout;
  executionDetails: Map<string, ExecutionDetail>;
  executionHistory: Map<string, ExecutionRecord[]>;
  descriptions: Map<string, string>;
  runResult: WorkspaceRunResult | null;
  loading: boolean;
  running: boolean;
  error: string | null;
  onSelectNode: (id: string) => void;
  onToggleSelected: (id: string) => void;
  onSelectGraphNode: (id: string, additive: boolean) => void;
  onProjectionChange: (projection: WorkspaceProjection) => void;
  onGraphLayoutChange: (layout: GraphLayout) => void;
  onPresentationChange: (node: WorkspaceNodeRow, presentation: WorkspaceNodePresentation) => void;
  onRunSelected: () => void;
  onCreateWorkspace: (name: string) => Promise<void>;
  onOpenManager: () => void;
}) {
  const [newWorkspaceName, setNewWorkspaceName] = useState("");

  return (
    <main className="workspace-canvas" data-testid="workspace-page">
      <div className="workspace-toolbar">
        <div className="segmented" aria-label="Workspace projection">
          {(["graph", "grid", "list"] as const).map((item) => (
            <button
              key={item}
              data-testid={`projection-${item}`}
              className={projection === item ? "active" : ""}
              aria-pressed={projection === item}
              onClick={() => onProjectionChange(item)}
            >
              {item}
            </button>
          ))}
        </div>
        <span className="muted">{nodes.length} nodes · {selectedNodeIds.size} selected</span>
        <div className="topbar-spacer" />
        <button data-testid="run-selected" className="button" onClick={onRunSelected} disabled={selectedNodeIds.size === 0 || running}>Run selected</button>
        <button className="button" onClick={onOpenManager}>Manage workspace</button>
      </div>

      <div className={`canvas-scroll ${projection === "graph" ? "graph-mode" : ""}`}>
        {error && <p className="form-error canvas-message">{error}</p>}
        {loading && <p className="muted canvas-message">Loading durable workspace…</p>}
        {!loading && !workspace && (
          <form
            className="workspace-empty"
            onSubmit={(event) => {
              event.preventDefault();
              const name = newWorkspaceName.trim();
              if (!name) return;
              void onCreateWorkspace(name).then(() => setNewWorkspaceName(""));
            }}
          >
            <strong>Create your first workspace</strong>
            <p>Workspaces keep MCP capabilities, arguments, and presentation state in the local product database.</p>
            <div className="field-row">
              <label>
                Workspace name
                <input value={newWorkspaceName} onChange={(event) => setNewWorkspaceName(event.target.value)} required />
              </label>
              <button className="button primary" type="submit">Create workspace</button>
            </div>
          </form>
        )}
        {workspace && nodes.length === 0 && (
          <div className="workspace-empty">
            <strong>This workspace is empty</strong>
            <p>Add a capability through the workspace manager to begin inspecting it here.</p>
            <button className="button" onClick={onOpenManager}>Open workspace manager</button>
          </div>
        )}
        {workspace && nodes.length > 0 && projection === "graph" && (
          <WorkspaceGraph
            nodes={nodes}
            servers={servers}
            selectedNodeId={selectedNodeId}
            selectedNodeIds={selectedNodeIds}
            executionDetails={executionDetails}
            runResult={runResult}
            edges={[]}
            layout={graphLayout}
            onSelectNode={onSelectGraphNode}
            onLayoutChange={onGraphLayoutChange}
          />
        )}
        {workspace && nodes.length > 0 && projection !== "graph" && (
          <WorkspaceProjections
            projection={projection}
            nodes={nodes}
            servers={servers}
            selectedNodeId={selectedNodeId}
            selectedNodeIds={selectedNodeIds}
            executionDetails={executionDetails}
            executionHistory={executionHistory}
            descriptions={descriptions}
            runResult={runResult}
            onSelectNode={onSelectNode}
            onToggleSelected={onToggleSelected}
            onPresentationChange={onPresentationChange}
          />
        )}
      </div>
    </main>
  );
}

function WorkspaceDetailPane({ node, ...props }: { node: WorkspaceNodeRow | null } & Omit<NodeProjectionProps, "node">) {
  return (
    <aside className="detail-pane" data-testid="workspace-detail-pane">
      <div className="detail-head">
        <span className="muted">{node ? "Selected capability" : "Workspace details"}</span>
        <h2>{node?.capabilityId ? (parseCapabilityId(node.capabilityId)?.name ?? node.capabilityId) : (node ? "Unbound node" : "Nothing selected")}</h2>
      </div>
      {node ? <CapabilityInspector node={node} {...props} /> : (
        <p className="detail-empty">Select a workspace node to inspect its persisted configuration.</p>
      )}
    </aside>
  );
}

function SettingsSurface() {
  const [settingsView, setSettingsView] = useState<SettingsView>("workspaces");
  return (
    <div className="settings-surface">
      <div className="settings-tabs" role="tablist" aria-label="Legacy administration surfaces">
        {(["workspaces", "credentials", "packets"] as const).map((id) => (
          <button key={id} className={settingsView === id ? "active" : ""} onClick={() => setSettingsView(id)}>
            {id === "workspaces" ? "Workspace manager" : id === "credentials" ? "Credentials" : "Investigation packets"}
          </button>
        ))}
      </div>
      {settingsView === "workspaces" && <WorkspacesPage />}
      {settingsView === "credentials" && <CredentialsPage />}
      {settingsView === "packets" && <PacketsPage />}
    </div>
  );
}

function renderView(view: Exclude<ViewId, "workspace">) {
  switch (view) {
    case "capabilities":
      return <CapabilitiesPage />;
    case "servers":
      return <ServersPage />;
    case "executions":
      return <ExecutionsPage />;
    case "agent-runs":
      return <AgentRunsPage />;
    case "source":
      return <SourcePage />;
    case "settings":
      return <SettingsSurface />;
  }
}

function protocolSummary(servers: ServerSummary[]) {
  if (servers.length === 0) return "No servers online";
  const labels = new Set(
    servers.map((server) => {
      const negotiation = server.negotiation;
      if (!negotiation) return server.protocolPolicy;
      return `${negotiation.negotiatedEra} · ${negotiation.selectedVersion}`;
    }),
  );
  return labels.size === 1 ? [...labels][0] : "Mixed protocols";
}
