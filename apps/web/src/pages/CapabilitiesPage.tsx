import { useEffect, useMemo, useState } from "react";
import { getServerCapabilities, listServers } from "../api/client";
import type {
  McpPromptDefinition,
  McpResourceDefinition,
  McpResourceTemplateDefinition,
  McpToolDefinition,
  ServerSummary,
} from "../api/types";
import { AddToWorkspaceModal, type CapabilitySelection } from "../components/AddToWorkspaceModal";

type CapabilityKind = "tool" | "resource" | "template" | "prompt";

interface CatalogEntry {
  serverId: string;
  serverName: string;
  serverConnected: boolean;
  kind: CapabilityKind;
  name: string;
  description: string | null;
  capabilityId: string;
}

const KIND_LABELS: Record<CapabilityKind, string> = {
  tool: "Tool",
  resource: "Resource",
  template: "Template",
  prompt: "Prompt",
};

function toolEntries(server: ServerSummary, tools: McpToolDefinition[]): CatalogEntry[] {
  return tools.map((t) => ({
    serverId: server.id,
    serverName: server.displayName,
    serverConnected: server.connected,
    kind: "tool" as const,
    name: t.name,
    description: t.description ?? null,
    capabilityId: `${server.id}::tool::${t.name}`,
  }));
}

function resourceEntries(server: ServerSummary, resources: McpResourceDefinition[]): CatalogEntry[] {
  return resources.map((r) => ({
    serverId: server.id,
    serverName: server.displayName,
    serverConnected: server.connected,
    kind: "resource" as const,
    name: r.name ?? r.uri,
    description: r.description ?? null,
    capabilityId: `${server.id}::resource::${r.uri}`,
  }));
}

function templateEntries(server: ServerSummary, templates: McpResourceTemplateDefinition[]): CatalogEntry[] {
  return templates.map((t) => ({
    serverId: server.id,
    serverName: server.displayName,
    serverConnected: server.connected,
    kind: "template" as const,
    name: t.name ?? t.uriTemplate,
    description: t.description ?? null,
    capabilityId: `${server.id}::template::${t.uriTemplate}`,
  }));
}

function promptEntries(server: ServerSummary, prompts: McpPromptDefinition[]): CatalogEntry[] {
  return prompts.map((p) => ({
    serverId: server.id,
    serverName: server.displayName,
    serverConnected: server.connected,
    kind: "prompt" as const,
    name: p.name,
    description: p.description ?? null,
    capabilityId: `${server.id}::prompt::${p.name}`,
  }));
}

export function CapabilitiesPage() {
  const [servers, setServers] = useState<ServerSummary[]>([]);
  const [entries, setEntries] = useState<CatalogEntry[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [serverFilter, setServerFilter] = useState<Set<string>>(new Set());
  const [kindFilter, setKindFilter] = useState<Set<CapabilityKind>>(new Set());
  const [showDisconnected, setShowDisconnected] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  function refresh() {
    setLoading(true);
    setError(null);
    listServers()
      .then(async ({ servers: serverList }) => {
        setServers(serverList);
        const connected = serverList.filter((s) => s.connected);
        const collected: CatalogEntry[] = [];
        await Promise.all(
          connected.map(async (server) => {
            try {
              const caps = await getServerCapabilities(server.id);
              collected.push(
                ...toolEntries(server, caps.tools),
                ...resourceEntries(server, caps.resources),
                ...templateEntries(server, caps.resourceTemplates),
                ...promptEntries(server, caps.prompts),
              );
            } catch {
              // Server may briefly race between listServers's connected=true
              // and the actual list-capability call; missing entries are
              // preferable to a hard-failed catalog.
            }
          }),
        );
        collected.sort((a, b) => a.name.localeCompare(b.name));
        setEntries(collected);
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setLoading(false));
  }

  useEffect(refresh, []);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return entries.filter((e) => {
      if (!showDisconnected && !e.serverConnected) return false;
      if (serverFilter.size > 0 && !serverFilter.has(e.serverId)) return false;
      if (kindFilter.size > 0 && !kindFilter.has(e.kind)) return false;
      if (q && !e.name.toLowerCase().includes(q) && !(e.description ?? "").toLowerCase().includes(q))
        return false;
      return true;
    });
  }, [entries, search, serverFilter, kindFilter, showDisconnected]);

  function toggleSelect(cid: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(cid)) next.delete(cid);
      else next.add(cid);
      return next;
    });
  }

  function toggleServerFilter(id: string) {
    setServerFilter((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleKindFilter(k: CapabilityKind) {
    setKindFilter((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });
  }

  const selections: CapabilitySelection[] = useMemo(
    () =>
      Array.from(selected)
        .map((cid) => entries.find((e) => e.capabilityId === cid))
        .filter((e): e is CatalogEntry => Boolean(e))
        .map((e) => ({ serverId: e.serverId, capabilityId: e.capabilityId, label: e.name })),
    [selected, entries],
  );

  return (
    <div className="page" data-testid="capabilities-page">
      <h2>Capability catalog</h2>
      {error && <p className="form-error">{error}</p>}
      {statusMessage && <p className="form-status">{statusMessage}</p>}

      <div className="panel catalog-toolbar">
        <input
          placeholder="Search capabilities…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          data-testid="catalog-search"
          className="catalog-search"
        />
        <div className="catalog-filter-group">
          <span className="muted">Servers:</span>
          {servers
            .filter((s) => showDisconnected || s.connected)
            .map((s) => {
              const active = serverFilter.has(s.id);
              return (
                <button
                  key={s.id}
                  type="button"
                  className={`chip ${active ? "chip-active" : ""}`}
                  onClick={() => toggleServerFilter(s.id)}
                >
                  {s.displayName}
                </button>
              );
            })}
        </div>
        <div className="catalog-filter-group">
          <span className="muted">Kind:</span>
          {(Object.keys(KIND_LABELS) as CapabilityKind[]).map((k) => (
            <button
              key={k}
              type="button"
              className={`chip ${kindFilter.has(k) ? "chip-active" : ""}`}
              onClick={() => toggleKindFilter(k)}
            >
              {KIND_LABELS[k]}
            </button>
          ))}
        </div>
        <label className="catalog-toggle">
          <input
            type="checkbox"
            checked={showDisconnected}
            onChange={(e) => setShowDisconnected(e.target.checked)}
          />
          Show disconnected servers
        </label>
        <div className="catalog-actions">
          <span className="muted" data-testid="catalog-selection-count">
            {selections.length} selected
          </span>
          <button
            type="button"
            className="button primary"
            disabled={selections.length === 0}
            onClick={() => setModalOpen(true)}
            data-testid="catalog-add-selected"
          >
            Add selected to workspace
          </button>
          <button type="button" onClick={refresh} disabled={loading}>
            {loading ? "Refreshing…" : "Refresh"}
          </button>
        </div>
      </div>

      <table className="data-table catalog-table">
        <thead>
          <tr>
            <th>&nbsp;</th>
            <th>Server</th>
            <th>Kind</th>
            <th>Name</th>
            <th>Description</th>
          </tr>
        </thead>
        <tbody>
          {visible.length === 0 && !loading && (
            <tr>
              <td colSpan={5} className="muted">
                No capabilities match the current filters.
              </td>
            </tr>
          )}
          {visible.map((e) => (
            <tr key={e.capabilityId}>
              <td>
                <input
                  type="checkbox"
                  checked={selected.has(e.capabilityId)}
                  onChange={() => toggleSelect(e.capabilityId)}
                  aria-label={`select ${e.name}`}
                />
              </td>
              <td>{e.serverName}</td>
              <td>{KIND_LABELS[e.kind]}</td>
              <td>{e.name}</td>
              <td className="muted">{e.description ?? "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {modalOpen && (
        <AddToWorkspaceModal
          selections={selections}
          onDismiss={() => setModalOpen(false)}
          onAdded={(count, workspaceId) => {
            setStatusMessage(`Added ${count} to workspace ${workspaceId}`);
            setSelected(new Set());
          }}
        />
      )}
    </div>
  );
}
