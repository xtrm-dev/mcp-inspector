import { useEffect, useMemo, useState } from "react";
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
import { WorkspaceProjections, type WorkspaceProjection } from "./components/WorkspaceProjections";

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
  const [projection, setProjection] = useState<WorkspaceProjection>("grid");
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [selectedNodeIds, setSelectedNodeIds] = useState<Set<string>>(new Set());
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
      setSelectedNodeIds(new Set());
      setWorkspaceLoading(false);
      return;
    }

    let cancelled = false;
    setActiveWorkspace(null);
    setNodes([]);
    setSelectedNodeId(null);
    setSelectedNodeIds(new Set());
    setExecutionDetails(new Map());
    setExecutionHistory(new Map());
    setDescriptions(new Map());
    setWorkspaceLoading(true);
    getWorkspace(activeWorkspaceId)
      .then((result) => {
        if (cancelled) return;
        setActiveWorkspace(result.workspace);
        setNodes(result.nodes);
        setSelectedNodeId((current) =>
          current && result.nodes.some((node) => node.id === current) ? current : (result.nodes[0]?.id ?? null),
        );
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
  const serversById = useMemo(() => new Map(servers.map((server) => [server.id, server])), [servers]);
  const serverNames = useMemo(() => new Map(servers.map((server) => [server.id, server.displayName])), [servers]);
  const connectedServers = servers.filter((server) => server.connected);

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
    setSelectedNodeIds((current) => {
      const next = new Set(current);
      if (next.has(nodeId)) next.delete(nodeId); else next.add(nodeId);
      return next;
    });
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
            executionDetails={executionDetails}
            executionHistory={executionHistory}
            descriptions={descriptions}
            runResult={runResult}
            loading={loading || workspaceLoading}
            running={running}
            error={error}
            onSelectNode={setSelectedNodeId}
            onToggleSelected={toggleSelectedNode}
            onProjectionChange={setProjection}
            onPresentationChange={(node, presentation) => void changePresentation(node, presentation)}
            onRunSelected={() => void runNodes([...selectedNodeIds])}
            onCreateWorkspace={createFirstWorkspace}
            onOpenManager={() => setView("settings")}
          />
          <WorkspaceDetailPane node={selectedNode} serverNames={serverNames} />
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
  executionDetails,
  executionHistory,
  descriptions,
  runResult,
  loading,
  running,
  error,
  onSelectNode,
  onToggleSelected,
  onProjectionChange,
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
  executionDetails: Map<string, ExecutionDetail>;
  executionHistory: Map<string, ExecutionRecord[]>;
  descriptions: Map<string, string>;
  runResult: WorkspaceRunResult | null;
  loading: boolean;
  running: boolean;
  error: string | null;
  onSelectNode: (id: string) => void;
  onToggleSelected: (id: string) => void;
  onProjectionChange: (projection: WorkspaceProjection) => void;
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
          {(["grid", "list"] as const).map((item) => (
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

      <div className="canvas-scroll">
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
        {workspace && nodes.length > 0 && (
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

function WorkspaceDetailPane({ node, serverNames }: { node: WorkspaceNodeRow | null; serverNames: Map<string, string> }) {
  const capability = node?.capabilityId ? parseCapabilityId(node.capabilityId) : null;
  return (
    <aside className="detail-pane" data-testid="workspace-detail-pane">
      <div className="detail-head">
        <span className="muted">{node ? "Selected workspace node" : "Workspace details"}</span>
        <h2>{capability?.name ?? (node ? "Unbound node" : "Nothing selected")}</h2>
      </div>
      {node ? (
        <div className="detail-sections">
          <section>
            <h3>Identity</h3>
            <dl className="detail-list">
              <div><dt>Server</dt><dd>{node.serverId ? (serverNames.get(node.serverId) ?? node.serverId) : "Unavailable"}</dd></div>
              <div><dt>Type</dt><dd>{capability?.type ?? "Unavailable"}</dd></div>
              <div><dt>Presentation</dt><dd>{node.presentation}</dd></div>
              <div><dt>Position</dt><dd>{node.position}</dd></div>
            </dl>
          </section>
          <section>
            <h3>Arguments</h3>
            <pre>{formatArguments(node.argumentsJson)}</pre>
          </section>
        </div>
      ) : (
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

function formatArguments(value: string | null) {
  if (!value) return "No arguments configured";
  try {
    return JSON.stringify(JSON.parse(value), null, 2);
  } catch {
    return value;
  }
}
