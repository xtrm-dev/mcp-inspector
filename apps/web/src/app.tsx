import { useState } from "react";
import {
  AgentRunsPage,
  CredentialsPage,
  ExecutionsPage,
  PacketsPage,
  ServersPage,
  SourcePage,
  WorkspacesPage,
} from "./pages";

const VIEWS = [
  { id: "servers", label: "Servers", Component: ServersPage },
  { id: "workspaces", label: "Workspaces", Component: WorkspacesPage },
  { id: "executions", label: "Executions", Component: ExecutionsPage },
  { id: "packets", label: "Packets", Component: PacketsPage },
  { id: "agent-runs", label: "Agent runs", Component: AgentRunsPage },
  { id: "credentials", label: "Credentials", Component: CredentialsPage },
  { id: "source", label: "Source", Component: SourcePage },
] as const;

type ViewId = (typeof VIEWS)[number]["id"];

/**
 * Top-level shell + nav. No router dependency — this is a handful of
 * sibling views behind a sidebar, not a deep-linkable app; a plain state
 * switch is the whole "router" this needs.
 */
export function App() {
  const [view, setView] = useState<ViewId>("servers");
  const active = VIEWS.find((v) => v.id === view) ?? VIEWS[0];

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">
          <span className="logo">X</span>
          <strong>MCP Inspector X</strong>
        </div>
        <div className="topbar-spacer" />
      </header>

      <aside className="sidebar">
        <p className="eyebrow">Explore</p>
        {VIEWS.map((v) => (
          <button
            key={v.id}
            data-testid={`nav-${v.id}`}
            className={`nav ${v.id === view ? "active" : ""}`}
            onClick={() => setView(v.id)}
          >
            {v.label}
          </button>
        ))}
      </aside>

      <main className="workspace">
        <active.Component />
      </main>
    </div>
  );
}
