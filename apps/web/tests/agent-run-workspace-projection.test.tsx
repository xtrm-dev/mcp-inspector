/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentRunWorkspaceProjection } from "../src/components/AgentRunWorkspaceProjection";
import type { AgentRunTimeline as Data, ExecutionDetail, ServerSummary } from "../src/api/types";

let container: HTMLDivElement;
let root: Root;

const EXEC = {
  id: "e-1", serverId: "srv-1", capabilityId: "srv-1::tool::add",
  status: "complete",
  startedAt: "2026-08-28T10:00:00Z", endedAt: "2026-08-28T10:00:01Z",
  createdAt: "2026-08-28T10:00:00Z",
} as unknown as Data["executions"][number];

const TIMELINE: Data = {
  agentRun: {} as unknown as Data["agentRun"],
  executions: [EXEC],
  traces: [],
  overlay: [],
};

const DETAIL: ExecutionDetail = {
  execution: EXEC as ExecutionDetail["execution"],
  rounds: [
    {
      id: "r-1", executionId: "e-1", roundIndex: 0, kind: "call" as ExecutionDetail["rounds"][number]["kind"],
      argumentsJson: null,
      resultInlineJson: JSON.stringify({ answer: 42 }),
      resultArtifact: null, errorJson: null, durationMs: 1000,
      startedAt: "2026-08-28T10:00:00Z", endedAt: "2026-08-28T10:00:01Z",
    },
  ],
  evidence: [],
};

const SERVERS: { servers: ServerSummary[] } = {
  servers: [{
    id: "srv-1", displayName: "Local",
    transport: "streamable-http", endpoint: "http://x/mcp",
    protocolPolicy: "auto", disabled: false,
    createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
    connected: true, negotiation: null,
  }],
};

function stubFetch() {
  vi.stubGlobal("fetch", async (input: string | URL | Request) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(raw, "http://localhost");
    let body: unknown;
    if (url.pathname === "/api/v1/servers") body = SERVERS;
    else if (url.pathname.startsWith("/api/v1/agent-runs/")) body = TIMELINE;
    else if (url.pathname.startsWith("/api/v1/executions/")) body = DETAIL;
    else body = {};
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  });
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  stubFetch();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function flush() {
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

describe("AgentRunWorkspaceProjection — UX-6 slice 3", () => {
  it("renders the shared workspace grid with a capability card per execution", async () => {
    await act(async () => root.render(<AgentRunWorkspaceProjection agentRunId="r-1" />));
    await flush();
    expect(container.querySelector('[data-testid="agent-run-workspace"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="workspace-grid"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="capability-card-e-1"]')).toBeTruthy();
  });
});
