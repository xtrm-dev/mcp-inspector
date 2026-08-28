import { useEffect, useMemo, useState } from "react";
import {
  AgentRunsPage,
  CredentialsPage,
  ExecutionsPage,
  PacketsPage,
  ServersPage,
  SourcePage,
  WorkspacesPage,
} from "./pages";
import {
  createWorkspace,
  getWorkspace,
  listServers,
  listWorkspaces,
  runWorkspaceApi,
} from "./api/client";
import { parseCapabilityId } from "./api/capability-id";
import type {
  ServerSummary,
  WorkspaceNodeRow,
  WorkspaceRow,
  WorkspaceRunResult,
} from "./api/types";

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
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
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
      setWorkspaceLoading(false);
      return;
    }

    let cancelled = false;
    setActiveWorkspace(null);
    setNodes([]);
    setSelectedNodeId(null);
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
  const serverNames = useMemo(() => new Map(servers.map((server) => [server.id, server.displayName])), [servers]);
  const connectedServers = servers.filter((server) => server.connected);

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

  async function runAll() {
    if (!activeWorkspaceId || !workspaceReady || nodes.length === 0) return;
    setRunning(true);
    setError(null);
    try {
      setRunResult(await runWorkspaceApi(activeWorkspaceId, {}));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setRunning(false);
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
        <button className="button primary" onClick={runAll} disabled={!showWorkspace || !workspaceReady || nodes.length === 0 || running}>
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
            serverNames={serverNames}
            selectedNodeId={selectedNodeId}
            loading={loading || workspaceLoading}
            error={error}
            onSelectNode={setSelectedNodeId}
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
        <span>{selectedNode ? "1 selected" : "0 selected"}</span>
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
  serverNames,
  selectedNodeId,
  loading,
  error,
  onSelectNode,
  onCreateWorkspace,
  onOpenManager,
}: {
  workspace: WorkspaceRow | null;
  nodes: WorkspaceNodeRow[];
  serverNames: Map<string, string>;
  selectedNodeId: string | null;
  loading: boolean;
  error: string | null;
  onSelectNode: (id: string) => void;
  onCreateWorkspace: (name: string) => Promise<void>;
  onOpenManager: () => void;
}) {
  const [newWorkspaceName, setNewWorkspaceName] = useState("");

  return (
    <main className="workspace-canvas" data-testid="workspace-page">
      <div className="workspace-toolbar">
        <div>
          <strong>{workspace?.name ?? "Workspace"}</strong>
          <span className="muted">{nodes.length} inspectable nodes</span>
        </div>
        <div className="topbar-spacer" />
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
          <section className="node-stage" aria-label="Workspace nodes">
            {nodes.map((node) => {
              const capability = node.capabilityId ? parseCapabilityId(node.capabilityId) : null;
              return (
                <button
                  key={node.id}
                  className={`workspace-node ${selectedNodeId === node.id ? "selected" : ""}`}
                  onClick={() => onSelectNode(node.id)}
                >
                  <span className="node-title">{capability?.name ?? node.capabilityId ?? "Unbound node"}</span>
                  <span className="node-meta">{node.serverId ? (serverNames.get(node.serverId) ?? node.serverId) : "No server"}</span>
                  <span className="node-kind">{capability?.type ?? "unbound"}</span>
                </button>
              );
            })}
          </section>
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
