import { useEffect, useMemo, useState } from "react";
import { createExecutionRecord, type ExecutionStatus } from "@mcp-inspector-x/execution";
import { buildCapabilityId } from "@mcp-inspector-x/registry";
import { classifyResult } from "@mcp-inspector-x/renderers";
import {
  MODERN_PROTOCOL_VERSION,
  type JsonValue,
  type McpToolDefinition,
  type ProtocolNegotiation,
} from "@mcp-inspector-x/protocol";
import { focusNode, type ToolNodePresentation, type Workspace } from "@mcp-inspector-x/workspace";

interface ServerSummary {
  id: string;
  displayName: string;
  transport: string;
  negotiation: ProtocolNegotiation;
}

interface ToolCard {
  id: string;
  server: string;
  name: string;
  title?: string;
  status: ExecutionStatus;
  latencyMs: number;
  result: JsonValue;
  presentation: ToolNodePresentation;
}

type Mode = "loading" | "live" | "unavailable";

export function App() {
  const [mode, setMode] = useState<Mode>("loading");
  const [error, setError] = useState<string | null>(null);
  const [servers, setServers] = useState<ServerSummary[]>([]);
  const [tools, setTools] = useState<ToolCard[]>([]);
  const [view, setView] = useState<"graph" | "grid" | "list">("graph");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const serversRes = await fetch("/api/v1/servers");
        if (!serversRes.ok) throw new Error(`GET /api/v1/servers ${serversRes.status}`);
        const { servers: fetchedServers } = (await serversRes.json()) as {
          servers: ServerSummary[];
        };
        if (cancelled) return;
        if (fetchedServers.length === 0) {
          setMode("unavailable");
          setError("gateway reports no bound MCP servers");
          return;
        }
        const cards: ToolCard[] = [];
        for (const s of fetchedServers) {
          const toolsRes = await fetch(`/api/v1/servers/${encodeURIComponent(s.id)}/tools`);
          if (!toolsRes.ok) continue;
          const { tools: toolDefs } = (await toolsRes.json()) as {
            tools: McpToolDefinition[];
          };
          for (const t of toolDefs) {
            const card: ToolCard = {
              id: buildCapabilityId(s.id, "tool", t.name),
              server: s.id,
              name: t.name,
              status: "queued",
              latencyMs: 0,
              result: null,
              presentation: "collapsed",
            };
            if (t.title !== undefined) card.title = t.title;
            cards.push(card);
          }
        }
        if (cancelled) return;
        setServers(fetchedServers);
        setTools(cards);
        setMode("live");
      } catch (err) {
        if (cancelled) return;
        setMode("unavailable");
        setError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const workspace = useMemo<Workspace>(
    () => ({
      id: "live-workspace",
      name:
        servers.length > 0
          ? `Live · ${servers.map((s) => s.displayName).join(", ")}`
          : "MCP Inspector X",
      nodes: tools.map((tool) => ({
        id: tool.id,
        capabilityId: tool.id,
        presentation: tool.presentation,
        selected: tool.status !== "error",
        arguments: {},
        renderer: classifyResult(tool.result).renderer,
      })),
      edges: [],
    }),
    [tools, servers],
  );

  function setPresentation(id: string, presentation: ToolNodePresentation) {
    const nextWorkspace = presentation === "focus" ? focusNode(workspace, id) : workspace;
    setTools((current) =>
      current.map((tool) => {
        if (presentation === "focus") {
          const focused = nextWorkspace.nodes.find((node) => node.id === tool.id);
          return { ...tool, presentation: focused?.presentation ?? tool.presentation };
        }
        return tool.id === id ? { ...tool, presentation } : tool;
      }),
    );
  }

  const modeLabel: string =
    mode === "loading"
      ? "loading…"
      : mode === "live"
        ? "live mode"
        : `unavailable${error ? ` · ${error}` : ""}`;

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">
          <span className="logo">X</span>
          <strong>MCP Inspector X</strong>
        </div>
        <span className="workspace-name">{workspace.name}</span>
        <div className="topbar-spacer" />
        <span className="protocol-chip">
          {servers[0]?.negotiation.negotiatedEra === "legacy" ? "Legacy" : "Modern"}
          {" · "}
          {servers[0]?.negotiation.selectedVersion ?? MODERN_PROTOCOL_VERSION}
        </span>
        <button className="button primary">Run all</button>
      </header>

      <aside className="sidebar">
        <p className="eyebrow">Explore</p>
        <button className="nav active">Workspace</button>
        <button className="nav">Capability catalog</button>
        <button className="nav">Executions</button>
        <button className="nav">Source graph</button>
        <p className="eyebrow">Servers</p>
        {servers.length === 0 && mode === "loading" && (
          <button className="nav" disabled>
            loading…
          </button>
        )}
        {servers.length === 0 && mode === "unavailable" && (
          <button className="nav" disabled>
            (none)
          </button>
        )}
        {servers.map((s) => (
          <button className="nav" key={s.id}>
            {s.displayName}
          </button>
        ))}
      </aside>

      <main className="workspace">
        <div className="workspace-toolbar">
          <div className="segmented">
            {(["graph", "grid", "list"] as const).map((m) => (
              <button
                className={view === m ? "active" : ""}
                onClick={() => setView(m)}
                key={m}
              >
                {m}
              </button>
            ))}
          </div>
          <span className="muted">
            {tools.length} tools · {modeLabel}
          </span>
          <div className="topbar-spacer" />
          <button className="button">Copy selected for agent</button>
          <button className="button primary">Run selected</button>
        </div>

        <section className={`tool-surface ${view}`}>
          {tools.map((tool) => {
            const record = createExecutionRecord({
              executionId: `live:${tool.id}`,
              capabilityId: tool.id,
              status: tool.status,
              startedAt: new Date(Date.now() - tool.latencyMs).toISOString(),
              finishedAt: new Date().toISOString(),
              durationMs: tool.latencyMs,
            });
            const classified = classifyResult(tool.result);
            return (
              <article className={`tool-card ${tool.presentation}`} key={tool.id}>
                <div className="tool-header">
                  <div>
                    <strong>{tool.title ?? tool.name}</strong>
                    <span>
                      {tool.server} · {classified.renderer}
                    </span>
                  </div>
                  <span className={`status ${tool.status}`}>{tool.status}</span>
                </div>
                <div className="tool-summary">
                  <span>{record.durationMs} ms</span>
                  <span>protocol evidence attached</span>
                </div>
                {tool.presentation !== "collapsed" && (
                  <div className="expanded-body">
                    <div className="local-tabs">
                      <button className="active">Result</button>
                      <button>Parameters</button>
                      <button>Docs</button>
                      <button>Trace</button>
                      <button>Source</button>
                      <button>History</button>
                    </div>
                    <pre>{JSON.stringify(tool.result, null, 2)}</pre>
                  </div>
                )}
                <div className="tool-actions">
                  <button
                    onClick={() =>
                      setPresentation(
                        tool.id,
                        tool.presentation === "collapsed" ? "expanded" : "collapsed",
                      )
                    }
                  >
                    {tool.presentation === "collapsed" ? "Expand" : "Collapse"}
                  </button>
                  <button onClick={() => setPresentation(tool.id, "focus")}>Focus</button>
                  <button>Agent handoff</button>
                </div>
              </article>
            );
          })}
        </section>
      </main>
    </div>
  );
}
