import { useEffect, useState } from "react";
import {
  callTool,
  connectServer,
  createCredential,
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

type AuthKind = "none" | "bearer" | "header";

const emptyForm = {
  displayName: "",
  transport: "streamable-http" as Transport,
  endpoint: "",
  command: "",
  argsText: "",
  cwd: "",
  envText: "",
  authKind: "none" as AuthKind,
  headerName: "X-API-Key",
  authValue: "",
  connectNow: true,
};

// Parses KEY=VALUE lines (blank lines and `#`-prefixed comments skipped) into
// a record. Whitespace around KEY is trimmed; VALUE is used verbatim so
// trailing spaces or `=` characters in the value survive.
function parseEnvText(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) throw new Error(`invalid env line (expected KEY=VALUE): ${line}`);
    const key = line.slice(0, eq).trim();
    if (!key) throw new Error(`invalid env line (blank key): ${line}`);
    out[key] = line.slice(eq + 1);
  }
  return out;
}

// Splits an argv string on whitespace, honouring simple single/double quotes.
function parseArgsText(raw: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(raw)) !== null) out.push(match[1] ?? match[2] ?? match[3] ?? "");
  return out;
}

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
      let credentialRefId: string | null = null;
      let headerCredentials: Record<string, string> | null = null;
      if (form.authKind !== "none") {
        if (!form.authValue) {
          throw new Error("auth value is required for the selected auth kind");
        }
        if (form.authKind === "header" && !form.headerName.trim()) {
          throw new Error("header name is required for custom-header auth");
        }
        // Session-provider credential: value lives in-memory in the
        // gateway, redacted via SecretsRegistry.known, and clears on
        // gateway restart. No plaintext persisted on disk.
        const label = `spa-${form.authKind}-${Date.now()}`;
        const cred = await createCredential({
          provider: "session",
          key: label,
          value: form.authValue,
        });
        if (form.authKind === "bearer") {
          credentialRefId = cred.credentialRef.id;
        } else {
          headerCredentials = { [form.headerName]: cred.credentialRef.id };
        }
      }
      const stdio = form.transport === "stdio";
      if (stdio && !form.command.trim()) {
        throw new Error("command is required for stdio transport");
      }
      const input: import("../api/types").CreateServerInput = {
        displayName: form.displayName,
        transport: form.transport,
        endpoint: stdio ? null : (form.endpoint || null),
        credentialRefId,
        headerCredentials,
        connectNow: form.connectNow,
      };
      if (stdio) {
        input.command = form.command.trim();
        if (form.argsText.trim()) input.args = parseArgsText(form.argsText);
        if (form.cwd.trim()) input.cwd = form.cwd.trim();
        if (form.envText.trim()) input.env = parseEnvText(form.envText);
      }
      await createServer(input);
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
          {form.transport === "streamable-http" && (
            <label>
              Endpoint
              <input
                data-testid="server-endpoint"
                value={form.endpoint}
                onChange={(e) => setForm({ ...form, endpoint: e.target.value })}
              />
            </label>
          )}
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={form.connectNow}
              onChange={(e) => setForm({ ...form, connectNow: e.target.checked })}
            />
            Connect now
          </label>
        </div>
        {form.transport === "stdio" && (
          <div className="field-row stdio-config">
            <label>
              Command
              <input
                data-testid="stdio-command"
                required
                value={form.command}
                placeholder="/usr/local/bin/my-mcp-server"
                onChange={(e) => setForm({ ...form, command: e.target.value })}
              />
            </label>
            <label>
              Args
              <input
                data-testid="stdio-args"
                value={form.argsText}
                placeholder='--flag value "arg with spaces"'
                onChange={(e) => setForm({ ...form, argsText: e.target.value })}
              />
            </label>
            <label>
              Working directory
              <input
                data-testid="stdio-cwd"
                value={form.cwd}
                placeholder="/opt/servers/foo"
                onChange={(e) => setForm({ ...form, cwd: e.target.value })}
              />
            </label>
            <label className="stdio-env">
              Env (KEY=VALUE per line)
              <textarea
                data-testid="stdio-env"
                rows={3}
                value={form.envText}
                placeholder={"MCP_LOG_LEVEL=info\nMY_API_KEY=..."}
                onChange={(e) => setForm({ ...form, envText: e.target.value })}
              />
            </label>
          </div>
        )}
        {form.transport === "streamable-http" && (
          <div className="field-row">
            <label>
              Auth
              <select
                value={form.authKind}
                onChange={(e) =>
                  setForm({ ...form, authKind: e.target.value as AuthKind, authValue: "" })
                }
              >
                <option value="none">None</option>
                <option value="bearer">Authorization: Bearer</option>
                <option value="header">Custom header</option>
              </select>
            </label>
            {form.authKind === "header" && (
              <label>
                Header name
                <input
                  value={form.headerName}
                  placeholder="X-API-Key"
                  onChange={(e) => setForm({ ...form, headerName: e.target.value })}
                />
              </label>
            )}
            {form.authKind !== "none" && (
              <label>
                {form.authKind === "bearer" ? "Bearer token" : "Header value"}
                <input
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  value={form.authValue}
                  onChange={(e) => setForm({ ...form, authValue: e.target.value })}
                />
              </label>
            )}
          </div>
        )}
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
