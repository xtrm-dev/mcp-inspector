import { useMemo, useState } from "react";
import { createExecutionRecord, type ExecutionStatus } from "@mcp-inspector-x/execution";
import { buildCapabilityId } from "@mcp-inspector-x/registry";
import { classifyResult } from "@mcp-inspector-x/renderers";
import { MODERN_PROTOCOL_VERSION, type JsonValue } from "@mcp-inspector-x/protocol";
import { focusNode, type ToolNodePresentation, type Workspace } from "@mcp-inspector-x/workspace";

interface DemoTool {
  id: string;
  server: string;
  name: string;
  status: ExecutionStatus;
  latencyMs: number;
  result: JsonValue;
  presentation: ToolNodePresentation;
}

const initialTools: DemoTool[] = [
  {
    id: buildCapabilityId("market-data", "tool", "futures_prices"),
    server: "market-data",
    name: "futures_prices",
    status: "complete",
    latencyMs: 312,
    result: [
      { symbol: "SR3Z6", price: 96.325, volume: 2184 },
      { symbol: "SR3H7", price: 96.41, volume: 984 },
    ],
    presentation: "expanded",
  },
  {
    id: buildCapabilityId("treasury", "tool", "treasury_curve"),
    server: "treasury",
    name: "treasury_curve",
    status: "complete",
    latencyMs: 184,
    result: [
      { tenor: "2Y", yield: 3.74 },
      { tenor: "10Y", yield: 4.16 },
    ],
    presentation: "collapsed",
  },
  {
    id: buildCapabilityId("economic-data", "tool", "latest_releases"),
    server: "economic-data",
    name: "latest_releases",
    status: "error",
    latencyMs: 2140,
    result: { error: "Downstream provider timeout", code: "TIMEOUT" },
    presentation: "collapsed",
  },
];

export function App() {
  const [tools, setTools] = useState(initialTools);
  const [view, setView] = useState<"graph" | "grid" | "list">("graph");

  const workspace = useMemo<Workspace>(
    () => ({
      id: "demo-workspace",
      name: "Morning market inspection",
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
    [tools],
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

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand"><span className="logo">X</span><strong>MCP Inspector X</strong></div>
        <span className="workspace-name">{workspace.name}</span>
        <div className="topbar-spacer" />
        <span className="protocol-chip">Modern · {MODERN_PROTOCOL_VERSION}</span>
        <button className="button primary">Run all</button>
      </header>

      <aside className="sidebar">
        <p className="eyebrow">Explore</p>
        <button className="nav active">Workspace</button>
        <button className="nav">Capability catalog</button>
        <button className="nav">Executions</button>
        <button className="nav">Source graph</button>
        <p className="eyebrow">Servers</p>
        {["market-data", "treasury", "economic-data", "darth-feedor"].map((server) => (
          <button className="nav" key={server}>{server}</button>
        ))}
      </aside>

      <main className="workspace">
        <div className="workspace-toolbar">
          <div className="segmented">
            {(["graph", "grid", "list"] as const).map((mode) => (
              <button className={view === mode ? "active" : ""} onClick={() => setView(mode)} key={mode}>{mode}</button>
            ))}
          </div>
          <span className="muted">{tools.length} tools · fixture mode</span>
          <div className="topbar-spacer" />
          <button className="button">Copy selected for agent</button>
          <button className="button primary">Run selected</button>
        </div>

        <section className={`tool-surface ${view}`}>
          {tools.map((tool) => {
            const record = createExecutionRecord({
              executionId: `fixture:${tool.id}`,
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
                    <strong>{tool.name}</strong>
                    <span>{tool.server} · {classified.renderer}</span>
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
                      <button className="active">Result</button><button>Parameters</button><button>Docs</button><button>Trace</button><button>Source</button><button>History</button>
                    </div>
                    <pre>{JSON.stringify(tool.result, null, 2)}</pre>
                  </div>
                )}
                <div className="tool-actions">
                  <button onClick={() => setPresentation(tool.id, tool.presentation === "collapsed" ? "expanded" : "collapsed")}>{tool.presentation === "collapsed" ? "Expand" : "Collapse"}</button>
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
