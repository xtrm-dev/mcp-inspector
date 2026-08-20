import { useEffect, useState } from "react";
import {
  createWorkspace,
  createWorkspaceNode,
  deleteWorkspace,
  deleteWorkspaceNode,
  getWorkspace,
  listServers,
  listTools,
  listWorkspaces,
  runWorkspaceApi,
} from "../api/client";
import { buildCapabilityId, parseCapabilityId } from "../api/capability-id";
import type { JsonObject, McpToolDefinition, ServerSummary, WorkspaceNodeRow, WorkspaceRow, WorkspaceRunResult } from "../api/types";
import { SchemaForm } from "../schema-form";
import { TraceOverlayPanel } from "../components/TraceOverlayPanel";

export function WorkspacesPage() {
  const [workspaces, setWorkspaces] = useState<WorkspaceRow[]>([]);
  const [newName, setNewName] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);

  function refresh() {
    listWorkspaces().then((res) => setWorkspaces(res.workspaces));
  }
  useEffect(refresh, []);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!newName.trim()) return;
    const { workspace } = await createWorkspace({ name: newName.trim() });
    setNewName("");
    refresh();
    setSelectedId(workspace.id);
  }

  return (
    <div className="page" data-testid="workspaces-page">
      <h2>Workspaces</h2>
      <form className="panel field-row" onSubmit={handleCreate}>
        <input placeholder="New workspace name" value={newName} onChange={(e) => setNewName(e.target.value)} />
        <button className="button primary" type="submit">
          Create workspace
        </button>
      </form>

      <ul className="entity-list">
        {workspaces.map((w) => (
          <li key={w.id} className={w.id === selectedId ? "selected" : ""}>
            <button className="link" onClick={() => setSelectedId(w.id)}>
              {w.name}
            </button>
            <button
              onClick={() => {
                deleteWorkspace(w.id).then(() => {
                  if (selectedId === w.id) setSelectedId(null);
                  refresh();
                });
              }}
            >
              Delete
            </button>
          </li>
        ))}
      </ul>

      {selectedId && <WorkspaceDetail workspaceId={selectedId} />}
    </div>
  );
}

function WorkspaceDetail({ workspaceId }: { workspaceId: string }) {
  const [nodes, setNodes] = useState<WorkspaceNodeRow[]>([]);
  const [servers, setServers] = useState<ServerSummary[]>([]);
  const [selectedNodeIds, setSelectedNodeIds] = useState<Set<string>>(new Set());
  const [runResult, setRunResult] = useState<WorkspaceRunResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [formServerId, setFormServerId] = useState("");
  const [formTools, setFormTools] = useState<McpToolDefinition[]>([]);
  const [formToolName, setFormToolName] = useState("");
  const [formArgs, setFormArgs] = useState<JsonObject>({});
  const [formValid, setFormValid] = useState(true);

  function refresh() {
    getWorkspace(workspaceId).then((res) => setNodes(res.nodes));
  }
  useEffect(refresh, [workspaceId]);
  useEffect(() => {
    listServers().then((res) => setServers(res.servers));
  }, []);

  useEffect(() => {
    if (!formServerId) {
      setFormTools([]);
      return;
    }
    listTools(formServerId)
      .then((res) => setFormTools(res.tools))
      .catch(() => setFormTools([]));
  }, [formServerId]);

  const selectedTool = formTools.find((t) => t.name === formToolName);

  async function addNode(e: React.FormEvent) {
    e.preventDefault();
    if (!formServerId || !formToolName || !formValid) return;
    const capabilityId = buildCapabilityId(formServerId, "tool", formToolName);
    await createWorkspaceNode(workspaceId, {
      serverId: formServerId,
      capabilityId,
      argumentsJson: JSON.stringify(formArgs),
    });
    setFormArgs({});
    refresh();
  }

  function toggleSelected(nodeId: string) {
    setSelectedNodeIds((prev) => {
      const next = new Set(prev);
      if (next.has(nodeId)) next.delete(nodeId);
      else next.add(nodeId);
      return next;
    });
  }

  async function runNodes(nodeIds?: string[]) {
    setError(null);
    try {
      const result = await runWorkspaceApi(workspaceId, nodeIds ? { nodeIds } : {});
      setRunResult(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <div className="panel workspace-detail" data-testid="workspace-detail">
      <div className="workspace-toolbar">
        <button className="button" onClick={() => runNodes(nodes.length > 0 ? [nodes[0]!.id] : undefined)} disabled={nodes.length === 0}>
          Run one
        </button>
        <button className="button" onClick={() => runNodes(Array.from(selectedNodeIds))} disabled={selectedNodeIds.size === 0}>
          Run selected
        </button>
        <button className="button primary" onClick={() => runNodes()} disabled={nodes.length === 0}>
          Run all
        </button>
      </div>

      {error && <p className="form-error">{error}</p>}

      <table className="data-table">
        <thead>
          <tr>
            <th></th>
            <th>Capability</th>
            <th>Presentation</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {nodes.map((n) => {
            const parsed = n.capabilityId ? parseCapabilityId(n.capabilityId) : null;
            return (
              <tr key={n.id}>
                <td>
                  <input type="checkbox" checked={selectedNodeIds.has(n.id)} onChange={() => toggleSelected(n.id)} />
                </td>
                <td>{parsed ? `${parsed.type}:${parsed.name}` : (n.capabilityId ?? "—")}</td>
                <td>{n.presentation}</td>
                <td>
                  <button onClick={() => deleteWorkspaceNode(workspaceId, n.id).then(refresh)}>Remove</button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      <form className="panel add-node-form" onSubmit={addNode}>
        <h4>Add tool node</h4>
        <div className="field-row">
          <label>
            Server
            <select value={formServerId} onChange={(e) => { setFormServerId(e.target.value); setFormToolName(""); }}>
              <option value="">— select —</option>
              {servers.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.displayName}
                </option>
              ))}
            </select>
          </label>
          <label>
            Tool
            <select value={formToolName} onChange={(e) => setFormToolName(e.target.value)} disabled={formTools.length === 0}>
              <option value="">— select —</option>
              {formTools.map((t) => (
                <option key={t.name} value={t.name}>
                  {t.name}
                </option>
              ))}
            </select>
          </label>
        </div>
        {formToolName && (
          <SchemaForm
            schema={selectedTool?.inputSchema}
            value={formArgs}
            onChange={(next, valid) => {
              setFormArgs(next);
              setFormValid(valid);
            }}
          />
        )}
        <button className="button primary" type="submit" disabled={!formServerId || !formToolName || !formValid}>
          Add node
        </button>
      </form>

      {runResult && (
        <div className="run-result">
          <h4>Run {runResult.runId}</h4>
          <ul>
            {runResult.nodes.map((n) => (
              <li key={n.nodeId}>
                <span className={`status ${n.ok ? "complete" : "error"}`}>{n.ok ? "ok" : "failed"}</span>{" "}
                {n.capabilityId ?? n.nodeId} {n.error ? `— ${n.error}` : ""}
              </li>
            ))}
          </ul>
          <TraceOverlayPanel agentRunId={runResult.agentRunId} />
        </div>
      )}
    </div>
  );
}
