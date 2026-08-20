import { useEffect, useState } from "react";
import {
  callTool,
  connectServer,
  createServer,
  deleteServer,
  disconnectServer,
  getServerCapabilities,
  listServers,
  testServerConnection,
} from "../api/client";
import type {
  ExecutionEnvelope,
  JsonObject,
  McpPromptDefinition,
  McpResourceDefinition,
  McpToolDefinition,
  ServerSummary,
  Transport,
} from "../api/types";
import { SchemaForm } from "../schema-form";
import { RendererView } from "../renderer-view";

const emptyForm = {
  displayName: "",
  transport: "streamable-http" as Transport,
  endpoint: "",
  connectNow: true,
};

export function ServersPage() {
  const [servers, setServers] = useState<ServerSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState(emptyForm);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [capabilities, setCapabilities] = useState<{
    tools: McpToolDefinition[];
    resources: McpResourceDefinition[];
    prompts: McpPromptDefinition[];
  } | null>(null);

  function refresh() {
    setLoading(true);
    listServers()
      .then((res) => setServers(res.servers))
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setLoading(false));
  }

  useEffect(refresh, []);

  useEffect(() => {
    if (!selectedId) {
      setCapabilities(null);
      return;
    }
    getServerCapabilities(selectedId).then(setCapabilities);
  }, [selectedId]);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    try {
      await createServer({
        displayName: form.displayName,
        transport: form.transport,
        endpoint: form.endpoint || null,
        connectNow: form.connectNow,
      });
      setForm(emptyForm);
      refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <div className="page" data-testid="servers-page">
      <h2>Server catalog</h2>
      {error && <p className="form-error">{error}</p>}

      <form className="panel" onSubmit={handleCreate}>
        <div className="field-row">
          <label>
            Display name
            <input
              required
              value={form.displayName}
              onChange={(e) => setForm({ ...form, displayName: e.target.value })}
            />
          </label>
          <label>
            Transport
            <select
              value={form.transport}
              onChange={(e) => setForm({ ...form, transport: e.target.value as Transport })}
            >
              <option value="streamable-http">streamable-http</option>
              <option value="stdio">stdio</option>
            </select>
          </label>
          <label>
            Endpoint
            <input value={form.endpoint} onChange={(e) => setForm({ ...form, endpoint: e.target.value })} />
          </label>
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={form.connectNow}
              onChange={(e) => setForm({ ...form, connectNow: e.target.checked })}
            />
            Connect now
          </label>
        </div>
        <button className="button primary" type="submit">
          Add server
        </button>
      </form>

      {loading && <p className="muted">loading…</p>}

      <table className="data-table">
        <thead>
          <tr>
            <th>Name</th>
            <th>Transport</th>
            <th>Status</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {servers.map((s) => (
            <tr key={s.id} className={s.id === selectedId ? "selected" : ""} onClick={() => setSelectedId(s.id)}>
              <td>{s.displayName}</td>
              <td>{s.transport}</td>
              <td>
                <span className={`status ${s.connected ? "complete" : "error"}`}>
                  {s.connected ? "connected" : "disconnected"}
                </span>
              </td>
              <td className="row-actions" onClick={(e) => e.stopPropagation()}>
                <button onClick={() => connectServer(s.id).then(refresh)}>Connect</button>
                <button onClick={() => disconnectServer(s.id).then(refresh)}>Disconnect</button>
                <button
                  onClick={() =>
                    testServerConnection(s.id).then((r) => setError(JSON.stringify(r)))
                  }
                >
                  Test
                </button>
                <button onClick={() => deleteServer(s.id).then(refresh)}>Delete</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {selectedId && capabilities && <ToolConsole serverId={selectedId} capabilities={capabilities} />}
    </div>
  );
}

function ToolConsole({
  serverId,
  capabilities,
}: {
  serverId: string;
  capabilities: { tools: McpToolDefinition[]; resources: McpResourceDefinition[]; prompts: McpPromptDefinition[] };
}) {
  const [toolName, setToolName] = useState("");
  const [args, setArgs] = useState<JsonObject>({});
  const [valid, setValid] = useState(true);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<ExecutionEnvelope | null>(null);
  const [callError, setCallError] = useState<string | null>(null);

  const tool = capabilities.tools.find((t) => t.name === toolName);

  async function run() {
    if (!toolName || !valid) return;
    setRunning(true);
    setCallError(null);
    try {
      const envelope = await callTool(serverId, toolName, args);
      setResult(envelope);
    } catch (err) {
      setCallError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="panel">
      <h3>Capabilities — {serverId}</h3>
      <p className="muted">
        {capabilities.tools.length} tools · {capabilities.resources.length} resources · {capabilities.prompts.length}{" "}
        prompts
      </p>

      <label>
        Tool
        <select
          value={toolName}
          onChange={(e) => {
            setToolName(e.target.value);
            setArgs({});
            setResult(null);
          }}
        >
          <option value="">— select —</option>
          {capabilities.tools.map((t) => (
            <option key={t.name} value={t.name}>
              {t.name}
            </option>
          ))}
        </select>
      </label>

      {tool && (
        <>
          <SchemaForm
            schema={tool.inputSchema}
            value={args}
            onChange={(next, isValid) => {
              setArgs(next);
              setValid(isValid);
            }}
          />
          <button className="button primary" onClick={run} disabled={!valid || running}>
            {running ? "Running…" : "Run"}
          </button>
        </>
      )}

      {callError && <p className="form-error">{callError}</p>}

      {result && (
        <div className="tool-result" data-testid="tool-result">
          {result.sourceHint && (
            <p className="muted source-hint">
              source: {result.sourceHint.filePath}
              {result.sourceHint.symbol ? `::${result.sourceHint.symbol}` : ""}
              {result.sourceHint.lineStart !== null ? ` (L${result.sourceHint.lineStart})` : ""}
            </p>
          )}
          <RendererView value={result.value ?? null} suggestedRenderer={result.suggestedRenderer} />
        </div>
      )}
    </div>
  );
}
